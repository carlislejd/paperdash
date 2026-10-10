import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { TradeEvent } from "../../../packages/shared/src/types.js";
import { createStore, type Store } from "../src/store.js";
import { RequestGate, Upstream } from "../src/upstream.js";
import {
  analyticsSchemaSql,
  createLocalAnalytics,
} from "../src/analytics-store.js";

const DAY = 86400000;
const now = 1_800_000_030_000;
const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const stores: Store[] = [];
const upstreams: Upstream[] = [];
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(now));
afterEach(async () => {
  for (const upstream of upstreams.splice(0)) await upstream.close();
  for (const store of stores.splice(0)) await store.close();
  vi.restoreAllMocks();
});
async function memory() {
  const store = await createStore({ memory: true, databaseUrl: "" });
  stores.push(store);
  return store;
}
function event(id: string, fields: Partial<TradeEvent> = {}): TradeEvent {
  return {
    id,
    ts: now - 1000,
    wallet: wallet(1),
    instrument: 0,
    side: "long",
    leverage: 10,
    notionalUsd: 100,
    kind: "open",
    pnlUsd: null,
    provenance: "public-stream",
    ...fields,
  };
}
function sourceAccounts() {
  return {
    ok: true,
    count: 2,
    pageInfo: { page: 0, totalPages: 1 },
    summary: {
      uniqueAccounts: 2,
      trackedBalance: "200",
      trackedQueued: "0",
      trackedOpenNotional: "0",
      trackedPaper: "0",
    },
    accounts: [1, 2].map((n) => ({
      address: wallet(n),
      leaderboardName: null,
      currentBalance: "100",
      currentQueued: "0",
      currentOpenNotional: "0",
      currentOpenPositionCount: 7,
      currentUnrealizedPnl: "0",
      realizedPnl: "42",
      totalVolume: "999",
      totalWindowedPnl: "42",
      paperTotal: "0",
      lastActiveTs: Math.floor(now / 1000),
    })),
  };
}
async function directory() {
  const store = await memory();
  await store.put("collector-heartbeat", { at: now, errors: {} });
  await store.put("overview", { status: { stream: "connected" } });
  const fetcher = vi.fn(async () => Response.json(sourceAccounts()));
  const upstream = new Upstream(
    store,
    fetcher as typeof fetch,
    "https://papertrade.test",
    new RequestGate(3, 0),
  );
  upstreams.push(upstream);
  return { store, upstream, fetcher };
}

