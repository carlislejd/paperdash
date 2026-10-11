import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "../src/store.js";
import { refreshMarkets, readMarket } from "../src/market.js";
import { buildApi } from "../src/api.js";
import {
  sampleFixtures,
  sampleNow as now,
  sampleTrade,
} from "./market-sampling-fixtures.js";
const stores: Store[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
});
async function fixture() {
  const store = await createStore({ memory: true, databaseUrl: "" });
  stores.push(store);
  for (const trade of sampleFixtures()) await store.recordTrade(trade);
  return store;
}

describe("market chart samples across time", () => {
  it("selects actual priced largest executions across all windows and preserves matched-source multiplicity", async () => {
    const store = await fixture();
    const data = await store.market.read(0, now);
    const ids = (window: "5m" | "15m" | "1h") =>
      data.chartSamples[window].trades.map((t) => t.id);
    expect(ids("1h")).toEqual(
      expect.arrayContaining(["hour-edge", "far", "quarter-edge"]),
    );
    expect(ids("15m")).toContain("quarter-edge");
    expect(ids("15m")).not.toContain("far");
    expect(ids("5m")).toEqual(
      expect.arrayContaining([
        "five-edge",
        "inside-five",
        "stream-a",
        "stream-b",
        "overlap-rest-a",
        "overlap-rest-b",
        "now-largest",
        "now-second",
      ]),
    );
    expect(ids("5m")).not.toContain("before-five");
    for (const sample of Object.values(data.chartSamples)) {
      expect(sample.trades.length).toBeLessThanOrEqual(62);
      expect(sample).toMatchObject({
        windowTo: now,
        perBucket: 2,
        selection: "largest-notional-per-time-bucket",
        partial: true,
      });
      const buckets = new Map<number, number>();
      for (const trade of sample.trades) {
        expect(trade.ts).toBeGreaterThanOrEqual(sample.windowFrom);
        expect(trade.ts).toBeLessThanOrEqual(now);
        expect(trade.instrument).toBe(0);
        expect(trade.priceUsd).toBeGreaterThan(0);
        expect(trade.id).not.toMatch(
          /bad-price|unpriced|future|older-hour|overlap-stream/,
        );
        const key = Math.floor(trade.ts / sample.bucketMs);
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
      }
      expect([...buckets.values()].every((n) => n <= 2)).toBe(true);
    }
    expect(
      (await store.market.read(1, now)).chartSamples["5m"].trades.map(
        (t) => t.id,
      ),
    ).toEqual(["eth"]);
  });
  it("retains older chart highlights when the latest400 raw observations crowd the feed", async () => {
    const store = await fixture();
    for (let i = 0; i < 450; i++)
      await store.recordTrade(
        sampleTrade(`new-${i}`, { ts: now - i, notionalUsd: i + 1 }),
      );
    const data = await store.market.read(0, now);
    expect(data.rawTrades).toHaveLength(400);
    expect(data.rawTrades.some((t) => t.id === "far")).toBe(false);
    expect(data.chartSamples["1h"].trades.some((t) => t.id === "far")).toBe(
      true,
    );
    expect(
      data.chartSamples["5m"].trades.some((t) => t.id === "inside-five"),
    ).toBe(true);
  });
  it("breaks equal-notional ties by real timestamp then descending ID", async () => {
    const store = await createStore({ memory: true, databaseUrl: "" });
    stores.push(store);
    for (const value of [
      sampleTrade("a", { ts: now - 2, notionalUsd: 1e10 }),
      sampleTrade("z", { ts: now - 2, notionalUsd: 1e10 }),
      sampleTrade("b", { ts: now - 1, notionalUsd: 1e10 }),
    ])
      await store.recordTrade(value);
    expect(
      (await store.market.read(0, now)).chartSamples["5m"].trades.map(
        (t) => t.id,
      ),
    ).toEqual(["b", "z"]);
  });
  it("serves selected cohorts from saved snapshots with distinct validators and no per-viewer sampling", async () => {
    const store = await fixture();
    vi.spyOn(Date, "now").mockReturnValue(now);
    await store.market.quote({
      instrument: 0,
      priceUsd: 110000,
      sourceAt: now,
      receivedAt: now,
    });
    await store.put("market-connection", { connected: true });
    await store.put("overview", { status: { stream: "connected" } });
    await store.put("collector-heartbeat", { at: now, errors: {} });
    await refreshMarkets(store, now);
    const spy = vi.spyOn(store.market, "read");
    const app = await buildApi(store, undefined, undefined, { logger: false });
    try {
      const five = await app.inject("/api/assets/0/market?window=5m"),
        hour = await app.inject("/api/assets/0/market?window=1h");
      expect(five.statusCode).toBe(200);
      expect(hour.statusCode).toBe(200);
      expect(five.json().chartSample).toMatchObject({
        windowFrom: now - 300000,
        bucketMs: 10000,
      });
      expect(hour.json().chartSample).toMatchObject({
        windowFrom: now - 3600000,
        bucketMs: 120000,
      });
      expect(five.json()).not.toHaveProperty("chartSamples");
      expect(hour.json().trades).toEqual(five.json().trades);
      expect(five.headers.etag).not.toBe(hour.headers.etag);
      expect(
        (await app.inject("/api/assets/0/market")).json().chartSample,
      ).toEqual(hour.json().chartSample);
      expect(
        (await app.inject("/api/assets/0/market?window=6h")).statusCode,
      ).toBe(400);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
    const saved = await store.get<Record<string, unknown>>("market:0");
    delete saved!.value.chartSamples;
    await store.put("market:0", saved!.value, now);
    expect((await readMarket(store, 0, now, "5m")).chartSample).toBeUndefined();
  });
});
