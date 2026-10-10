import WebSocket from "ws";
import { z } from "zod";
import type { MarketQuote } from "./market-store.js";

const side = z
  .object({
    px: z
      .string()
      .max(80)
      .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/),
  })
  .nullable();
const bbo = z.object({
  coin: z.enum(["BTC", "ETH"]),
  time: z.number().int().nonnegative().safe(),
  bbo: z.tuple([side, side]),
});
/** Hyperliquid BBO changes are USD quotes, not Papertrade execution prices. */
export function decodeMarketQuote(
  input: unknown,
  receivedAt = Date.now(),
): MarketQuote | null {
  if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) return null;
  const result = bbo.safeParse(input);
  if (!result.success) return null;
  const value = result.data,
    bid = Number(value.bbo[0]?.px),
    ask = Number(value.bbo[1]?.px);
  if (
    !Number.isFinite(bid) ||
    !Number.isFinite(ask) ||
    bid <= 0 ||
    ask < bid ||
    value.time > receivedAt + 30000
  )
    return null;
  const priceUsd = bid + (ask - bid) / 2;
  if (!Number.isFinite(priceUsd)) return null;
  return {
    instrument: value.coin === "BTC" ? 0 : 1,
    priceUsd,
    sourceAt: value.time,
    receivedAt,
  };
}
export interface MarketConnection {
  connected: boolean;
  at: number;
  reason?: string;
}
type SocketFactory = (url: string) => WebSocket;

/** One shared socket, two subscriptions, latest-only buffers and bounded retry.
 * Quiet unchanged markets do not create points or imply a broken transport. */
