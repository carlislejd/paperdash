import { Centrifuge } from "centrifuge";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { z } from "zod";
import type {
  Overview,
  ProtocolSummary,
  StreamMessage,
  TradeEvent,
} from "../../../packages/shared/src/types.js";
import { config, errorMessage } from "./config.js";
import {
  accountsSchema,
  digest,
  normalizeTrade,
  protocolHistorySchema,
  summarySchema,
} from "./schemas.js";
import { type Store, visibleTrades } from "./store.js";
import { canonicalPath, Upstream } from "./upstream.js";
import { ChangeBus } from "./bus.js";
import { HistoryIndexer } from "./history.js";

export function emptyOverview(kind: Store["kind"]): Overview {
  return {
    summary: null,
    accountCount: null,
    history: [],
    historyCoverage: "unavailable",
    trades: [],
    status: {
      receivedAt: null,
      sourceAt: null,
      indexedBlock: null,
      stale: true,
      persistence: kind,
      stream: "connecting",
      message: "Connecting to Papertrade. No observations available yet.",
    },
  };
}
export async function readOverview(store: Store): Promise<Overview> {
  return (await readOverviewSnapshot(store)).overview;
}
export async function retainProtocolHistory(
  store: Store,
  history: z.infer<typeof protocolHistorySchema>,
): Promise<void> {
  const previous = await store.get<{ source: typeof history.source }>(
    "protocol-history",
  );
  if (
    previous &&
    (history.source.asOfMs < previous.value.source.asOfMs ||
      (history.source.generation === previous.value.source.generation &&
        BigInt(history.source.revision) <
          BigInt(previous.value.source.revision)))
  )
    throw new Error(
      "Protocol history source moved backward; retaining saved samples.",
    );
  const points = history.columns.tvl.flatMap((value, i) =>
    value === null
      ? []
      : [{ time: history.startMs + i * history.intervalMs, value }],
  );
  await store.history.retainProtocol(points);
  await store.put("protocol-history", { points, source: history.source });
  await store.put("protocol-history-raw", history);
}
export async function readOverviewSnapshot(
  store: Store,
): Promise<{ overview: Overview; cursor: string }> {
  const saved = await store.get<Overview & { eventCursor?: string }>(
    "overview",
  );
  if (!saved) return { overview: emptyOverview(store.kind), cursor: "0" };
  const { eventCursor, ...value } = saved.value;
  const age = Date.now() - (value.status.receivedAt ?? 0);
  const sourceAge = Date.now() - (value.status.sourceAt ?? 0);
  const stale = age > 15000 || sourceAge > 30000 || value.status.stale;
  return {
    cursor: eventCursor ?? "0",
    overview: {
      ...value,
      status: {
        ...value.status,
        stale,
        ...(age > 15000
          ? {
              stream: "disconnected" as const,
              message:
                value.status.message ??
                "Collector has not published a fresh observation.",
            }
          : {}),
      },
    },
  };
}

/** Keep endpoints and per-bucket extremes; raw source history stays in storage. */
export function downsample(
  points: Overview["history"],
  limit = 300,
): Overview["history"] {
  if (points.length <= limit) return points;
  const buckets = Math.floor((limit - 2) / 2);
  const result = [points[0]];
  for (let i = 0; i < buckets; i++) {
    const from = 1 + Math.floor((i * (points.length - 2)) / buckets),
      to = 1 + Math.floor(((i + 1) * (points.length - 2)) / buckets);
    let low = from,
      high = from;
    for (let j = from + 1; j < to; j++) {
      if (points[j].value < points[low].value) low = j;
      if (points[j].value > points[high].value) high = j;
    }
    for (const index of [...new Set([low, high])].sort((a, b) => a - b))
      result.push(points[index]);
  }
  result.push(points.at(-1)!);
  return result;
}

