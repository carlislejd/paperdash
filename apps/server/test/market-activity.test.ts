import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "../src/store.js";
import { readMarket, refreshMarkets } from "../src/market.js";
import { buildApi } from "../src/api.js";
import { sampleNow as now, sampleTrade } from "./market-sampling-fixtures.js";
import { seedActivityMarket, segmentWallet, segmentAccount } from "./market-segment-fixtures.js";

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

describe("asset trade activities", () => {
  it("classifies close-only and liquidated wallets by lifetime profit with activity-scoped coverage", async () => {
    const store = await setup();
    await seedActivityMarket(store);
    const data = await store.market.read(0, now);
    const all = data.activities.all.profitableByMinPnl[1000];
    const exits = data.activities.exits.profitableByMinPnl[1000];
    const entries = data.activities.entries.profitableByMinPnl[1000];
    expect(all.coverage).toMatchObject({ activity: "all", observedWallets: 6, classifiedWallets: 5, profitableWallets: 4, unknownWallets: 1 });
    expect(exits.coverage).toMatchObject({ activity: "exits", observedWallets: 5, classifiedWallets: 4, profitableWallets: 3, unknownWallets: 1 });
    expect(entries.coverage).toMatchObject({ activity: "entries", observedWallets: 1, classifiedWallets: 1, profitableWallets: 1, unknownWallets: 0 });
    expect(exits.rawTrades.map((t) => t.id).sort()).toEqual(["profitable-exit", "profitable-liq", "unpriced-exit"]);
    for (const sample of Object.values(exits.chartSamples)) {
      expect(sample.trades.map((t) => [t.kind, t.priceUsd])).toEqual([["liq", 112000], ["close", 111000]]);
      expect(sample.trades.every((t) => t.pnlUsd! < 0)).toBe(true);
    }
    expect(entries.rawTrades.map((t) => t.id)).toEqual(["entry"]);
    expect(data.profitable.rawTrades.map((t) => t.id)).toEqual(["entry"]);
    expect(data.profitable.coverage).not.toHaveProperty("activity");
  });

  it("filters exits before the feed and chart caps so heavy entries cannot crowd them out", async () => {
    const store = await setup();
    await seedActivityMarket(store);
    for (let i = 0; i < 450; i++) await store.recordTrade(sampleTrade(`huge-entry:${i}`, {
      wallet: segmentWallet(31), ts: now - i, notionalUsd: 1e13 + i,
    }));
    const data = await store.market.read(0, now);
    expect(data.rawTrades).toHaveLength(400);
    expect(data.rawTrades.every((t) => t.kind === "open")).toBe(true);
    expect(data.activities.exits.rawTrades).toHaveLength(5);
    expect(data.activities.exits.tradesCapped).toBe(false);
    expect(data.activities.exits.profitableByMinPnl[1000].rawTrades).toHaveLength(3);
    for (const sample of Object.values(data.activities.exits.profitableByMinPnl[1000].chartSamples))
      expect(sample.trades.map((t) => t.id)).toEqual(["profitable-liq", "profitable-exit"]);
  });

  it("combines entries and exits into the exact global top sample and latest feed", async () => {
    const store = await setup();
    await store.put(`account-summary:${segmentWallet(31)}`, segmentAccount(31, (1000n * 10n ** 18n).toString()), now);
    const trades = Array.from({ length: 450 }, (_, n) => sampleTrade(`mixed:${n}`, {
      wallet: segmentWallet(31), kind: (["open", "close", "liq"] as const)[n % 3],
      ts: now - n * 1000, notionalUsd: (n % 7) * 100,
    }));
    for (const trade of trades) await store.recordTrade(trade);
    const data = await store.market.read(0, now);
    for (const view of [data.activities.all, data.activities.all.profitableByMinPnl[1000]]) {
      expect(view.rawTrades.map((trade) => trade.id)).toEqual(trades.slice(0, 400).map((trade) => trade.id));
      for (const sample of Object.values(view.chartSamples)) {
        const ordered = trades.filter((trade) => trade.ts >= sample.windowFrom)
          .sort((a, b) => b.notionalUsd - a.notionalUsd || b.ts - a.ts || b.id.localeCompare(a.id));
        const chosen = ordered.filter((trade, index) => ordered.slice(0, index).filter((other) =>
          Math.floor(other.ts / sample.bucketMs) === Math.floor(trade.ts / sample.bucketMs)).length < 2);
        expect(sample.trades.map((trade) => trade.id).sort()).toEqual(chosen.map((trade) => trade.id).sort());
      }
    }
    // A wallet active on both sides of the toggle is counted only once in All.
    expect(data.activities.all.profitableByMinPnl[1000].coverage).toMatchObject({ observedWallets: 1, classifiedWallets: 1 });
  });

  it("serves fixed nested snapshots without extra writes or viewer queries and retains legacy responses", async () => {
    const store = await setup();
    vi.spyOn(Date, "now").mockReturnValue(now);
    await seedActivityMarket(store);
    const put = vi.spyOn(store, "put");
    await refreshMarkets(store, now);
    expect(put).toHaveBeenCalledTimes(10);
    const read = vi.spyOn(store.market, "read");
    const app = await buildApi(store, undefined, undefined, { logger: false });
    try {
      const tags = new Set();
      for (const activity of ["all", "entries", "exits"] as const) {
        const response = await app.inject(`/api/assets/0/market?window=5m&segment=profitable&minPnl=1000&activity=${activity}`);
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body).toMatchObject({ activity, segmentCoverage: { activity } });
        expect(body.trades).toHaveLength(({ all: 4, entries: 1, exits: 3 })[activity]);
        expect(body).not.toHaveProperty("activityViews");
        expect(body).not.toHaveProperty("chartSamples");
        expect(response.headers["cdn-cache-control"]).toBe("public, s-maxage=1, must-revalidate");
        tags.add(response.headers.etag);
      }
      expect(tags.size).toBe(3);
      for (const activity of ["all", "entries", "exits"]) {
        const response = await app.inject(`/api/assets/0/market?window=15m&activity=${activity}`);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ activity, segment: "all" });
        expect(response.headers["cdn-cache-control"]).toBe("public, s-maxage=1, must-revalidate");
      }
      const legacy = (await app.inject("/api/assets/0/market?segment=profitable&minPnl=1000")).json();
      expect(legacy.trades.map((t: { id: string }) => t.id)).toEqual(["entry"]);
      expect(legacy).not.toHaveProperty("activity");
      expect(legacy.segmentCoverage).not.toHaveProperty("activity");
      for (const activity of ["close", "liq", "unknown", "", "all&activity=exits"])
        expect((await app.inject(`/api/assets/0/market?activity=${activity}`)).statusCode).toBe(400);
      expect(read).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("reads versioned legacy references and older nested snapshots but rejects ambiguous nulls", async () => {
    const store = await setup();
    await seedActivityMarket(store);
    await refreshMarkets(store, now);
    const key = "market:0:profitable:min-pnl:1000";
    const saved = (await store.get<Record<string, any>>(key))!.value;
    expect(saved).toMatchObject({ activityViewsVersion: 1, activityViews: { entries: null } });
    const referenced = await readMarket(store, 0, now, "5m", "profitable", 1000, "entries");
    expect(referenced.trades.map((trade) => trade.id)).toEqual(["entry"]);
    expect(referenced.segmentCoverage).toMatchObject({ activity: "entries", observedWallets: 1 });
    expect(referenced).not.toHaveProperty("activityViewsVersion");
    const { activityViewsVersion: _version, ...old } = saved;
    const fullView = { activity: "entries", trades: saved.trades, chartSamples: saved.chartSamples,
      tradesCapped: saved.coverage.tradesCapped, segmentCoverage: { ...saved.segmentCoverage, activity: "entries" } };
    await store.put(key, { ...old, activityViews: { ...old.activityViews, entries: fullView } }, now);
    expect(await readMarket(store, 0, now, "5m", "profitable", 1000, "entries")).toEqual(referenced);
    for (const version of [undefined, 0, 2]) {
      await store.put(key, { ...saved, activityViewsVersion: version }, now);
      const unknown = await readMarket(store, 0, now, "5m", "profitable", 1000, "entries");
      expect(unknown).toMatchObject({ trades: [], stale: true });
      expect(unknown.chartSample).toBeUndefined();
    }
    await store.put(key, { ...saved, activityViews: { ...saved.activityViews, exits: null } }, now);
    expect(await readMarket(store, 0, now, "5m", "profitable", 1000, "exits")).toMatchObject({ trades: [], stale: true });
    expect((await readMarket(store, 0, now, "5m", "profitable", 1000)).trades.map((trade) => trade.id)).toEqual(["entry"]);
  });

  it("fails closed for old or mismatched activity snapshots without relabeling entries as exits", async () => {
    const store = await setup();
    await seedActivityMarket(store);
    await refreshMarkets(store, now);
    const key = "market:0:profitable:min-pnl:1000";
    const saved = (await store.get<Record<string, any>>(key))!.value;
    const { activityViews, ...legacy } = saved;
    await store.put(key, legacy, now);
    const missing = await readMarket(store, 0, now, "5m", "profitable", 1000, "exits");
    expect(missing).toMatchObject({ activity: "exits", trades: [], stale: true });
    expect(missing.chartSample).toBeUndefined();
    expect(missing.segmentCoverage).toBeUndefined();
    await store.put(key, { ...saved, activityViews: {
      ...activityViews, exits: { ...activityViews.exits, segmentCoverage: { ...activityViews.exits.segmentCoverage, activity: "entries" } },
    } }, now);
    const mismatch = await readMarket(store, 0, now, "5m", "profitable", 1000, "exits");
    expect(mismatch).toMatchObject({ activity: "exits", trades: [], stale: true });
    expect(mismatch.chartSample).toBeUndefined();
    expect(mismatch.segmentCoverage).toBeUndefined();
    const expired = await readMarket(store, 0, now + 60001, "5m", "profitable", 1000, "all");
    expect(expired).toMatchObject({ activity: "all", trades: [], stale: true });
  });
});
