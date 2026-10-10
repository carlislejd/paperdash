import { createHash } from "node:crypto";
import type { Store } from "../../apps/server/src/store.js";
import type {
  AccountsResponse,
  Overview,
  TradeEvent,
} from "../../packages/shared/src/types.js";

/** Synthetic bounded public payloads, never fetched from a provider. */
export async function cacheFixtures(store: Store) {
  const raw = (usd: number) =>
    (BigInt(Math.round(usd * 100)) * 10n ** 16n).toString();
  const digest = (label: string) =>
    createHash("sha256").update(label).digest("hex");
  const address = (i: number) => `0x${digest(`wallet:${i}`).slice(0, 40)}`;
  let revision = 0;
  let aggregateReads = 0;
  let accountLoads = 0;
  let overview: Overview;
  let accounts: AccountsResponse;
  let updatedAt = Date.now();
  const trade = (i: number, now = Date.now()): TradeEvent => ({
    id: digest(`trade:${i}`),
    ts: now - i * 1000,
    wallet: address((i % 10000) + 1),
    instrument: i % 2,
    side: i % 2 ? "short" : "long",
    leverage: 1000,
    notionalUsd: 10_000_000_000 + i * 17.13,
    kind: i % 7 ? "open" : "liq",
    pnlUsd: i % 7 ? null : -10000000,
    priceUsd: i % 2 ? 2537.13 : 83871.9,
    provenance: "public-stream",
  });
  // This harness measures shared cached HTTP/SSE processing, not PostgreSQL
  // aggregate query capacity. The materialized rollup is an explicit fixture.
  store.positionMetrics.read = async () => {
    aggregateReads++;
    return {
      positionCount: 123456,
      avgHoldMs: 38250,
      avgLeverage: 412.5,
      excludedCount: 17,
      updatedAt,
      projectionBackfillComplete: true,
      pending: false,
    };
  };
  async function update() {
    const now = Date.now();
    updatedAt = now;
    revision++;
    const summary = {
      ok: true,
      source: { block: String(48000000 + revision), at: now },
      balances: {
        tvl: raw(10_000_000_000 + revision),
        margin: raw(3_000_000_000),
        lp: raw(100_000_000),
        reserve: "0",
        queue: raw(123000),
      },
      activity: { volume: raw(200_000_000_000), open: 12345 },
      fees: { lifetime: raw(246000), pending: raw(3240) },
      paper: {
        supply: raw(1_260_000_000),
        staked: raw(1_162_000_000),
        pendingRewards: raw(3240),
      },
    };
    overview = {
      summary,
      accountCount: 10000,
      history: Array.from({ length: 300 }, (_, i) => ({
        time: now - (300 - i) * 60000,
        value: 10_000_000_000 + Math.sin(i) * 1000000,
      })),
      historyCoverage: "observed",
      trades: Array.from({ length: 50 }, (_, i) => trade(i, now)),
      status: {
        sourceAt: now,
        receivedAt: now,
        indexedBlock: summary.source.block,
        stale: false,
        persistence: "local",
        stream: "connected",
      },
    };
    accounts = {
      accounts: Array.from({ length: 10 }, (_, i) => ({
        address: address(i + 1),
        leaderboardName: `Synthetic trader ${i + 1}`,
        currentBalance: raw(100000 + i * 231),
        currentQueued: raw(200),
        currentOpenNotional: raw(10000000),
        currentOpenPositionCount: 12,
        currentUnrealizedPnl: raw(231),
        realizedPnl: raw(1523),
        totalVolume: raw(1000000000),
        totalWindowedPnl: raw(523),
        paperTotal: raw(100000),
        lastActiveTs: now,
      })),
      count: 10000,
      pageInfo: { page: 0, totalPages: 1000 },
      summary: {
        uniqueAccounts: 10000,
        trackedBalance: summary.balances.tvl,
        trackedQueued: summary.balances.queue,
        trackedOpenNotional: raw(20000000000),
        trackedPaper: summary.paper.supply,
      },
      receivedAt: now,
      stale: false,
    };
    const cursor = (await store.eventBounds()).latest ?? "0";
    await store.put("overview", { ...overview, eventCursor: cursor });
    await store.put("collector-heartbeat", { at: now, errors: {} });
    await store.put("indexing-status", { wallets: 10000 });
    await store.put("account-count", 10000);
    await store.put("market-connection", { connected: true, at: now });
    await store.put("asset-source", {
      ok: true,
      historyGeneration: "fixture",
      historyRevision: String(revision),
      sourceAsOfMs: now,
      head: [
        now,
        100000000,
        -500000,
        12000,
        3600000000,
        2600000000,
        2500000000,
        1600000000,
      ],
    });
    await store.put("asset-analytics", {
      activity: [0, 1].map((instrument) => ({
        instrument,
        windowFrom: now - 86400000,
        windowTo: now,
        counts: { total: 50000, long: 30000, short: 20000 },
        notionalUsd: { total: 1e11, long: 6e10, short: 4e10 },
        recent: Array.from({ length: 8 }, (_, i) =>
          trade(i * 2 + instrument, now),
        ),
        coverage: {
          source: "retained-public-observations",
          observedFrom: now - 86400000,
          latestObservedAt: now,
          projectionBackfillComplete: true,
          identityAmbiguous: true,
        },
      })),
      history: Object.fromEntries(
        [0, 1].map((instrument) => [
          instrument,
          Array.from({ length: 300 }, (_, i) => ({
            instrument,
            time: now - (300 - i) * 288000,
            longRaw: raw(1000000000 + i * 1326.39),
            shortRaw: raw(900000000 + i * 628.13),
            sourceAt: now - (300 - i) * 288000,
            receivedAt: now - (300 - i) * 288000,
            sourceBlock: null,
          })),
        ]),
      ),
    });
    await store.put("house", {
      sourceAt: now,
      receivedAt: now,
      stale: false,
      house: {
        fundsRaw: raw(100488000),
        lpRaw: raw(100000000),
        openPnlRaw: raw(500000),
        queueDebtRaw: raw(12000),
      },
      paper: {
        supplyRaw: summary.paper.supply,
        stakedRaw: summary.paper.staked,
        stakerRewardsRaw: summary.fees.lifetime,
        pendingRewardsRaw: summary.fees.pending,
      },
      sourceBlock: summary.source.block,
      summarySourceAt: now,
      summaryReceivedAt: now,
      history: Array.from({ length: 300 }, (_, i) => ({
        time: now - (300 - i) * 288000,
        fundsRaw: raw(100000000 + Math.sin(i / 7) * 500000),
        ...(i === 150 ? { gapBefore: true } : {}),
      })),
      coverage: {
        source: "retained-house-observations",
        approximate: true,
        partial: true,
        observedFrom: now - 86400000,
      },
    });
    for (const instrument of [0, 1]) {
      const price = instrument ? 2537.13 : 83871.9;
      await store.put(`market:${instrument}`, {
        instrument,
        symbol: instrument ? "ETH" : "BTC",
        price: { priceUsd: price, sourceAt: now, receivedAt: now },
        points: Array.from({ length: 720 }, (_, i) => ({
          time: now - (719 - i) * 5000,
          priceUsd: price + Math.sin(i / 11) * 42.19,
          ...(i === 0 ? { gapBefore: true } : {}),
        })),
        trades: Array.from({ length: 200 }, (_, i) =>
          trade(i * 2 + instrument, now),
        ),
        windowFrom: now - 3600000,
        windowTo: now,
        receivedAt: now,
        stale: false,
        coverage: {
          source: "retained-market-observations",
          observedFrom: now - 3600000,
          partial: true,
          tradesCapped: true,
        },
      });
    }
    await store.put("liquidations:all", {
      items: Array.from({ length: 50 }, (_, i) => ({
        ...trade(i, now),
        kind: "liq",
      })),
      nextCursor: null,
      stats: {
        hour: {
          count: 326,
          longCount: 190,
          shortCount: 136,
          notionalUsd: 15000000000,
        },
        day: {
          count: 7236,
          longCount: 4200,
          shortCount: 3036,
          notionalUsd: 550000000000,
        },
      },
      windowTo: now,
      receivedAt: now,
      stale: false,
      coverage: {
        source: "retained-public-observations",
        partial: true,
        identityAmbiguous: true,
        projectionBackfillComplete: true,
        observedFrom: now - 86400000,
        latestObservedAt: now,
      },
    });
    return overview;
  }
  await update();
  return {
    update,
    trade,
    upstream: {
      accounts: async () => {
        accountLoads++;
        return accounts;
      },
    },
    counters: () => ({ aggregateReads, accountLoads }),
    reset: () => {
      aggregateReads = 0;
      accountLoads = 0;
    },
  };
}