export class Collector {
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private tasks = new Set<Promise<unknown>>();
  private stopped = false;
  private client: Centrifuge | null = null;
  private release: (() => Promise<void>) | null = null;
  private stream: Overview["status"]["stream"] = "connecting";
  private errors = new Map<string, string>();
  private chain: Promise<void> = Promise.resolve();
  private ingestion: Promise<void> = Promise.resolve();
  private metricsSignature = "";
  private historySignature = "";
  constructor(
    private store: Store,
    private upstream: Upstream,
    private bus: ChangeBus,
  ) {}
  async start(): Promise<boolean> {
    this.release = await this.store.lease();
    if (!this.release) return false;
    this.loop("summary", config.summaryInterval, async () => {
      const summary = await this.upstream.request(
        "/query/protocol/summary",
        summarySchema,
      );
      const previous = await this.store.get<ProtocolSummary>("summary");
      if (
        previous &&
        BigInt(summary.source.block) < BigInt(previous.value.source.block)
      )
        throw new Error(
          "Upstream protocol summary moved backward; retaining the newer observation.",
        );
      await this.store.put("summary", summary);
      await this.store.sample(
        Math.floor(summary.source.at / 60000) * 60000,
        Number(BigInt(summary.balances.tvl)) / 1e18,
      );
    });
    this.loop("directory", config.directoryInterval, async () => {
      const path = canonicalPath("/state/leaderboard/accounts", {
        window: "all",
        sortKey: "currentBalance",
        sortDir: "desc",
        page: 0,
        pageSize: 25,
      });
      const accounts = await this.upstream.request(path, accountsSchema);
      await this.store.put("account-count", accounts.summary.uniqueAccounts);
      await this.store.put(`cache:${path}`, accounts);
      await this.store.history.discoverWallets(
        accounts.accounts.map((account) => account.address),
      );
    });
    this.loop("directory-sweep", config.directoryInterval, async () => {
      const savedPage = await this.store.get<number>("directory-scan-page");
      const page =
        Number.isSafeInteger(savedPage?.value) && savedPage!.value >= 1
          ? savedPage!.value
          : 1;
      const path = canonicalPath("/state/leaderboard/accounts", {
        window: "all",
        sortKey: "currentBalance",
        sortDir: "desc",
        page,
        pageSize: 25,
      });
      const accounts = await this.upstream.request(path, accountsSchema);
      await this.store.put("account-count", accounts.summary.uniqueAccounts);
      await this.store.put(`cache:${path}`, accounts);
      await this.store.history.discoverWallets(
        accounts.accounts.map((account) => account.address),
      );
      // Directory ordering can move during a sweep; repeat bounded sweeps and
      // also discover active wallets from the trade stream. This is not an
      // assertion that a mutable paginated directory has perfect coverage.
      await this.store.put(
        "directory-scan-page",
        page + 1 < accounts.pageInfo.totalPages ? page + 1 : 1,
      );
    });
    this.loop("history", config.historyInterval, async () => {
      const h = await this.upstream.request(
        "/query/protocol/history?interval=1m",
        protocolHistorySchema,
      );
      await retainProtocolHistory(this.store, h);
    });
    const historyIndexer = new HistoryIndexer(
      this.store.history,
      (path, schema) => this.upstream.request(path, schema),
    );
    this.loop("wallet-indexer", config.walletIndexInterval, async () => {
      await historyIndexer.tick({ maxRequests: config.walletIndexRequests });
    });
    this.loop("indexing-status", 30000, async () => {
      await this.store.put("indexing-status", await this.store.history.stats());
    });
    this.loop("recent", config.recentInterval, async () => {
      const r = await this.upstream.request(
        "/query/protocol/trades/recent",
        z.object({ ok: z.literal(true), events: z.array(z.unknown()).max(50) }),
      );
      for (const item of [...r.events].reverse())
        await this.accept(normalizeTrade(item, "recent-api"));
    });
    this.client = new Centrifuge(config.streamUrl, {
      websocket: WebSocket as unknown as typeof globalThis.WebSocket,
      minReconnectDelay: 1000,
      maxReconnectDelay: 15000,
      timeout: 10000,
    });
    this.client.on("error", () => {
      this.errors.set("stream", "Public trade stream temporarily unavailable.");
    });
    this.client.on("disconnected", () => {
      this.stream = "disconnected";
      void this.publish().catch(() => {});
    });
    this.client.on("connecting", () => {
      this.stream = "connecting";
    });
    const subscription = this.client.newSubscription("public:trades");
    subscription.on("subscribed", (context) => {
      if (context.recoverable || context.wasRecovering) {
        this.errors.set("stream", "Unexpected trade stream recovery contract.");
        subscription.unsubscribe();
        return;
      }
      this.stream = "connected";
      this.errors.delete("stream");
      void this.publish().catch(() => {});
    });
    subscription.on("subscribing", () => {
      this.stream = "connecting";
    });
    subscription.on("error", () => {
      this.stream = "disconnected";
      this.errors.set("stream", "Trade stream subscription is unavailable.");
    });
    subscription.on("publication", (context) => {
      const task = (async () => {
        const batch = z.array(z.unknown()).min(1).max(20).parse(context.data);
        for (const item of batch)
          await this.accept(
            normalizeTrade(item, "public-stream", randomUUID()),
          );
        await this.publish();
      })().catch((error) => {
        this.errors.set("stream", errorMessage(error));
        console.error("Trade collection:", errorMessage(error));
      });
      this.track(task);
    });
    subscription.subscribe();
    this.client.connect();
    return true;
  }
  private track(task: Promise<unknown>) {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
  }
  private loop(name: string, interval: number, work: () => Promise<void>) {
    let retryAt = 0;
    const rememberDeadline = (error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "retryAt" in error &&
        typeof error.retryAt === "number" &&
        Number.isFinite(error.retryAt)
      )
        retryAt = Math.max(retryAt, error.retryAt);
    };
    const schedule = (delay: number) => {
      if (this.stopped) return;
      const timer = setTimeout(
        () => {
          this.timers.delete(timer);
          this.track(tick());
        },
        Math.min(delay, 2147483647),
      );
      this.timers.add(timer);
    };
    const tick = async () => {
      if (this.stopped) return;
      // A long Retry-After can exceed Node's maximum timer duration. Recheck
      // the absolute deadline rather than letting an overflow retry early.
      if (retryAt > Date.now()) {
        schedule(retryAt - Date.now());
        return;
      }
      let failed = false;
      try {
        await work();
        this.errors.delete(name);
        retryAt = 0;
      } catch (error) {
        failed = true;
        rememberDeadline(error);
        this.errors.set(name, errorMessage(error));
        console.error(`Collector ${name}:`, errorMessage(error));
      }
      try {
        await this.store.put("collector-heartbeat", {
          at: Date.now(),
          errors: Object.fromEntries(this.errors),
        });
        await this.publish();
      } catch (error) {
        failed = true;
        rememberDeadline(error);
        console.error("Collector persistence:", errorMessage(error));
      }
      schedule(
        failed
          ? Math.max(Math.min(interval, 30000), retryAt - Date.now())
          : interval,
      );
    };
    this.track(tick());
  }
  private async emit(message: StreamMessage) {
    await this.store.event(message);
    this.bus.notify();
  }
  private accept(trade: TradeEvent) {
    const task = this.ingestion.then(async () => {
      if (await this.store.recordTrade(trade)) {
        await this.store.history.ensureWallet(trade.wallet, 20);
        this.bus.notify();
      }
    });
    this.ingestion = task.catch(() => {});
    return task;
  }
  private publish(): Promise<void> {
    const run = this.chain.then(async () => {
      if (this.stopped) return;
      // Any financial notification at or below this cursor committed before all
      // following reads, so a client can replay strictly after this watermark.
      const eventCursor = (await this.store.eventBounds()).latest ?? "0";
      const [summary, accountCount, upstreamPoints, observed, trades] =
        await Promise.all([
          this.store.get<ProtocolSummary>("summary"),
          this.store.get<number>("account-count"),
          this.store.history.protocolPoints(),
          this.store.samples(),
          this.store.trades(100),
        ]);
      const points = new Map(
        upstreamPoints.map((point) => [point.time, point]),
      );
      const sourceTail = upstreamPoints.at(-1)?.time ?? 0;
      // Keep the retained historical baseline while appending minute samples
      // observed since it. Hourly reconciliation no longer erases the chart
      // after a three-minute freshness timer.
      for (const point of observed)
        if (point.time >= sourceTail || !points.has(point.time))
          points.set(point.time, point);
      const history = [...points.values()]
        .sort((a, b) => a.time - b.time)
        .slice(-1440);
      const overview: Overview = {
        summary: summary?.value ?? null,
        accountCount: accountCount?.value ?? null,
        history: downsample(history),
        historyCoverage: upstreamPoints.length
          ? "upstream"
          : observed.length
            ? "observed"
            : "unavailable",
        trades: visibleTrades(trades),
        status: {
          receivedAt: summary?.receivedAt ?? null,
          sourceAt: summary?.value.source.at ?? null,
          indexedBlock: summary?.value.source.block ?? null,
          stale:
            !summary ||
            Date.now() - summary.receivedAt > 15000 ||
            Date.now() - summary.value.source.at > 30000,
          persistence: this.store.kind,
          stream: this.stream,
          ...(this.errors.size
            ? {
                message: [...this.errors]
                  .map(([name, error]) => `${name}: ${error}`)
                  .join(" "),
              }
            : {}),
        },
      };
      await this.store.put("overview", { ...overview, eventCursor });
      const metrics = {
        summary: overview.summary,
        accountCount: overview.accountCount,
        status: overview.status,
      };
      const metricsSignature = digest({
        ...metrics,
        status: { ...metrics.status, receivedAt: undefined },
      });
      if (metricsSignature !== this.metricsSignature) {
        await this.emit({ type: "metrics", data: metrics });
        this.metricsSignature = metricsSignature;
      }
      const historyData = {
        history: overview.history,
        historyCoverage: overview.historyCoverage,
      };
      const historySignature = digest(historyData);
      if (historySignature !== this.historySignature) {
        await this.emit({ type: "history", data: historyData });
        this.historySignature = historySignature;
      }
    });
    this.chain = run.catch(() => {});
    return run;
  }
  async stop() {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.client?.disconnect();
    await Promise.allSettled([...this.tasks]);
    await this.ingestion;
    await this.chain;
    await this.release?.();
    this.release = null;
  }
}
