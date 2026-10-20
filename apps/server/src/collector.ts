import { Centrifuge, type Subscription } from "centrifuge";
import WebSocket from "ws";
import { z } from "zod";
import type {
  Overview,
  ProtocolSummary,
  StreamMessage,
} from "../../../packages/shared/src/types.js";
import { refreshWatchedWallet } from "./following.js";
import { refreshDirectoryHead } from "./directory-refresh.js";
import { ACTIVE_PROFIT_REFRESH_INTERVAL_MS, refreshActiveTraderProfits } from "./active-profit-refresh.js";
import { config, errorMessage } from "./config.js";
import {
  accountsSchema,
  digest,
  protocolHistorySchema,
  summarySchema,
} from "./schemas.js";
import { type Store, visibleTrades } from "./store.js";
import { canonicalPath, Upstream } from "./upstream.js";
import { ChangeBus } from "./bus.js";
import { HistoryIndexer } from "./history.js";
import {
  houseSchema,
  retainAssetSource,
  refreshAssetAnalytics,
} from "./assets.js";
import { MarketFeed } from "./market-feed.js";
import { refreshMarkets } from "./market.js";
import { retainHouseSource, refreshHouse } from "./house.js";
import { refreshLiquidations } from "./liquidations.js";
import { readLiveTvl } from "../../../packages/shared/src/live-tvl.js";
import { TradeIntake, type IntakeState } from "./trade-intake.js";
import { PanelPublisher, type PanelPublication } from "./panel-revisions.js";
import { refreshStakerYield } from "./staking-yield.js";
import {
  retainProtocolChartHistory,
  retainProtocolChartSummary,
  refreshProtocolCharts,
} from "./protocol-charts.js";

export interface StreamDiagnostics {
  at: number;
  event: string;
  clientState: string;
  subscriptionState: string;
  code: number | null;
  reason: string;
  lastSubscribedAt: number | null;
}

