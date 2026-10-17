import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "../src/store.js";
import { readMarket, refreshMarkets } from "../src/market.js";
import { buildApi } from "../src/api.js";
import { sampleNow as now, sampleTrade } from "./market-sampling-fixtures.js";
import { seedProfitableMarket, seedProfitFloors, segmentWallet } from "./market-segment-fixtures.js";
import { marketMinPnlUsd } from "../../../packages/shared/src/types.js";

const stores: Store[] = [];
async function setup() {
  const store = await createStore({ memory: true, databaseUrl: "" });
  stores.push(store);
  return store;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
});

describe("profitable trader market segment", () => {
  it("classifies only fresh positive lifetime trading P&L before sampling smaller entries", async () => {
    const store = await setup();
    const counts = await seedProfitableMarket(store);
    const data = await store.market.read(0, now);
    expect(data.profitable.coverage).toEqual({
      basis: "positive-lifetime-realized-trading-pnl",
      minPnlUsd: 0,
      classifiedAt: now,
      maxAccountAgeMs: 300000,
      ...counts,
      oldestAccountReceivedAt: now - 300000,
      newestAccountReceivedAt: now,
    });
    expect(data.profitable.rawTrades.map((trade) => trade.id).sort()).toEqual([
      "wallet-1", "wallet-10", "wallet-11", "wallet-2",
    ]);
    for (const sample of Object.values(data.profitable.chartSamples)) {
      expect(sample.trades.map((trade) => trade.id)).toEqual(["wallet-2", "wallet-1"]);
      expect(sample.trades.every((trade) => trade.kind === "open")).toBe(true);
    }
    expect(data.chartSamples["5m"].trades.map((trade) => trade.id)).toEqual([
      "profitable-liquidation", "profitable-close",
    ]);
  });

  it("filters before the latest400 feed cap and preserves all-trader behavior", async () => {
    const store = await setup();
    await seedProfitableMarket(store);
    for (let i = 0; i < 450; i++) await store.recordTrade(sampleTrade(`losing-${i}`, {
      wallet: segmentWallet(3), ts: now - i, notionalUsd: i + 1,
    }));
    const data = await store.market.read(0, now);
    expect(data.rawTrades).toHaveLength(400);
    expect(data.rawTrades.every((trade) => trade.id.startsWith("losing-"))).toBe(true);
    expect(data.profitable.rawTrades).toHaveLength(4);
    expect(data.profitable.tradesCapped).toBe(false);
  });

  it("applies exact dollar floors before sampling and the feed cap, independently of execution size", async () => {
    const store = await setup();
    await seedProfitFloors(store);
    for (let i = 0; i < 450; i++) await store.recordTrade(sampleTrade(`small-profit-${i}`, {
      wallet: segmentWallet(21), ts: now - i, notionalUsd: 1e13 + i,
    }));
    const data = await store.market.read(0, now);
    expect(data.profitable.rawTrades).toHaveLength(400);
    expect(data.profitable.rawTrades.every((trade) => trade.id.startsWith("small-profit-"))).toBe(true);
    const expected = {
      1000: ["floor-23", "floor-24", "floor-25", "floor-26", "floor-27", "floor-28"],
      10000: ["floor-25", "floor-26", "floor-27", "floor-28"],
      100000: ["floor-26", "floor-27"],
    };
    for (const minPnl of [1000, 10000, 100000] as const) {
      const cohort = data.profitableByMinPnl[minPnl];
      expect(cohort.rawTrades.map((trade) => trade.id).sort()).toEqual(expected[minPnl]);
      expect(cohort.coverage).toMatchObject({
        minPnlUsd: minPnl, observedWallets: 8, classifiedWallets: 8,
        profitableWallets: expected[minPnl].length, unknownWallets: 0,
      });
      expect(cohort.tradesCapped).toBe(false);
      for (const sample of Object.values(cohort.chartSamples))
        expect(sample.trades.map((trade) => trade.id).sort()).toEqual(
          minPnl === 100000 ? ["floor-26", "floor-27"] : ["floor-26", "floor-28"],
        );
    }
  });

  it("serves distinct bounded saved floor variants and rejects arbitrary profit filters", async () => {
    const store = await setup();
    vi.spyOn(Date, "now").mockReturnValue(now);
    await seedProfitFloors(store);
    await refreshMarkets(store, now);
    const read = vi.spyOn(store.market, "read");
    const app = await buildApi(store, undefined, undefined, { logger: false });
    try {
      const etags = new Set();
      for (const minPnl of marketMinPnlUsd) {
        const response = await app.inject(`/api/assets/0/market?window=5m&segment=profitable&minPnl=${minPnl}`);
        expect(response.statusCode).toBe(200);
        expect(response.json().segmentCoverage.minPnlUsd).toBe(minPnl);
        expect(response.json().trades).toHaveLength(({ 0: 8, 1000: 6, 10000: 4, 100000: 2 })[minPnl]);
        etags.add(response.headers.etag);
      }
      expect(etags.size).toBe(4);
      for (const minPnl of ["-1", "1", "5000", "1000.0", "1e3", "NaN", "Infinity", "1000&minPnl=10000"])
        expect((await app.inject(`/api/assets/0/market?segment=profitable&minPnl=${minPnl}`)).statusCode).toBe(400);
      expect((await app.inject("/api/assets/0/market?segment=all&minPnl=1000")).statusCode).toBe(400);
      expect(read).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("publishes empty floor coverage and fails closed for mismatched snapshot floors", async () => {
    const store = await setup();
    await refreshMarkets(store, now);
    for (const floor of marketMinPnlUsd)
      expect((await readMarket(store, 0, now, "5m", "profitable", floor)).segmentCoverage)
        .toMatchObject({ minPnlUsd: floor, observedWallets: 0, profitableWallets: 0 });
    await seedProfitFloors(store);
    await refreshMarkets(store, now);
    const key = "market:0:profitable:min-pnl:1000";
    const saved = (await store.get<import("../../../packages/shared/src/types.js").AssetMarketResponse>(key))!;
    await store.put(key, { ...saved.value, segmentCoverage: { ...saved.value.segmentCoverage!, minPnlUsd: 0 } }, now);
    const mismatch = await readMarket(store, 0, now, "5m", "profitable", 1000);
    expect(mismatch).toMatchObject({ trades: [], stale: true });
    expect(mismatch.segmentCoverage).toBeUndefined();
    expect(mismatch.chartSample).toBeUndefined();
  });

  it("serves separate saved cohorts without viewer sampling and rejects invalid segment queries", async () => {
    const store = await setup();
    vi.spyOn(Date, "now").mockReturnValue(now);
    await seedProfitableMarket(store);
    await refreshMarkets(store, now);
    const read = vi.spyOn(store.market, "read");
    const app = await buildApi(store, undefined, undefined, { logger: false });
    try {
      const all = await app.inject("/api/assets/0/market?window=5m");
      const profitable = await app.inject("/api/assets/0/market?window=5m&segment=profitable");
      expect(all.statusCode).toBe(200);
      expect(profitable.statusCode).toBe(200);
      expect(profitable.json()).toMatchObject({ segment: "profitable", segmentCoverage: { profitableWallets: 4 } });
      expect(profitable.json().trades).toHaveLength(4);
      expect(profitable.json().chartSample.trades.map((t: { id: string }) => t.id)).toEqual(["wallet-2", "wallet-1"]);
      expect(profitable.headers.etag).not.toEqual(all.headers.etag);
      expect(profitable.json()).not.toHaveProperty("chartSamples");
      expect((await app.inject("/api/assets/0/market?segment=unknown")).statusCode).toBe(400);
      expect(read).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("fails closed before cohort publication and when classification expires or comes from the future", async () => {
    const store = await setup();
    await store.put("market:0", { trades: [{ id: "legacy" }] }, now);
    const missing = await readMarket(store, 0, now, "5m", "profitable");
    expect(missing).toMatchObject({ segment: "profitable", trades: [], stale: true });
    expect(missing.segmentCoverage).toBeUndefined();
    await seedProfitableMarket(store);
    await refreshMarkets(store, now);
    expect((await readMarket(store, 0, now + 60000, "5m", "profitable")).trades).toHaveLength(4);
    for (const at of [now + 60001, now - 1]) {
      const expired = await readMarket(store, 0, at, "5m", "profitable");
      expect(expired).toMatchObject({ segment: "profitable", trades: [], stale: true });
      expect(expired.chartSample).toBeUndefined();
      expect(expired.segmentCoverage).toBeUndefined();
    }
  });
});
