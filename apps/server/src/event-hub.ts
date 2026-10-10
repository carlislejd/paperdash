import type { Overview } from "../../../packages/shared/src/types.js";
import type { ServerResponse } from "node:http";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { readOverviewSnapshot } from "./collector.js";
import type { Store, StreamRecord } from "./store.js";
import type { ChangeBus } from "./bus.js";

export type StreamTopic =
  | "overview"
  | "trades"
  | "asset:0"
  | "asset:1"
  | "liquidations";
interface Frame {
  id: string;
  sequence: bigint;
  topic: StreamTopic;
  text: string;
  instrument?: number;
  liquidation?: boolean;
}
interface Client {
  response: ServerResponse;
  last: bigint;
  ready: boolean;
  topics?: ReadonlySet<StreamTopic>;
}
interface Bootstrap {
  at: number;
  overview: Overview;
  frames: Map<string, string>;
  sequence: bigint;
  records: Frame[];
}
function encode(record: StreamRecord): Frame {
  return {
    id: record.id,
    sequence: BigInt(record.id),
    topic:
      record.message.type === "trade"
        ? "trades"
        : record.message.type === "asset-price"
          ? (`asset:${record.message.data.instrument}` as StreamTopic)
          : "overview",
    ...(record.message.type === "trade"
      ? {
          instrument: record.message.data.instrument,
          liquidation: record.message.data.kind === "liq",
        }
      : {}),
    text: `id: ${record.id}\ndata: ${JSON.stringify(record.message)}\n\n`,
  };
}

