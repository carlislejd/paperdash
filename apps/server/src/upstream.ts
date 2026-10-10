import { z } from "zod";
import type {
  AccountsResponse,
  Cashflow,
  ClosedTrade,
  HistoryPage,
  PortfolioHistory,
  WalletResponse,
  WalletSnapshot,
} from "../../../packages/shared/src/types.js";
import { config, errorMessage } from "./config.js";
import {
  accountsSchema,
  addressSchema,
  cashflowSchema,
  closedTradeSchema,
  historySchema,
  portfolioSchema,
  walletSchema,
} from "./schemas.js";
import type { Store } from "./store.js";

export class UpstreamError extends Error {
  constructor(
    message: string,
    public status = 502,
    public retryAt = 0,
  ) {
    super(message);
  }
}
export function canonicalPath(
  path: string,
  params: Record<string, string | number | undefined> = {},
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== "") query.set(key, String(value));
  query.sort();
  return `${path}${query.size ? `?${query}` : ""}`;
}
export function retryAfter(value: string | null, now = Date.now()): number {
  if (!value) return now + 5000;
  const at = /^\d+$/.test(value.trim())
    ? now + Number(value) * 1000
    : Date.parse(value);
  return Number.isFinite(at) ? Math.max(now, at) : now + 5000;
}
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RequestGate {
  private active = 0;
  private queue: { run: () => void; reject: (e: Error) => void }[] = [];
  private nextAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  cooldown = 0;
  constructor(
    private concurrency = 3,
    private spacing = 250,
    private maxQueue = 48,
  ) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (Date.now() < this.cooldown)
      throw new UpstreamError(
        "Papertrade rate limit; retry later.",
        429,
        this.cooldown,
      );
    if (this.queue.length >= this.maxQueue)
      throw new UpstreamError("Upstream request queue is full.", 503);
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        reject,
        run: () => {
          this.active++;
          fn()
            .then(resolve, reject)
            .finally(() => {
              this.active--;
              this.drain();
            });
        },
      });
      this.drain();
    });
  }
  private drain() {
    if (this.timer || this.active >= this.concurrency || !this.queue.length)
      return;
    if (Date.now() < this.cooldown) {
      for (const q of this.queue.splice(0))
        q.reject(
          new UpstreamError(
            "Papertrade rate limit; retry later.",
            429,
            this.cooldown,
          ),
        );
      return;
    }
    const wait = this.nextAt - Date.now();
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.drain();
      }, wait);
      return;
    }
    this.nextAt = Date.now() + this.spacing;
    this.queue.shift()!.run();
    this.drain();
  }
}

export interface Cached<T> {
  value: T;
  receivedAt: number;
  stale: boolean;
  error?: string;
}
export class Upstream {
  readonly gate: RequestGate;
  private inflight = new Map<string, Promise<Cached<unknown>>>();
  private failures = new Map<string, { until: number; message: string }>();
  private memory = new Map<string, Cached<unknown>>();
  constructor(
    readonly store: Store,
    private fetcher: typeof fetch = fetch,
    private origin = config.upstream,
    gate?: RequestGate,
  ) {
    this.gate = gate ?? new RequestGate();
  }