describe("directory observed trade counts", () => {
  it("distinguishes unavailable observations from an observed zero", async () => {
    const store = await memory();
    expect(await store.analytics.walletCounts([wallet(1)], now)).toMatchObject({
      counts: { [wallet(1)]: null },
      observedFrom: null,
      projectionBackfillComplete: false,
    });
    await store.analytics.backfill();
    expect(
      (await store.analytics.walletCounts([wallet(1)], now)).counts,
    ).toEqual({
      [wallet(1)]: null,
    });
    // A future-dated observation is not evidence of collection before this window.
    await store.recordTrade(event("future-only", { ts: now + 1 }));
    expect(
      (await store.analytics.walletCounts([wallet(2)], now)).counts,
    ).toEqual({
      [wallet(2)]: null,
    });
    await store.recordTrade(event("older", { ts: now - DAY - 1 }));
    expect(
      (await store.analytics.walletCounts([wallet(1), wallet(2)], now)).counts,
    ).toEqual({
      [wallet(1)]: 0,
      [wallet(2)]: 0,
    });
    expect((await store.analytics.walletCounts([], now)).counts).toEqual({});
  });

  it("matches ranking edges and source multiplicity for one bounded address batch", async () => {
    const store = await memory();
    const start = now - DAY;
    for (const trade of [
      event("old", { ts: start - 1 }),
      event("first", { ts: start, kind: "close" }),
      event("first-recent", {
        ts: start,
        kind: "close",
        provenance: "recent-api",
      }),
      event("first-second-stream", { ts: start, kind: "close" }),
      event("interior", { ts: start + 30000, kind: "liq" }),
      event("end", { ts: now }),
      event("future", { ts: now + 1 }),
      event("another", { wallet: wallet(2), ts: now - 60000 }),
      event("outside-directory", { wallet: wallet(100) }),
    ])
      await store.recordTrade(trade);
    // Real partial counts may be exposed before legacy backfill completes;
    // absence still remains unknown during that backfill.
    const pending = await store.analytics.walletCounts(
      [wallet(1), wallet(3)],
      now,
    );
    expect(pending.counts).toEqual({ [wallet(1)]: 4, [wallet(3)]: null });
    expect(pending.projectionBackfillComplete).toBe(false);
    await store.analytics.backfill();
    const addresses = Array.from({ length: 25 }, (_, i) => wallet(i + 1));
    const result = await store.analytics.walletCounts(addresses, now);
    expect(Object.keys(result.counts)).toHaveLength(25);
    expect(result.counts).toMatchObject({
      [wallet(1)]: 4,
      [wallet(2)]: 1,
      [wallet(3)]: 0,
    });
    expect(result.counts[wallet(100)]).toBeUndefined();
    const ranking = await store.analytics.walletActivity("trades", 0, "", now);
    for (const row of ranking.rows.filter((row) =>
      addresses.includes(row.address),
    ))
      expect(result.counts[row.address]).toBe(row.count);
    expect(
      (
        await store.analytics.walletCounts(
          [wallet(10).toUpperCase().replace("0X", "0x"), wallet(10)],
          now,
        )
      ).counts,
    ).toEqual({ [wallet(10)]: 0 });
  });

  it("does not double count a minute-aligned window endpoint", async () => {
    const store = await memory();
    const at = now - 30000;
    for (const ts of [at - DAY - 1, at - DAY, at - 1, at, at + 1])
      await store.recordTrade(event(`time-${ts}`, { ts }));
    await store.analytics.backfill();
    expect(
      (await store.analytics.walletCounts([wallet(1)], at)).counts[wallet(1)],
    ).toBe(3);
  });

  it("returns null rather than rounding unsafe or invalid aggregate counts", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(analyticsSchemaSql("", false));
      db.exec("UPDATE analytics_state SET complete=1 WHERE id=2");
      db.prepare(
        "INSERT INTO analytics_wallet_fingerprints VALUES(?,?,?,?,?)",
      ).run("coverage", wallet(100), now - 1000, 0, 1);
      for (const [n, count] of [
        [1, 9007199254740993n],
        [2, -1],
        [3, 1.5],
        [4, Number.MAX_SAFE_INTEGER],
      ] as const)
        db.prepare("INSERT INTO analytics_wallet_minutes VALUES(?,?,?,?)").run(
          wallet(n),
          Math.floor(now / 60000) * 60000 - 60000,
          count,
          0,
        );
      const analytics = createLocalAnalytics(db, async () => {});
      expect(
        (await analytics.walletCounts([1, 2, 3, 4].map(wallet), now)).counts,
      ).toEqual({
        [wallet(1)]: null,
        [wallet(2)]: null,
        [wallet(3)]: null,
        [wallet(4)]: Number.MAX_SAFE_INTEGER,
      });
    } finally {
      db.close();
    }
  });

  it("rejects requests outside the directory bound or with invalid identifiers", async () => {
    const store = await memory();
    await expect(
      store.analytics.walletCounts(
        Array.from({ length: 26 }, (_, i) => wallet(i)),
        now,
      ),
    ).rejects.toThrow();
    await expect(
      store.analytics.walletCounts(["not-a-wallet"], now),
    ).rejects.toThrow();
    await expect(
      store.analytics.walletCounts([wallet(1)], NaN),
    ).rejects.toThrow();
  });

  it("enriches only directory addresses without additional upstream reads and refreshes counts independently", async () => {
    const { store, upstream, fetcher } = await directory();
    await store.recordTrade(event("one"));
    await store.analytics.backfill();
    const batch = vi.spyOn(store.analytics, "walletCounts");
    let result = await upstream.accounts();
    expect(result.accounts.map((a) => a.tradeCount24h)).toEqual([1, 0]);
    expect(result.accounts[0]).toMatchObject({
      currentOpenPositionCount: 7,
      tradeCount24hAt: now,
      tradeCount24hStale: false,
    });
    expect(result.tradeCountCoverage).toEqual({
      source: "retained-public-observations",
      partial: true,
      observedFrom: now - 1000,
      projectionBackfillComplete: true,
      receivedAt: now,
      stale: false,
    });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledWith([wallet(1), wallet(2)], now);
    await store.recordTrade(event("two", { kind: "liq" }));
    result = await upstream.accounts();
    expect(result.accounts[0].tradeCount24h).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain(
      "/state/leaderboard/accounts?",
    );
  });

  it("keeps observed counts but flags unhealthy collection and incomplete projection", async () => {
    const { store, upstream } = await directory();
    await store.recordTrade(event("one"));
    let result = await upstream.accounts();
    expect(result.accounts.map((a) => a.tradeCount24h)).toEqual([1, null]);
    expect(result.tradeCountCoverage?.stale).toBe(true);
    await store.analytics.backfill();
    await store.put("collector-heartbeat", {
      at: now,
      errors: { "trade-ingestion-gap": "An observation gap was recorded." },
    });
    result = await upstream.accounts();
    expect(result.accounts.map((a) => a.tradeCount24h)).toEqual([1, 0]);
    expect(result.accounts.every((a) => a.tradeCount24hStale)).toBe(true);
    expect(result.stale).toBe(false);
  });

  it("preserves balance and PnL when local counts are unavailable", async () => {
    const { store, upstream } = await directory();
    vi.spyOn(store.analytics, "walletCounts").mockRejectedValue(
      new Error("Database unavailable"),
    );
    const result = await upstream.accounts();
    expect(result.accounts[0]).toMatchObject({
      currentBalance: "100",
      realizedPnl: "42",
      tradeCount24h: null,
      tradeCount24hStale: true,
    });
    expect(result.accounts[0].tradeCount24hAt).toBeUndefined();
    expect(result.tradeCountCoverage).toMatchObject({
      observedFrom: null,
      projectionBackfillComplete: false,
      stale: true,
    });
    expect(result.stale).toBe(false);
  });
});