/** One database tail and encoded replay buffer per process, independent of viewer count. */
export class EventHub {
  private clients = new Set<Client>();
  private cursor = 0n;
  private ringFloor = 0n;
  private ring: Frame[] = [];
  private pumping: Promise<void> | null = null;
  private again = false;
  private closed = false;
  private bootstrap: Bootstrap | null = null;
  private bootstrapping: Promise<Bootstrap> | null = null;
  private timer: ReturnType<typeof setInterval>;
  private heartbeat: ReturnType<typeof setInterval>;
  private unsubscribe: () => void;
  constructor(
    private store: Store,
    bus: ChangeBus,
    private options = { bootstrapTtl: 1000, maxBufferedBytes: 64 * 1024 },
  ) {
    this.timer = setInterval(() => {
      void this.pump();
    }, 1000);
    this.heartbeat = setInterval(() => {
      for (const client of this.clients)
        if (client.ready) this.write(client, ": heartbeat\n\n");
    }, 15000);
    this.timer.unref();
    this.heartbeat.unref();
    this.unsubscribe = bus.subscribe(() => {
      void this.pump();
    });
  }
  get size() {
    return this.clients.size;
  }
  private write(client: Client, text: string): boolean {
    const response = client.response;
    if (
      response.destroyed ||
      response.writableLength > this.options.maxBufferedBytes
    ) {
      if (!response.destroyed) response.destroy();
      this.clients.delete(client);
      return false;
    }
    response.write(text);
    return true;
  }
  private send(client: Client, frame: Frame, bootstrap = false) {
    if ((!client.ready && !bootstrap) || frame.sequence <= client.last) return;
    // Advance even across filtered records; replay cannot duplicate older deltas.
    client.last = frame.sequence;
    if (
      !client.topics ||
      client.topics.has(frame.topic) ||
      (frame.instrument !== undefined &&
        client.topics.has(`asset:${frame.instrument}` as StreamTopic)) ||
      (frame.liquidation && client.topics.has("liquidations"))
    )
      this.write(client, frame.text);
  }
  private async snapshot(): Promise<Bootstrap> {
    if (
      this.bootstrap &&
      Date.now() - this.bootstrap.at < this.options.bootstrapTtl
    )
      return this.bootstrap;
    if (this.bootstrapping) return this.bootstrapping;
    this.bootstrapping = (async () => {
      const { overview, cursor } = await readOverviewSnapshot(this.store);
      const bounds = await this.store.eventBounds();
      const gap =
        bounds.oldest !== null && BigInt(cursor) < BigInt(bounds.oldest) - 1n;
      const start = gap ? BigInt(bounds.oldest!) - 1n : BigInt(cursor);
      if (gap)
        overview.status = {
          ...overview.status,
          message: [
            overview.status.message,
            "Live notification replay expired; resuming from the saved snapshot.",
          ]
            .filter(Boolean)
            .join(" "),
        };
      const records: Frame[] = [];
      let sequence = start;
      // Durable replay is bounded to 1,000 retained events. Catch-up remains bounded
      // during a continuously busy source, and any later deltas come from the shared tail.
      for (let pass = 0; pass < 2; pass++) {
        const next = await this.store.events(String(sequence));
        records.push(...next.map(encode));
        if (next.length) sequence = BigInt(next.at(-1)!.id);
        if (next.length < 1000) break;
      }
      const result: Bootstrap = {
        at: Date.now(),
        overview,
        frames: new Map(),
        sequence: start,
        records,
      };
      this.bootstrap = result;
      return result;
    })().finally(() => {
      this.bootstrapping = null;
    });
    return this.bootstrapping;
  }
  async add(
    response: ServerResponse,
    _lastId?: string,
    topics?: ReadonlySet<StreamTopic>,
  ) {
    const client: Client = { response, last: 0n, ready: false, topics };
    if (this.closed) {
      response.end();
      return;
    }
    this.clients.add(client);
    response.once("close", () => this.clients.delete(client));
    try {
      await this.resync(client);
    } catch {
      if (!response.destroyed) {
        this.write(
          client,
          `data: ${JSON.stringify({ type: "status", data: { receivedAt: null, sourceAt: null, indexedBlock: null, stale: true, persistence: this.store.kind, stream: "disconnected", message: "Live updates are temporarily unavailable. Reconnecting." } })}\n\n`,
        );
        response.end();
      }
      this.clients.delete(client);
    }
  }
  private async resync(client: Client) {
    client.ready = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const snapshot = await this.snapshot();
      if (this.closed || client.response.destroyed) return;
      const last = snapshot.records.at(-1)?.sequence ?? snapshot.sequence;
      if (last < this.ringFloor) {
        this.bootstrap = null;
        continue;
      }
      client.last = snapshot.sequence;
      const key = client.topics ? [...client.topics].sort().join(",") : "all";
      let initial = snapshot.frames.get(key);
      if (!initial) {
        const overview =
          !client.topics || client.topics.has("trades")
            ? snapshot.overview
            : {
                ...snapshot.overview,
                trades: snapshot.overview.trades.filter(
                  (trade) =>
                    client.topics!.has(
                      `asset:${trade.instrument}` as StreamTopic,
                    ) ||
                    (trade.kind === "liq" &&
                      client.topics!.has("liquidations")),
                ),
              };
        initial = `id: ${snapshot.sequence}\ndata: ${JSON.stringify({ type: "overview", data: overview })}\n\n`;
        snapshot.frames.set(key, initial);
      }
      if (!this.write(client, initial)) return;
      for (const frame of snapshot.records) this.send(client, frame, true);
      for (const frame of this.ring) this.send(client, frame, true);
      // No await between replay and ready: a publication cannot fall through the gap.
      client.ready = true;
      return;
    }
    client.response.end();
  }
  private pump(): Promise<void> {
    if (this.closed || !this.clients.size) return Promise.resolve();
    if (this.pumping) {
      this.again = true;
      return this.pumping;
    }
    this.pumping = this.tail()
      .catch(() => {
        // REST and saved data stay available during a database or notification outage.
      })
      .finally(() => {
        this.pumping = null;
        if (this.again && !this.closed) {
          this.again = false;
          void this.pump();
        }
      });
    return this.pumping;
  }
  private async tail() {
    const bounds = await this.store.eventBounds();
    if (this.closed) return;
    if (bounds.oldest && this.cursor < BigInt(bounds.oldest) - 1n) {
      this.cursor = BigInt(bounds.latest!);
      this.ringFloor = this.cursor;
      this.ring = [];
      this.bootstrap = null;
      // One shared bootstrap promise; no reconnect-specific database reads.
      await Promise.all(
        [...this.clients].filter((c) => c.ready).map((c) => this.resync(c)),
      );
      return;
    }
    const records = (await this.store.events(String(this.cursor))).map(encode);
    for (const frame of records) {
      if (this.closed) return;
      this.ring.push(frame);
      if (this.ring.length > 1000) this.ringFloor = this.ring.shift()!.sequence;
      this.cursor = frame.sequence;
      let sent = 0;
      for (const client of this.clients) {
        this.send(client, frame);
        // Large fanout yields to socket drains, HTTP work, and shutdown signals.
        if (++sent % 500 === 0) await yieldImmediate();
      }
    }
    if (records.length === 1000) this.again = true;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    clearInterval(this.heartbeat);
    this.unsubscribe();
    for (const client of this.clients) client.response.end();
    this.clients.clear();
    this.ring = [];
    this.bootstrap = null;
  }
}
