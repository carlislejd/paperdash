import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { TradeEvent } from "../../../packages/shared/src/types.js";
import {
  analyticsSchemaSql,
  createLocalAnalytics,
} from "../src/analytics-store.js";
import { createStore, type Store } from "../src/store.js";
import { RequestGate, Upstream } from "../src/upstream.js";

const now = 1_800_000_030_000,
  day = 86400000;
const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const stores: Store[] = [],
  sources: Upstream[] = [];
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(now));
afterEach(async () => {
  for (const source of sources.splice(0)) await source.close();
  for (const store of stores.splice(0)) await store.close();
  vi.restoreAllMocks();
});
function trade(id: string, fields: Partial<TradeEvent> = {}): TradeEvent {
  return {
    id,
    ts: now - 1000,
    wallet: wallet(1),
    instrument: 0,
    side: "long",
    kind: "open",
    leverage: 10,
    notionalUsd: 100,
    pnlUsd: null,
    provenance: "public-stream",
    ...fields,
  };
}
async function fixture() {
  const store = await createStore({ memory: true, databaseUrl: "" });
  stores.push(store);
  await store.put("collector-heartbeat", { at: now, errors: {} });
  await store.put("overview", { status: { stream: "connected" } });
  const fetcher = vi.fn(async () =>
    Response.json({
      ok: true,
      count: 2,
      pageInfo: { page: 0, totalPages: 1 },
      summary: {
        uniqueAccounts: 2,
        trackedBalance: "0",
        trackedQueued: "0",
        trackedOpenNotional: "0",
        trackedPaper: "0",
      },
      accounts: [1, 2].map((n) => ({
        address: wallet(n),
        leaderboardName: null,
        currentBalance: "1",
        currentQueued: "0",
        currentOpenNotional: "0",
        currentOpenPositionCount: 99,
        currentUnrealizedPnl: "-123456789012345678901234",
        realizedPnl: "9999",
        totalVolume: "999999999999999999999999999999999",
        totalWindowedPnl: "42",
        paperTotal: "0",
        lastActiveTs: now / 1000,
      })),
    }),
  );
  const source = new Upstream(
    store,
    fetcher as typeof fetch,
    "https://source.test",
    new RequestGate(3, 0),
  );
  sources.push(source);
  return { store, source, fetcher };
}

