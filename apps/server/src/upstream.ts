import { z } from "zod";
import type {
  AccountsResponse,
  LeaderboardResponse,
  Cashflow,
  ClosedTrade,
  HistoryPage,
  PortfolioHistory,
  WalletResponse,
  WalletSnapshot,
} from "../../../packages/shared/src/types.js";
import { config, errorMessage } from "./config.js";
import { accountsSchema, addressSchema, walletSchema } from "./schemas.js";
import type { Store } from "./store.js";
import { activityDelayed } from "./activity-health.js";
import {
  CoordinationError,
  LocalCoordinator,
  RedisCoordinator,
  SharedCooldownError,
  type RequestCoordinator,
} from "./coordination.js";

const localCoordinators = new WeakMap<Store, RequestCoordinator>();

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
    private queueTimeout = config.requestQueueTimeout,
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
      const entry = {
        reject: (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        },
        run: () => {
          clearTimeout(timeout);
          this.active++;
          fn()
            .then(resolve, reject)
            .finally(() => {
              this.active--;
              this.drain();
            });
        },
      };
      const timeout = setTimeout(() => {
        const at = this.queue.indexOf(entry);
        if (at !== -1) this.queue.splice(at, 1);
        reject(new UpstreamError("Upstream request queue wait expired.", 503));
      }, this.queueTimeout);
      this.queue.push(entry);
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
  readonly coordinator: RequestCoordinator;
  private inflight = new Map<string, Promise<Cached<unknown>>>();
  constructor(
    readonly store: Store,
    private fetcher: typeof fetch = fetch,
    private origin = config.upstream,
    gate?: RequestGate,
    coordinator?: RequestCoordinator,
  ) {
    this.gate =
      gate ?? new RequestGate(config.requestConcurrency, config.requestSpacing);
    if (!coordinator && store.kind === "postgres" && !config.redisUrl)
      throw new Error(
        "REDIS_URL is required with PostgreSQL to coordinate upstream requests across instances.",
      );
    if (coordinator) this.coordinator = coordinator;
    else if (config.redisUrl)
      this.coordinator = new RedisCoordinator(config.redisUrl, origin, {
        concurrency: config.requestConcurrency,
        spacing: config.requestSpacing,
        wait: config.requestQueueTimeout,
      });
    else {
      if (!localCoordinators.has(store))
        localCoordinators.set(store, new LocalCoordinator());
      this.coordinator = localCoordinators.get(store)!;
    }
  }

  async close() {
    await Promise.allSettled(this.inflight.values());
    this.coordinator.close();
  }

  private async limited<T>(work: () => Promise<T>): Promise<T> {
    return this.gate.run(async () => {
      let release: (() => Promise<void>) | undefined;
      try {
        release = await this.coordinator.acquire();
        return await work();
      } catch (error) {
        if (error instanceof SharedCooldownError) {
          this.gate.cooldown = Math.max(this.gate.cooldown, error.retryAt);
          throw new UpstreamError(error.message, 429, error.retryAt);
        }
        if (error instanceof CoordinationError)
          throw new UpstreamError(error.message, 503);
        throw error;
      } finally {
        await release?.();
      }
    });
  }

  private async rateLimited(
    response: Response,
    message: string,
  ): Promise<never> {
    this.gate.cooldown = retryAfter(response.headers.get("Retry-After"));
    await response.body?.cancel();
    await this.coordinator.defer(Math.max(1, this.gate.cooldown - Date.now()));
    throw new UpstreamError(message, 429, this.gate.cooldown);
  }

  async request<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new Error("Only upstream relative paths are allowed");
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.limited(async () => {
          const response = await this.fetcher(new URL(path, this.origin), {
            headers: { Accept: "application/json" },
            redirect: "error",
            signal: AbortSignal.timeout(10000),
          });
          if (response.status === 429) {
            return this.rateLimited(
              response,
              "Papertrade rate limit; serving saved observations when available.",
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
        });
      } catch (error) {
        const retryable =
          error instanceof TypeError ||
          (error instanceof UpstreamError &&
            error.status >= 500 &&
            error.status !== 502 &&
            error.status !== 503);
        if (attempt >= 1 || !retryable) throw error;
        await sleep(300);
      }
    }
  }

  async cached<T>(
    key: string,
    ttl: number,
    loader: () => Promise<T>,
    options: {
      wait?: boolean;
      staleAfter?: number;
      waitForInitial?: boolean;
      isCurrent?: (value: T) => boolean;
    } = {},
  ): Promise<Cached<T>> {
    // Read the shared cache on every lookup. A local entry must not hide a newer
    // refresh performed by another API instance or by the collector.
    const row = await this.store.get<T>(`cache:${key}`);
    const saved = row
      ? { ...row, stale: Date.now() - row.receivedAt > ttl }
      : undefined;
    const failure = (
      await this.store.get<{ until: number; message: string }>(
        `cache-error:${key}`,
      )
    )?.value;
    if (
      saved &&
      Date.now() - saved.receivedAt <= ttl &&
      (options.isCurrent?.(saved.value) ?? true)
    )
      return { ...saved, stale: false };
    if (failure && Date.now() < failure.until) {
      if (saved) return { ...saved, stale: true, error: failure.message };
      throw new UpstreamError(failure.message, 503, failure.until);
    }
    let promise = this.inflight.get(key) as Promise<Cached<T>> | undefined;
    if (!promise) {
      // Distinct cold searches/wallets must not create an unbounded set of Redis
      // locks or waiting promises. Existing cache reads and same-key joins remain available.
      if (this.inflight.size >= 32) {
        const message =
          "Live refresh capacity is busy; showing saved observations when available.";
        if (saved) return { ...saved, stale: true, error: message };
        throw new UpstreamError(message, 503, Date.now() + 5000);
      }
      promise = (async () => {
        const deadline = Date.now() + 14000;
        do {
          const lease = await this.coordinator.lock(key);
          if (lease) {
            try {
              const current = await this.store.get<T>(`cache:${key}`);
              if (
                current &&
                Date.now() - current.receivedAt <= ttl &&
                (options.isCurrent?.(current.value) ?? true)
              )
                return { ...current, stale: false };
              const sharedFailure = (
                await this.store.get<{ until: number; message: string }>(
                  `cache-error:${key}`,
                )
              )?.value;
              if (sharedFailure && sharedFailure.until > Date.now())
                throw new UpstreamError(
                  sharedFailure.message,
                  503,
                  sharedFailure.until,
                );
              const value = await loader();
              await lease.assertOwned();
              const result = { value, receivedAt: Date.now(), stale: false };
              await this.store.put(`cache:${key}`, value, result.receivedAt);
              return result;
            } finally {
              await lease.release();
            }
          }
          const current = await this.store.get<T>(`cache:${key}`);
          if (
            current &&
            Date.now() - current.receivedAt <= ttl &&
            (options.isCurrent?.(current.value) ?? true)
          )
            return { ...current, stale: false };
          const sharedFailure = (
            await this.store.get<{ until: number; message: string }>(
              `cache-error:${key}`,
            )
          )?.value;
          if (sharedFailure && sharedFailure.until > Date.now())
            throw new UpstreamError(
              sharedFailure.message,
              503,
              sharedFailure.until,
            );
          await sleep(100);
        } while (Date.now() < deadline);
        throw new UpstreamError(
          "Another instance is refreshing this data; retry shortly.",
          503,
        );
      })()
        .catch(async (error) => {
          const previousFailure = await this.store
            .get<{ until: number }>(`cache-error:${key}`)
            .catch(() => null);
          await this.store
            .put(`cache-error:${key}`, {
              until: Math.max(
                Date.now() + 5000,
                this.gate.cooldown,
                error instanceof UpstreamError ? error.retryAt : 0,
                previousFailure?.value.until ?? 0,
              ),
              message: errorMessage(error).slice(0, 500),
            })
            .catch(() => {});
          throw error;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, promise as Promise<Cached<unknown>>);
    }
    if (!saved && options.waitForInitial === false) {
      void promise.catch(() => {});
      throw new UpstreamError(
        "Live account snapshot is being collected. Retained history remains available.",
        503,
        Date.now() + 5000,
      );
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

  async directoryPage(
    q = "",
    sort = "currentBalance",
    page = 0,
    pageSize: 10 | 25 = 25,
    wait = false,
  ) {
    const path = canonicalPath("/state/leaderboard/accounts", {
      window: "all",
      sortKey: sort,
      sortDir: "desc",
      page,
      pageSize,
      q,
    });
    return this.cached(
      path,
      15000,
      async () => {
        const value = await this.request(path, accountsSchema);
        await this.store.following.retainAccounts(value.accounts, Date.now());
        return value;
      },
      { wait },
    );
  }
  async accounts(
    q = "",
    sort = "currentBalance",
    page = 0,
    pageSize: 10 | 25 = 25,
  ): Promise<AccountsResponse> {
    const r = await this.directoryPage(q, sort, page, pageSize);
    const countAt = Date.now();
    const counts = await Promise.all([
      this.store.analytics.walletCounts(
        r.value.accounts.map((account) => account.address),
        countAt,
      ),
      activityDelayed(this.store, countAt),
    ]).catch(() => null);
    const countStale =
      !counts ||
      counts[1] ||
      !counts[0].projectionBackfillComplete ||
      counts[0].observedFrom === null;
    return {
      ...r.value,
      accounts: r.value.accounts.map((account) => ({
        ...account,
        tradeCount24h: counts?.[0].counts[account.address] ?? null,
        tradeCount24hStale: countStale,
        ...(counts ? { tradeCount24hAt: countAt } : {}),
      })),
      tradeCountCoverage: {
        source: "retained-public-observations",
        partial: true,
        observedFrom: counts?.[0].observedFrom ?? null,
        projectionBackfillComplete:
          counts?.[0].projectionBackfillComplete ?? false,
        receivedAt: countAt,
        stale: countStale,
      },
      receivedAt: r.receivedAt,
      stale: r.stale,
      ...(r.error ? { error: r.error } : {}),
    };
  }
  async leaderboard(
    metric: LeaderboardResponse["metric"] = "pnl",
    page = 0,
    q = "",
  ): Promise<LeaderboardResponse> {
    if (metric === "pnl" || metric === "paper") {
      const path = canonicalPath("/state/leaderboard/accounts", {
        // Ownership is current in either source window; 24h keeps the
        // accompanying totalWindowedPnl field consistent with the PnL ranking.
        window: "24h",
        sortKey: metric === "paper" ? "paperTotal" : "totalWindowedPnl",
        sortDir: "desc",
        page,
        pageSize: 25,
        q,
      });
      const result = await this.cached(path, 20000, () =>
        this.request(path, accountsSchema),
      );
      const activityAt = Date.now();
      const addresses = result.value.accounts.map((a) => a.address);
      const activity = await this.cached(
        `leaderboard-activity:${path}`,
        20000,
        () => this.store.analytics.walletMetrics(addresses, activityAt),
        {
          wait: true,
          isCurrent: (value) =>
            Object.keys(value.counts).length === addresses.length &&
            addresses.every((address) => address in value.counts),
        },
      ).catch(() => null);
      const activityStale =
        !activity ||
        activity.stale ||
        Boolean(activity.error) ||
        addresses.some((address) => !(address in activity.value.counts)) ||
        (await activityDelayed(this.store, activityAt)) ||
        !activity.value.projectionBackfillComplete ||
        activity.value.observedFrom === null;
      const trackedPaper = BigInt(result.value.summary.trackedPaper);
      const pagePaper = result.value.accounts.reduce(
        (total, account) => total + BigInt(account.paperTotal),
        0n,
      );
      return {
        window: metric === "paper" ? "current" : "24h",
        metric,
        rows: result.value.accounts.map((account, index) => ({
          address: account.address,
          leaderboardName: account.leaderboardName,
          rank: page * 25 + index + 1,
          pnlRaw: account.totalWindowedPnl,
          paperTotalRaw: account.paperTotal,
          volumeUsd: activity?.value.volumesUsd[account.address] ?? null,
          tradeCount: activity?.value.counts[account.address] ?? null,
          currentUnrealizedPnlRaw: account.currentUnrealizedPnl,
          assetsTraded: activity?.value.assetsTraded[account.address] ?? null,
        })),
        count: result.value.count,
        pageInfo: result.value.pageInfo,
        receivedAt: result.receivedAt,
        stale: result.stale,
        accountReceivedAt: result.receivedAt,
        accountStale: result.stale,
        paperOwnership: {
          trackedTotalRaw: result.value.summary.trackedPaper,
          pageTotalRaw: pagePaper.toString(),
          pageShareBps:
            trackedPaper > 0n && pagePaper <= trackedPaper
              ? Number((pagePaper * 10000n) / trackedPaper)
              : null,
        },
        activityCoverage: {
          source: "retained-public-observations",
          partial: true,
          observedFrom: activity?.value.observedFrom ?? null,
          projectionBackfillComplete:
            activity?.value.projectionBackfillComplete ?? false,
          receivedAt: activity?.receivedAt ?? activityAt,
          windowFrom:
            activity?.value.windowFrom ?? Math.max(0, activityAt - 86400000),
          windowTo: activity?.value.windowTo ?? activityAt,
          stale: activityStale,
        },
        ...(result.error ? { error: result.error } : {}),
        coverage: {
          source: "papertrade-leaderboard",
          observedFrom: null,
          projectionBackfillComplete: true,
          identityAmbiguous: false,
        },
      };
    }
    // The observed ranking is derived from materialized minute aggregates, never
    // a fresh upstream scan or a download of every wallet's trade history.
    const result = await this.cached(
      `observed-leaderboard:${metric}:${page}:${q}`,
      20000,
      async () => {
        const ranking = await this.store.analytics.walletActivity(
          metric,
          page,
          q,
        );
        const metrics = await this.store.analytics
          .walletMetrics(
            ranking.rows.map((row) => row.address),
            ranking.windowTo,
          )
          .catch(() => null);
        return { ...ranking, metrics };
      },
    );
    const collectorStale = await activityDelayed(this.store);
    return {
      window: "24h",
      metric,
      rows: result.value.rows.map((row, index) => ({
        address: row.address,
        leaderboardName: null,
        rank: page * 25 + index + 1,
        pnlRaw: null,
        paperTotalRaw: null,
        volumeUsd: row.notionalUsd,
        tradeCount: row.count,
        currentUnrealizedPnlRaw: null,
        assetsTraded: result.value.metrics?.assetsTraded[row.address] ?? null,
      })),
      count: result.value.count,
      pageInfo: {
        page,
        totalPages: Math.max(1, Math.ceil(result.value.count / 25)),
      },
      receivedAt: result.receivedAt,
      stale: result.stale || collectorStale,
      accountReceivedAt: null,
      accountStale: true,
      activityCoverage: {
        source: "retained-public-observations",
        partial: true,
        observedFrom: result.value.coverage.observedFrom,
        projectionBackfillComplete:
          result.value.coverage.projectionBackfillComplete,
        receivedAt: result.receivedAt,
        windowFrom: result.value.windowFrom,
        windowTo: result.value.windowTo,
        stale:
          result.stale ||
          collectorStale ||
          !result.value.coverage.projectionBackfillComplete ||
          result.value.coverage.observedFrom === null ||
          !result.value.metrics,
      },
      ...(result.error
        ? { error: result.error }
        : collectorStale
          ? {
              error:
                "Live collection is delayed; ranking retained observations.",
            }
          : {}),
      coverage: {
        source: "retained-public-observations",
        observedFrom: result.value.coverage.observedFrom,
        projectionBackfillComplete:
          result.value.coverage.projectionBackfillComplete,
        identityAmbiguous: true,
      },
    };
  }
  async history<T extends Cashflow | ClosedTrade>(
    address: string,
    kind: "cashflows" | "trades",
    cursor?: string,
    enqueue = true,
  ): Promise<Cached<HistoryPage<T>>> {
    address = addressSchema.parse(address);
    if (enqueue) await this.store.history.ensureWallet(address, 10);
    const page = await this.store.history.readPage<T>(address, kind, cursor);
    return {
      value: page,
      receivedAt: page.receivedAt ?? 0,
      stale: page.stale,
      ...(page.coverage.error ? { error: page.coverage.error } : {}),
    };
  }
  async snapshot(
    address: string,
    waitForInitial = true,
  ): Promise<Cached<WalletSnapshot>> {
    address = addressSchema.parse(address);
    return this.cached(
      `wallet:${address}`,
      config.walletSnapshotTtl,
      () =>
        this.limited(async () => {
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
              return this.rateLimited(response, "Wallet stream rate limited.");
            }
            if (!response.ok || !response.body)
              throw new UpstreamError(
                `Wallet stream returned HTTP ${response.status}.`,
                response.status,
              );
            const value = await firstWalletEvent(response.body, address);
            const previous = await this.store.get<WalletSnapshot>(
              `cache:wallet:${address}`,
            );
            if (
              previous &&
              (value.accountRevision < previous.value.accountRevision ||
                value.indexedThroughBlock <
                  previous.value.indexedThroughBlock ||
                value.indexedThroughTimestamp <
                  previous.value.indexedThroughTimestamp)
            )
              throw new UpstreamError(
                "Papertrade returned an older account revision; retaining the saved snapshot.",
              );
            return value;
          } finally {
            controller.abort();
          }
        }),
      { waitForInitial },
    );
  }
  async wallet(address: string): Promise<WalletResponse> {
    address = addressSchema.parse(address);
    await this.store.history.ensureWallet(address, 10);
    const results = await Promise.allSettled([
      this.snapshot(address, false),
      this.history<Cashflow>(address, "cashflows", undefined, false),
      this.history<ClosedTrade>(address, "trades", undefined, false),
      (async (): Promise<Cached<PortfolioHistory>> => {
        const saved = await this.store.history.readPortfolio(address);
        if (!saved)
          throw new UpstreamError("Portfolio history is being indexed.", 503);
        return {
          ...saved,
          stale: Date.now() - saved.receivedAt > 600000,
          ...(saved.coverage.error ? { error: saved.coverage.error } : {}),
        };
      })(),
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