// Reasons are untrusted transport text. Keep diagnostics useful without logging
// control characters, credentials embedded in a message, or whole SDK contexts.
function streamReason(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .slice(0, 2000)
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g,
      " ",
    )
    .replace(/\bBearer\s+[a-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+/gi, "[redacted]")
    .replace(
      /(\b(?:token|secret|password|api[_-]?key|session[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^"'\s,;&]+/gi,
      "$1[redacted]",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

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
  const previous = await store.get<{
    source: typeof history.source;
    intervalMs?: number;
  }>("protocol-history");
  let previousInterval = previous?.value.intervalMs;
  if (previous && previousInterval === undefined) {
    // Older metadata omitted the interval. Only trust the saved raw response
    // when it describes exactly that publication: a prior interrupted write
    // can leave these two snapshots at different revisions.
    const raw = await store.get<z.infer<typeof protocolHistorySchema>>(
      "protocol-history-raw",
    );
    if (
      raw?.value.source.asOfMs === previous.value.source.asOfMs &&
      raw.value.source.generation === previous.value.source.generation &&
      raw.value.source.revision === previous.value.source.revision
    )
      previousInterval = raw.value.intervalMs;
  }
  if (
    previous &&
    (history.source.asOfMs < previous.value.source.asOfMs ||
      (history.intervalMs === previousInterval &&
        history.source.generation === previous.value.source.generation &&
        BigInt(history.source.revision) <
          BigInt(previous.value.source.revision)))
  )
    throw new Error(
      "Protocol history source moved backward; retaining saved samples.",
    );
  const points = history.columns.tvl.flatMap((value, i) => {
    const start = history.startMs + i * history.intervalMs;
    if (value === null || start > history.source.asOfMs) return [];
    // Hourly snapshots hold closing values. Use the closing minute's key,
    // matching retained minute history and live summary samples, rather than
    // overwriting minute zero with a value from up to an hour later. Clip an
    // unfinished hour to its observed minute so live samples still win ties.
    const time =
      history.intervalMs === 3600000
        ? Math.floor(
            Math.min(start + history.intervalMs - 1, history.source.asOfMs) /
              60000,
          ) * 60000
        : start;
    return [{ time, value }];
  });
  await store.history.retainProtocol(points);
  await store.put("protocol-history", {
    points,
    source: history.source,
    intervalMs: history.intervalMs,
  });
  await store.put("protocol-history-raw", history);
  await retainProtocolChartHistory(store, history);
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

export function protocolHistoryDigest(
  history: Pick<Overview, "history" | "historyCoverage">,
  summary: Overview["summary"],
): string {
  const live = readLiveTvl(summary);
  const tail = history.history.at(-1);
  if (
    !live ||
    tail?.time !== live.point.time ||
    tail.value !== live.point.value
  )
    return digest(history);
  // Every metrics frame already carries this exact active-minute value. Keep
  // every historical value, timestamp, length and coverage change significant.
  return digest({
    ...history,
    activeTailFromSummary: true,
    history: [...history.history.slice(0, -1), { ...tail, value: null }],
  });
}

export class Collector {
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private tasks = new Set<Promise<unknown>>();
  private stopped = false;
  private client: Centrifuge | null = null;
  private subscription: Subscription | null = null;
  private streamSafetyBlocked = false;
  private lastSubscribedAt: number | null = null;
  private statusPersistence: Promise<void> = Promise.resolve();
  private heartbeatAt = -Infinity;
  private heartbeatSignature = "";
  private release: (() => Promise<void>) | null = null;
  private stream: Overview["status"]["stream"] = "connecting";
  private errors = new Map<string, string>();
  private chain: Promise<void> = Promise.resolve();
  private publication: Promise<void> | null = null;
  private publicationRequested = false;
  private overviewSourcesDirty = true;
  private overviewSnapshot: { overview: Overview; cursor: string } | null = null;
  private overviewSignature = "";
  private overviewSavedAt = -Infinity;
  private intake: TradeIntake;
  private intakeState: IntakeState | null = null;
  private intakePublication: Promise<void> | null = null;
  private intakeDirty = false;
  private intakePausedSubscription = false;
  private metricsSignature = "";
  private historySignature = "";
  private marketFeed: MarketFeed | null = null;
  private panels: PanelPublisher;
  constructor(
    private store: Store,
    private upstream: Upstream,
    private bus: ChangeBus,
  ) {
    this.panels = new PanelPublisher(
      store,
      () => this.bus.notify(),
      (error) => {
        if (error) this.errors.set("panel-revisions", errorMessage(error));
        else this.errors.delete("panel-revisions");
      },
    );
    this.intake = new TradeIntake(store, {
      change: (state) => {
        this.intakeState = state;
        // A lost commit acknowledgement can report a retry after a trade was
        // stored. Reconcile that uncertain write even without committed().
        if (state.retrying) this.overviewSourcesDirty = true;
        if (state.error) this.errors.set("trade-ingestion", state.error);
        else this.errors.delete("trade-ingestion");
        if (state.gap)
          this.errors.set(
            "trade-ingestion-gap",
            "Trade observation coverage has an unresolved intake gap. Saved observations remain available.",
          );
        this.publishIntakeStatus();
      },
      committed: () => {
        // Trade events are already committed and can be replayed immediately.
        // The next intake status flush folds the whole batch into one snapshot.
        this.overviewSourcesDirty = true;
        this.bus.notify();
      },
      overflow: () => {
        this.intakePausedSubscription = true;
        this.subscription?.unsubscribe();
      },
      capacityAvailable: () => {
        if (
          !this.stopped &&
          !this.streamSafetyBlocked &&
          this.intakePausedSubscription
        ) {
          this.intakePausedSubscription = false;
          this.subscription?.subscribe();
        }
      },
    });
  }
  async start(): Promise<boolean> {
    this.release = await this.store.lease();
    if (!this.release) return false;
    this.panels.start();
    this.intake.start();
    this.marketFeed = new MarketFeed(
      async (quote) => {
        if (await this.store.market.quote(quote)) this.bus.notify();
      },
      async (connection) => {
        await this.store.put("market-connection", connection, connection.at);
        if (connection.connected) this.errors.delete("market-quotes");
        else
          this.errors.set(
            "market-quotes",
            connection.reason ?? "Market quotes are delayed.",
          );
      },
    );
    this.marketFeed.start();
    this.loop("asset-live", 5000, () => refreshMarkets(this.store));
    this.loop("asset-market", 5000, async () => {
      const source = await this.upstream.request(
        "/state/house/current",
        houseSchema,
      );
      await retainAssetSource(this.store, source);
      await retainHouseSource(this.store, source);
    });
    this.loop("house", 5000, () =>
      this.publishPanels("house", refreshHouse(this.store)),
    );
    this.loop("protocol-charts", 10000, () =>
      this.publishPanels("protocol-charts", refreshProtocolCharts(this.store)),
    );
    this.loop("liquidations-backfill", 10000, async () => {
      await this.store.liquidations.backfill(1000);
    });
    this.loop("liquidations", 5000, () =>
      this.publishPanels("liquidations", refreshLiquidations(this.store)),
    );
    this.loop("asset-activity", 10000, async () => {
      await this.store.analytics.backfill(500);
      await refreshAssetAnalytics(this.store);
    });
    this.loop("position-metrics", 5000, async () => {
      const results = await Promise.allSettled([
        this.store.positionMetrics.tick(500),
        this.store.depositMetrics.tick(500),
      ]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    });
    this.loop(
      "summary",
      config.summaryInterval,
      async () => {
        const summary = await this.upstream.request(
          "/query/protocol/summary",
          summarySchema,
        );
        await this.retainSummary(summary);
      },
      true,
    );
    this.loop("wallet-summaries", 5000, () =>
      refreshWatchedWallet(this.store, this.upstream),
    );
    this.loop("active-trader-profits", ACTIVE_PROFIT_REFRESH_INTERVAL_MS, () =>
      refreshActiveTraderProfits(this.store, this.upstream),
    );
    this.loop(
      "directory",
      config.directoryInterval,
      () => refreshDirectoryHead(this.store, this.upstream),
      true,
    );
    this.loop(
      "directory-sweep",
      config.directoryInterval,
      async () => {
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
        await this.store.following.retainAccounts(
          accounts.accounts,
          Date.now(),
          true,
        );
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
      },
      true,
    );
    this.loop(
      "history",
      config.historyInterval,
      async () => {
        const h = await this.upstream.request(
          // Reconcile the whole visible daily window in one source generation.
          // Live summary samples still preserve minute-resolution TVL, and older
          // retained minute history is never deleted by this hourly upsert.
          "/query/protocol/history?interval=1h",
          protocolHistorySchema,
        );
        await retainProtocolHistory(this.store, h);
      },
      true,
    );
    const historyIndexer = new HistoryIndexer(
      this.store.history,
      (path, schema) => this.upstream.request(path, schema),
    );
    this.loop("wallet-indexer", config.walletIndexInterval, async () => {
      await historyIndexer.tick({
        maxRequests: config.walletIndexRequests,
        sourceConcurrency: config.requestConcurrency,
        shouldStop: () => this.stopped,
      });
    });
    this.loop("indexing-status", 30000, async () => {
      await this.store.put("indexing-status", await this.store.history.stats());
    });
    this.loop("recent", config.recentInterval, async () => {
      if (!this.intake.canAccept) return;
      const r = await this.upstream.request(
        "/query/protocol/trades/recent",
        z.object({ ok: z.literal(true), events: z.array(z.unknown()).max(50) }),
      );
      this.intake.enqueue([...r.events].reverse(), "recent-api");
    });
    this.client = new Centrifuge(config.streamUrl, {
      websocket: WebSocket as unknown as typeof globalThis.WebSocket,
      minReconnectDelay: 1000,
      maxReconnectDelay: 15000,
      timeout: 10000,
    });
    this.client.on("error", (context) => {
      this.streamLifecycle(
        "error",
        context.error.code,
        context.error.message,
        "Trade connection is temporarily unavailable.",
      );
    });
    this.client.on("disconnected", (context) => {
      this.streamLifecycle(
        "disconnected",
        context.code,
        context.reason,
        "Trade connection is disconnected.",
      );
    });
    this.client.on("connecting", (context) => {
      this.streamLifecycle("connecting", context.code, context.reason);
    });
    this.client.on("connected", () => {
      this.streamLifecycle("connected");
    });
    const subscription = (this.subscription =
      this.client.newSubscription("public:trades"));
    subscription.on("subscribed", (context) => {
      if (this.stopped || this.streamSafetyBlocked) return;
      if (context.recoverable || context.wasRecovering) {
        this.streamSafetyBlocked = true;
        subscription.unsubscribe();
        this.streamLifecycle(
          "recovery-rejected",
          null,
          "Unexpected trade stream recovery contract.",
          "Trade connection is unavailable.",
        );
        return;
      }
      this.lastSubscribedAt = Date.now();
      this.errors.delete("stream");
      this.streamLifecycle("subscribed");
    });
    subscription.on("subscribing", (context) => {
      this.streamLifecycle("subscribing", context.code, context.reason);
    });
    subscription.on("unsubscribed", (context) => {
      this.streamLifecycle(
        "unsubscribed",
        context.code,
        context.reason,
        "Trade connection is unavailable.",
      );
    });
    subscription.on("error", (context) => {
      this.streamLifecycle(
        "subscription-error",
        context.error.code,
        context.error.message,
        "Trade connection is temporarily unavailable.",
      );
    });
    subscription.on("publication", (context) => {
      if (this.stopped || this.streamSafetyBlocked) return;
      const valid = this.intake.enqueue(context.data, "public-stream");
      // A valid new publication proves transport recovery only. Independent
      // ingestion/gap errors remain until their own conditions are resolved.
      if (
        valid &&
        this.errors.has("stream") &&
        this.client?.state === "connected" &&
        subscription.state === "subscribed"
      ) {
        this.errors.delete("stream");
        this.streamLifecycle("publication-recovered");
      }
    });
    subscription.subscribe();
    this.client.connect();
    return true;
  }
  private streamLifecycle(
    event: string,
    code: unknown = null,
    reason: unknown = "",
    failure?: string,
  ) {
    if (
      this.stopped ||
      (this.streamSafetyBlocked && event !== "recovery-rejected")
    )
      return;
    const clientState = this.client?.state ?? "disconnected";
    const subscriptionState = this.subscription?.state ?? "unsubscribed";
    this.stream =
      this.streamSafetyBlocked ||
      clientState === "disconnected" ||
      subscriptionState === "unsubscribed"
        ? "disconnected"
        : clientState === "connected" && subscriptionState === "subscribed"
          ? "connected"
          : "connecting";
    if (failure) {
      this.errors.set("stream", failure);
    }
    const diagnostic: StreamDiagnostics = {
      at: Date.now(),
      event,
      clientState,
      subscriptionState,
      code:
        typeof code === "number" && Number.isSafeInteger(code) ? code : null,
      reason: streamReason(reason),
      lastSubscribedAt: this.lastSubscribedAt,
    };
    console.info(`Trade stream ${event}:`, {
      code: diagnostic.code,
      reason: diagnostic.reason,
    });
    // Terminal server refusals remain stopped; Centrifuge owns automatic
    // reconnection for temporary failures. Persist arrival order, not DB timing.
    this.track(
      this.persistStatus(diagnostic)
        .then(() => this.publish(false))
        .catch(() => {
          console.error("Trade stream status persistence failed.");
        }),
    );
  }
  private persistStatus(diagnostic?: StreamDiagnostics): Promise<void> {
    this.panels.health(this.errors, this.stream === "connected");
    const run = this.statusPersistence.then(async () => {
      if (diagnostic)
        await this.store.put("stream-diagnostics", diagnostic, diagnostic.at);
      const at = Date.now();
      const errors = Object.fromEntries(this.errors);
      // Persist health transitions immediately. Queue counters remain useful in
      // the periodic heartbeat without rewriting it on every idle intake tick.
      const signature = digest({
        errors,
        stream: this.stream,
        retrying: this.intakeState?.retrying,
        admissionPaused: this.intakeState?.admissionPaused,
        gap: this.intakeState?.gap,
      });
      if (signature === this.heartbeatSignature && at - this.heartbeatAt < 5000)
        return;
      await this.store.put(
        "collector-heartbeat",
        {
          at,
          errors,
          ...(this.intakeState ? { tradeIntake: this.intakeState } : {}),
        },
        at,
      );
      this.heartbeatAt = at;
      this.heartbeatSignature = signature;
    });
    this.statusPersistence = run.catch(() => {});
    return run;
  }
  private track(task: Promise<unknown>) {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
  }
  private async publishPanels(name: string, work: Promise<PanelPublication[]>) {
    const publications = await work;
    this.errors.delete(name);
    this.panels.health(this.errors, this.stream === "connected");
    for (const publication of publications) this.panels.committed(publication);
  }
  private loop(
    name: string,
    interval: number,
    work: () => Promise<void>,
    overviewSource = false,
  ) {
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
      } finally {
        // Source work can commit partially before failing. Preserve its
        // invalidation even if the following heartbeat write also fails.
        if (overviewSource) this.overviewSourcesDirty = true;
      }
      try {
        await this.persistStatus();
        await this.publish(false);
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
  private publishIntakeStatus() {
    if (this.stopped) return;
    this.intakeDirty = true;
    if (this.intakePublication) return;
    const task = (async () => {
      do {
        this.intakeDirty = false;
        await this.persistStatus();
        await this.publish(false);
      } while (this.intakeDirty && !this.stopped);
    })()
      .catch(() => {
        console.error("Trade intake status persistence is delayed.");
      })
      .finally(() => {
        this.intakePublication = null;
      });
    this.intakePublication = task;
    this.track(task);
  }
  private async retainSummary(summary: ProtocolSummary): Promise<void> {
    // A publication reads summary and samples separately. Serialize these
    // writes with those reads so no other loop can publish a new summary with
    // the previous active-minute sample (then resend the complete history).
    // Source requests remain outside this short persistence/publication lane.
    const run = this.chain.then(async () => {
      if (this.stopped) return;
      const previous = await this.store.get<ProtocolSummary>("summary");
      if (
        previous &&
        BigInt(summary.source.block) < BigInt(previous.value.source.block)
      )
        throw new Error(
          "Upstream protocol summary moved backward; retaining the newer observation.",
        );
      // Observe every accepted accumulator, including resets that recover
      // between slower chart publications. Publish only after this is saved.
      await refreshStakerYield(this.store, summary);
      await this.store.put("summary", summary);
      await this.store.sample(
        Math.floor(summary.source.at / 60000) * 60000,
        Number(BigInt(summary.balances.tvl)) / 1e18,
      );
    });
    // Preserve the original failure for the summary loop while letting later
    // publications/refreshes proceed and expose any actual persistence error.
    this.chain = run.catch(() => {});
    await run;
    if (!this.stopped) await retainProtocolChartSummary(this.store, summary);
  }
  private publish(refreshSources = true): Promise<void> {
    if (refreshSources) this.overviewSourcesDirty = true;
    this.publicationRequested = true;
    if (this.publication) return this.publication;
    const run = this.chain.then(async () => {
      try {
        do {
          this.publicationRequested = false;
          if (this.stopped) return;
          await this.publishOverview();
        } while (this.publicationRequested);
      } finally {
        // Clear in the same turn as the drain finishes. A request during promise
        // settlement must enqueue a new run rather than join an exhausted one.
        this.publication = null;
      }
    });
    this.chain = run.catch(() => {});
    this.publication = run;
    return run;
  }
  private async readOverviewSources() {
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
        stale: true,
        persistence: this.store.kind,
        stream: this.stream,
      },
    };
    return { overview, cursor: eventCursor };
  }
  private async publishOverview() {
    let snapshot = this.overviewSnapshot;
    if (this.overviewSourcesDirty || !snapshot) {
      // Clear before reading so a commit during these reads requests another
      // source refresh. A failed read/write must never consume that invalidation.
      this.overviewSourcesDirty = false;
      try {
        snapshot = await this.readOverviewSources();
      } catch (error) {
        this.overviewSourcesDirty = true;
        throw error;
      }
    }
    const previousStatus = snapshot.overview.status;
    const overview: Overview = {
      ...snapshot.overview,
      status: {
        receivedAt: previousStatus.receivedAt,
        sourceAt: previousStatus.sourceAt,
        indexedBlock: previousStatus.indexedBlock,
        stale:
          previousStatus.receivedAt === null ||
          Date.now() - previousStatus.receivedAt > 15000 ||
          previousStatus.sourceAt === null ||
          Date.now() - previousStatus.sourceAt > 30000,
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
    const signature = digest(overview);
    if (
      signature !== this.overviewSignature ||
      (snapshot.cursor !== this.overviewSnapshot?.cursor &&
        Date.now() - this.overviewSavedAt >= 10000)
    ) {
      try {
        // Even an identical full source read can safely advance replay past old
        // events. Bound those cursor-only writes; cached health saves keep their
        // original watermark and cannot skip financial events not yet read.
        await this.store.put("overview", {
          ...overview,
          eventCursor: snapshot.cursor,
        });
      } catch (error) {
        this.overviewSourcesDirty = true;
        throw error;
      }
      this.overviewSignature = signature;
      this.overviewSavedAt = Date.now();
      this.overviewSnapshot = { overview, cursor: snapshot.cursor };
    }
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
    const historySignature = protocolHistoryDigest(
      historyData,
      overview.summary,
    );
    if (historySignature !== this.historySignature) {
      await this.emit({ type: "history", data: historyData });
      this.historySignature = historySignature;
    }
  }
  async stop() {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.client?.disconnect();
    await Promise.all([
      this.marketFeed?.stop(),
      this.intake.stop(),
      this.panels.stop(),
    ]);
    await Promise.allSettled([...this.tasks]);
    await this.statusPersistence;
    await this.chain;
    await this.release?.();
    this.release = null;
  }
}