  async request<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new Error("Only upstream relative paths are allowed");
    return this.gate.run(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await this.fetcher(new URL(path, this.origin), {
            headers: { Accept: "application/json" },
            redirect: "error",
            signal: AbortSignal.timeout(10000),
          });
          if (response.status === 429) {
            this.gate.cooldown = retryAfter(
              response.headers.get("Retry-After"),
            );
            throw new UpstreamError(
              "Papertrade rate limit; serving saved observations when available.",
              429,
              this.gate.cooldown,
            );
          }
          if (!response.ok) {
            await response.body?.cancel();
            throw new UpstreamError(
              `Papertrade returned HTTP ${response.status}.`,
              response.status,
            );
          }
          const body = await boundedText(response, 4 * 1024 * 1024);
          const parsed = schema.safeParse(JSON.parse(body));
          if (!parsed.success)
            throw new UpstreamError(
              `Papertrade response schema changed (${parsed.error.issues[0]?.path.join(".") || "root"}).`,
            );
          return parsed.data;
        } catch (error) {
          const retryable =
            error instanceof TypeError ||
            (error instanceof UpstreamError &&
              error.status >= 500 &&
              error.status !== 502);
          if (attempt >= 1 || !retryable) throw error;
          await sleep(300);
        }
      }
    });
  }

  async cached<T>(
    key: string,
    ttl: number,
    loader: () => Promise<T>,
    options: { wait?: boolean; staleAfter?: number } = {},
  ): Promise<Cached<T>> {
    let saved = this.memory.get(key) as Cached<T> | undefined;
    if (!saved) {
      const row = await this.store.get<T>(`cache:${key}`);
      if (row) saved = { ...row, stale: Date.now() - row.receivedAt > ttl };
    }
    const failure = this.failures.get(key);
    if (saved && Date.now() - saved.receivedAt <= ttl)
      return { ...saved, stale: false };
    if (failure && Date.now() < failure.until) {
      if (saved) return { ...saved, stale: true, error: failure.message };
      throw new UpstreamError(failure.message, 503, failure.until);
    }
    let promise = this.inflight.get(key) as Promise<Cached<T>> | undefined;
    if (!promise) {
      promise = (async () => {
        const value = await loader();
        const result = { value, receivedAt: Date.now(), stale: false };
        await this.store.put(`cache:${key}`, value, result.receivedAt);
        this.memory.delete(key);
        this.memory.set(key, result);
        if (this.memory.size > 500)
          this.memory.delete(this.memory.keys().next().value!);
        this.failures.delete(key);
        return result;
      })()
        .catch((error) => {
          this.failures.set(key, {
            until: Math.max(Date.now() + 5000, this.gate.cooldown),
            message: errorMessage(error),
          });
          if (this.failures.size > 1000)
            this.failures.delete(this.failures.keys().next().value!);
          throw error;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, promise as Promise<Cached<unknown>>);
    }
    if (saved && !options.wait) {
      void promise.catch(() => {});
      return {
        ...saved,
        stale:
          Date.now() - saved.receivedAt >
          (options.staleAfter ?? Math.max(ttl * 3, 30000)),
        ...(failure ? { error: failure.message } : {}),
      };
    }
    try {
      return await promise;
    } catch (error) {
      if (saved) return { ...saved, stale: true, error: errorMessage(error) };
      throw error;
    }
  }

  async accounts(
    q = "",
    sort = "currentBalance",
    page = 0,
  ): Promise<AccountsResponse> {
    const path = canonicalPath("/state/leaderboard/accounts", {
      window: "all",
      sortKey: sort,
      sortDir: "desc",
      page,
      pageSize: 25,
      q,
    });
    const r = await this.cached(path, 15000, () =>
      this.request(path, accountsSchema),
    );
    return {
      ...r.value,
      receivedAt: r.receivedAt,
      stale: r.stale,
      ...(r.error ? { error: r.error } : {}),
    };
  }
  async history<T extends Cashflow | ClosedTrade>(
    address: string,
    kind: "cashflows" | "trades",
    cursor?: string,
  ): Promise<Cached<HistoryPage<T>>> {
    const parsed = addressSchema.parse(address);
    const path = canonicalPath(`/query/accounts/${parsed}/${kind}`, {
      cursor,
      limit: 75,
      ...(kind === "trades" ? { filter: "all" } : {}),
    });
    const schema = historySchema(
      kind === "cashflows" ? cashflowSchema : closedTradeSchema,
    );
    return this.cached(path, cursor ? 3600000 : 15000, async () => {
      const result = await this.request(path, schema);
      if (cursor && result.nextCursor === cursor)
        throw new UpstreamError("Upstream history returned a repeated cursor.");
      return result as HistoryPage<T>;
    });
  }
  async snapshot(address: string): Promise<Cached<WalletSnapshot>> {
    address = addressSchema.parse(address);
    return this.cached(`wallet:${address}`, 5000, () =>
      this.gate.run(async () => {
        const controller = new AbortController();
        try {
          const response = await this.fetcher(
            new URL(
              canonicalPath("/state/user/live", { wallet: address }),
              this.origin,
            ),
            {
              headers: { Accept: "text/event-stream" },
              signal: AbortSignal.any([
                controller.signal,
                AbortSignal.timeout(12000),
              ]),
              redirect: "error",
            },
          );
          if (response.status === 429) {
            this.gate.cooldown = retryAfter(
              response.headers.get("Retry-After"),
            );
            throw new UpstreamError(
              "Wallet stream rate limited.",
              429,
              this.gate.cooldown,
            );
          }
          if (!response.ok || !response.body)
            throw new UpstreamError(
              `Wallet stream returned HTTP ${response.status}.`,
              response.status,
            );
          const value = await firstWalletEvent(response.body, address);
          return value;
        } finally {
          controller.abort();
        }
      }),
    );
  }
  async wallet(address: string): Promise<WalletResponse> {
    address = addressSchema.parse(address);
    const path = canonicalPath(`/query/accounts/${address}/portfolio-history`, {
      range: "all",
    });
    const results = await Promise.allSettled([
      this.snapshot(address),
      this.history<Cashflow>(address, "cashflows"),
      this.history<ClosedTrade>(address, "trades"),
      this.cached(path, 30000, () => this.request(path, portfolioSchema)),
    ] as const);
    const errors: string[] = [];
    const labels = ["Live account", "Cashflows", "Closed trades", "Portfolio"];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "rejected")
        errors.push(`${labels[i]}: ${errorMessage(r.reason)}`);
      else if (r.value.error) errors.push(`${labels[i]}: ${r.value.error}`);
    }
    const [snapshot, cashflows, trades, portfolio] = results;
    const times = results.flatMap((r) =>
      r.status === "fulfilled" ? [r.value.receivedAt] : [],
    );
    return {
      address,
      snapshot: snapshot.status === "fulfilled" ? snapshot.value.value : null,
      cashflows:
        cashflows.status === "fulfilled"
          ? cashflows.value.value
          : { items: [], nextCursor: null },
      trades:
        trades.status === "fulfilled"
          ? trades.value.value
          : { items: [], nextCursor: null },
      portfolio:
        portfolio.status === "fulfilled"
          ? (portfolio.value.value as PortfolioHistory)
          : null,
      receivedAt: times.length ? Math.min(...times) : Date.now(),
      stale:
        results.some((r) => r.status === "rejected" || r.value.stale) ||
        (snapshot.status === "fulfilled" &&
          Date.now() - snapshot.value.value.indexedThroughTimestamp * 1000 >
            30000),
      errors,
    };
  }
}

async function boundedText(response: Response, max: number): Promise<string> {
  if (!response.body) throw new UpstreamError("Empty upstream response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max)
        throw new UpstreamError("Upstream response exceeds size limit.");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function firstWalletEvent(
  body: ReadableStream<Uint8Array>,
  address: string,
): Promise<WalletSnapshot> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done)
        throw new UpstreamError("Wallet stream ended before its snapshot.");
      bytes += value.length;
      if (bytes > 2 * 1024 * 1024)
        throw new UpstreamError("Wallet stream exceeds bootstrap limit.");
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(
        /\r\n/g,
        "\n",
      );
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = frame.split("\n");
        const event = lines
          .find((l) => l.startsWith("event:"))
          ?.slice(6)
          .trim();
        if (event !== "wallet") continue;
        const raw: unknown = JSON.parse(
          lines
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n"),
        );
        if (raw && typeof raw === "object" && "baseAccountRevision" in raw)
          continue;
        const parsed = walletSchema.parse(raw);
        if (parsed.address !== address.toLowerCase())
          throw new UpstreamError(
            "Wallet stream returned a different account.",
          );
        return parsed;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