describe("bounded leaderboard activity enrichment", () => {
  it("reconciles count, volume and asset sets at both exact 24h edges using source multiplicity", async () => {
    const { store } = await fixture();
    for (const value of [
      trade("old", { ts: now - day - 1, instrument: 8 }),
      trade("start", {
        ts: now - day,
        instrument: 1,
        kind: "close",
        notionalUsd: 10_000_000_000,
      }),
      trade("start-duplicate", {
        ts: now - day,
        instrument: 1,
        kind: "close",
        notionalUsd: 10_000_000_000,
        provenance: "recent-api",
      }),
      trade("start-multiplicity", {
        ts: now - day,
        instrument: 1,
        kind: "close",
        notionalUsd: 10_000_000_000,
      }),
      trade("inside", { ts: now - 60000, kind: "liq", notionalUsd: 0.125 }),
      trade("end", { ts: now, instrument: 7, notionalUsd: 2 }),
      trade("future", { ts: now + 1, instrument: 9 }),
      trade("unrequested", { wallet: wallet(3), instrument: 99 }),
    ])
      await store.recordTrade(value);
    let result = await store.analytics.walletMetrics(
      [wallet(1), wallet(2)],
      now,
    );
    expect(result.counts).toEqual({ [wallet(1)]: 4, [wallet(2)]: null });
    expect(result.volumesUsd).toEqual({
      [wallet(1)]: 20_000_000_002.125,
      [wallet(2)]: null,
    });
    expect(result.assetsTraded).toEqual({
      [wallet(1)]: [0, 1, 7],
      [wallet(2)]: null,
    });
    await store.analytics.backfill();
    result = await store.analytics.walletMetrics([wallet(1), wallet(2)], now);
    expect(result).toMatchObject({
      windowFrom: now - day,
      windowTo: now,
      projectionBackfillComplete: true,
      counts: { [wallet(2)]: 0 },
      volumesUsd: { [wallet(2)]: 0 },
      assetsTraded: { [wallet(2)]: [] },
    });
    expect(
      (await store.analytics.walletActivity("trades", 0, wallet(1), now))
        .rows[0],
    ).toMatchObject({ count: 4, notionalUsd: result.volumesUsd[wallet(1)] });
    expect(await store.analytics.walletMetrics([], now)).toMatchObject({
      counts: {},
      volumesUsd: {},
      assetsTraded: {},
    });
    await expect(
      store.analytics.walletMetrics(
        Array.from({ length: 26 }, (_, n) => wallet(n)),
        now,
      ),
    ).rejects.toThrow();
    await expect(
      store.analytics.walletMetrics(["invalid"], now),
    ).rejects.toThrow();
  });

  it("keeps observed zero unavailable without any collection and guards non-finite volume", async () => {
    const { store } = await fixture();
    await store.analytics.backfill();
    expect(await store.analytics.walletMetrics([wallet(1)], now)).toMatchObject(
      {
        counts: { [wallet(1)]: null },
        volumesUsd: { [wallet(1)]: null },
        assetsTraded: { [wallet(1)]: null },
      },
    );
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(analyticsSchemaSql("", false));
      db.prepare("INSERT INTO analytics_wallet_minutes VALUES(?,?,?,?)").run(
        wallet(1),
        Math.floor(now / 60000) * 60000 - 60000,
        1,
        Infinity,
      );
      const result = await createLocalAnalytics(
        db,
        async () => {},
      ).walletMetrics([wallet(1)], now);
      expect(result.counts[wallet(1)]).toBe(1);
      expect(result.volumesUsd[wallet(1)]).toBeNull();
    } finally {
      db.close();
    }
  });

  it("enriches source PnL with exact current uPnL and independently cached partial activity", async () => {
    const { store, source, fetcher } = await fixture();
    await store.recordTrade(trade("one", { instrument: 1 }));
    await store.analytics.backfill();
    const batch = vi.spyOn(store.analytics, "walletMetrics");
    const first = await source.leaderboard("pnl");
    expect(first.rows[0]).toMatchObject({
      pnlRaw: "42",
      currentUnrealizedPnlRaw: "-123456789012345678901234",
      tradeCount: 1,
      volumeUsd: 100,
      assetsTraded: [1],
    });
    expect(first.rows[1]).toMatchObject({
      tradeCount: 0,
      volumeUsd: 0,
      assetsTraded: [],
    });
    expect(first).toMatchObject({
      accountReceivedAt: now,
      accountStale: false,
      stale: false,
      activityCoverage: {
        source: "retained-public-observations",
        partial: true,
        windowFrom: now - day,
        windowTo: now,
        receivedAt: now,
        stale: false,
      },
    });
    await source.leaderboard("pnl");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledExactlyOnceWith([wallet(1), wallet(2)], now);
    await store.put("collector-heartbeat", {
      at: now,
      errors: { "trade-ingestion-gap": "known gap" },
    });
    const delayed = await source.leaderboard("pnl");
    expect(delayed.stale).toBe(false);
    expect(delayed.accountStale).toBe(false);
    expect(delayed.activityCoverage?.stale).toBe(true);
    expect(delayed.rows[0].tradeCount).toBe(1);
  });

  it("preserves source PnL and uPnL when local enrichment fails", async () => {
    const { store, source } = await fixture();
    vi.spyOn(store.analytics, "walletMetrics").mockRejectedValue(
      new Error("local unavailable"),
    );
    const result = await source.leaderboard("pnl");
    expect(result.rows[0]).toMatchObject({
      pnlRaw: "42",
      currentUnrealizedPnlRaw: "-123456789012345678901234",
      tradeCount: null,
      volumeUsd: null,
      assetsTraded: null,
    });
    expect(result.accountStale).toBe(false);
    expect(result.activityCoverage?.stale).toBe(true);
  });

  it("refreshes the same activity cache when a PnL page rotates addresses", async () => {
    const { store, source, fetcher } = await fixture();
    await store.recordTrade(trade("first"));
    await store.analytics.backfill();
    const batch = vi.spyOn(store.analytics, "walletMetrics");
    await source.leaderboard("pnl");
    const path = new URL(String(fetcher.mock.calls[0][0]));
    const key = `cache:${path.pathname}${path.search}`;
    const saved = await store.get<{ accounts: { address: string }[] }>(key);
    saved!.value.accounts[0].address = wallet(3);
    await store.put(key, saved!.value, now);
    await store.recordTrade(
      trade("new-ranking", { wallet: wallet(3), instrument: 7 }),
    );
    const result = await source.leaderboard("pnl");
    expect(result.rows[0]).toMatchObject({
      address: wallet(3),
      tradeCount: 1,
      volumeUsd: 100,
      assetsTraded: [7],
    });
    expect(result.activityCoverage?.stale).toBe(false);
    expect(batch).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("adds asset IDs to observed rankings without requesting current accounts", async () => {
    const { store, source, fetcher } = await fixture();
    await store.recordTrade(trade("btc"));
    await store.recordTrade(trade("eth", { instrument: 1, kind: "close" }));
    await store.analytics.backfill();
    for (const metric of ["volume", "trades"] as const) {
      const result = await source.leaderboard(metric);
      expect(result.rows[0]).toMatchObject({
        tradeCount: 2,
        volumeUsd: 200,
        assetsTraded: [0, 1],
        currentUnrealizedPnlRaw: null,
      });
      expect(result).toMatchObject({
        accountReceivedAt: null,
        accountStale: true,
        activityCoverage: { stale: false, windowTo: now },
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