export class MarketFeed {
  private socket: WebSocket | null = null;
  private stopped = true;
  private refused = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private pulse: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private attempt = 0;
  private retryAt = 0;
  private persistenceFailed = new Set<number>();
  private lastMessageAt = 0;
  private pending = new Map<number, MarketQuote>();
  private lastSource = new Map<number, number>();
  private flushing: Promise<void> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private stopTask: Promise<void> | null = null;
  constructor(
    private onQuote: (quote: MarketQuote) => Promise<void>,
    private onConnection: (connection: MarketConnection) => Promise<void>,
    private factory: SocketFactory = (url) =>
      new WebSocket(url, { handshakeTimeout: 10000, maxPayload: 65536 }),
  ) {}
  start() {
    if (!this.stopped || this.stopTask) return;
    this.stopped = false;
    this.flushTimer = setInterval(() => this.flush(), 1000);
    this.flushTimer.unref();
    this.connect();
  }
  private enqueue(work: () => Promise<void>) {
    const task = this.chain.then(work);
    this.chain = task.catch(() => {});
    return task;
  }
  private status(connected: boolean, reason?: string) {
    if (this.stopped) return;
    const state = { connected, at: Date.now(), ...(reason ? { reason } : {}) };
    void this.enqueue(() => this.onConnection(state)).catch(() => {});
  }
  private connect() {
    if (this.stopped || this.refused) return;
    this.status(false, "Connecting to market quotes.");
    let socket: WebSocket;
    try {
      socket = this.factory("wss://api.hyperliquid.xyz/ws");
    } catch {
      this.status(false, "Market quote connection failed.");
      this.schedule();
      return;
    }
    this.socket = socket;
    const seen = new Set<number>();
    const current = () => !this.stopped && this.socket === socket;
    socket.on("open", () => {
      if (!current()) return;
      this.lastMessageAt = Date.now();
      for (const coin of ["BTC", "ETH"])
        socket.send(
          JSON.stringify({
            method: "subscribe",
            subscription: { type: "bbo", coin },
          }),
        );
      this.status(true);
      this.pulse = setInterval(() => {
        if (!current()) return;
        if (Date.now() - this.lastMessageAt > 60000) {
          this.status(false, "Market quote connection timed out.");
          socket.terminate();
        } else if (socket.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ method: "ping" }));
      }, 25000);
      this.pulse.unref();
    });
    socket.on("message", (raw) => {
      if (!current()) return;
      this.lastMessageAt = Date.now();
      let frame: { channel?: unknown; data?: unknown };
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object") return;
      if (frame.channel === "error") {
        this.refused = true;
        this.pending.clear();
        this.status(false, "Market quote subscription was refused.");
        socket.terminate();
        return;
      }
      if (frame.channel !== "bbo") return;
      const quote = decodeMarketQuote(frame.data);
      if (
        !quote ||
        quote.sourceAt <= (this.lastSource.get(quote.instrument) ?? -1)
      )
        return;
      this.attempt = 0;
      this.lastSource.set(quote.instrument, quote.sourceAt);
      if (
        !seen.has(quote.instrument) ||
        this.pending.get(quote.instrument)?.gapBefore
      )
        quote.gapBefore = true;
      seen.add(quote.instrument);
      this.pending.set(quote.instrument, quote);
    });
    socket.on("unexpected-response", (_request, response) => {
      if (!current()) return;
      // A protocol/access refusal is not something reconnecting can repair.
      this.refused =
        response.statusCode !== 429 && (response.statusCode ?? 500) < 500;
      const header = response.headers["retry-after"];
      if (typeof header === "string") {
        const deadline = /^\d+$/.test(header.trim())
          ? Date.now() + Number(header) * 1000
          : Date.parse(header);
        if (Number.isFinite(deadline))
          this.retryAt = Math.max(this.retryAt, deadline);
      }
      this.status(
        false,
        this.refused
          ? "Market quote connection was refused."
          : "Market quote connection is temporarily unavailable.",
      );
      response.resume();
      socket.terminate();
    });
    socket.on("error", () => {
      if (current()) this.status(false, "Market quote connection failed.");
    });
    socket.on("close", (code) => {
      if (!current()) return;
      if (this.pulse) clearInterval(this.pulse);
      this.pulse = null;
      this.socket = null;
      this.pending.clear();
      if ([1002, 1003, 1007, 1008, 1009].includes(code)) this.refused = true;
      this.status(
        false,
        this.refused
          ? "Market quote connection was refused."
          : "Market quote connection is reconnecting.",
      );
      this.schedule();
    });
  }
  private schedule() {
    if (this.stopped || this.refused || this.retry) return;
    const delay = Math.min(
      2147483647,
      Math.max(
        this.retryAt - Date.now(),
        Math.min(60000, 2000 * 2 ** Math.min(this.attempt++, 5)),
      ),
    );
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, delay);
    this.retry.unref();
  }
  private flush() {
    if (this.stopped || this.flushing || !this.pending.size) return;
    const quotes = [...this.pending.values()];
    this.pending.clear();
    this.flushing = this.enqueue(async () => {
      for (const quote of quotes) {
        if (this.stopped) break;
        try {
          await this.onQuote(quote);
          const recovered = this.persistenceFailed.delete(quote.instrument);
          if (
            recovered &&
            !this.persistenceFailed.size &&
            !this.stopped &&
            !this.refused &&
            this.socket?.readyState === WebSocket.OPEN
          ) {
            this.status(true);
          }
        } catch {
          // Keep one latest observation to retry after transient persistence
          // failure. Never invent a new source/receipt timestamp while retrying.
          if (!this.stopped) {
            const pending = this.pending.get(quote.instrument);
            if (!pending || pending.sourceAt < quote.sourceAt)
              this.pending.set(quote.instrument, quote);
            else if (quote.gapBefore) pending.gapBefore = true;
          }
          this.persistenceFailed.add(quote.instrument);
          await this.onConnection({
            connected: false,
            at: Date.now(),
            reason: "Market quote persistence is delayed.",
          });
        }
      }
    })
      .catch(() => {})
      .finally(() => {
        this.flushing = null;
      });
  }
  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.pulse) clearInterval(this.pulse);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.pending.clear();
    this.socket?.terminate();
    this.socket = null;
    this.stopTask = this.chain.then(() => {});
    return this.stopTask;
  }
}
