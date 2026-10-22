import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assetNotionals,
  houseSchema,
  readAssets,
  refreshAssetAnalytics,
  retainAssetSource,
  sourceUsdRaw,
  type HouseSnapshot,
} from "../src/assets.js";
import { createStore, type Store } from "../src/store.js";
import type { AssetOiSample } from "../../../packages/shared/src/types.js";

const stores: Store[] = [];
let now: number;
beforeEach(() => {
  now = 1_800_000_030_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  vi.restoreAllMocks();
});
async function memory() {
  const store = await createStore({ memory: true, databaseUrl: "" });
  stores.push(store);
  await healthy(store);
  return store;
}
async function healthy(store: Store) {
  await store.put("collector-heartbeat", { at: now, errors: {} }, now);
  await store.put("overview", { status: { stream: "connected" } }, now);
}
function snapshot(at = now): HouseSnapshot {
  return {
    ok: true,
    historyGeneration: "fixture-generation",
    historyRevision: "opaque-publication-epoch",
    sourceAsOfMs: at,
    // The house legend calls bl house-short: it is TRADER-long entry notional.
    head: [at, 150_000, -27.5, 10, 1250.125, 3750.375, 900, 100],
  };
}

describe("independent asset source contract", () => {
  it("maps the opposite house labels to trader sides and keeps USD scale", () => {
    expect(assetNotionals(houseSchema.parse(snapshot()))).toEqual([
      {
        instrument: 0,
        symbol: "BTC",
        openInterest: {
          longRaw: "1250125000000000000000",
          shortRaw: "3750375000000000000000",
          totalRaw: "5000500000000000000000",
          longSharePct: 25,
          shortSharePct: 75,
        },
      },
      {
        instrument: 1,
        symbol: "ETH",
        openInterest: {
          longRaw: "900000000000000000000",
          shortRaw: "100000000000000000000",
          totalRaw: "1000000000000000000000",
          longSharePct: 90,
          shortSharePct: 10,
        },
      },
    ]);
  });

  it("converts source decimals and exponent notation without a float multiply", () => {
    for (const [value, expected] of [
      [0, "0"],
      [0.1, "100000000000000000"],
      [1.234567e-7, "123456700000"],
      [1e-18, "1"],
      [9.99e-19, "0"],
      [123456789012345.67, "123456789012345670000000000000000"],
      [1.234e21, `1234${"0".repeat(36)}`],
    ] as const)
      expect(sourceUsdRaw(value)).toBe(expected);
    for (const value of [-1, NaN, Infinity, -Infinity])
      expect(() => sourceUsdRaw(value)).toThrow("Invalid source notional");
  });

  it("leaves shares undefined for an empty market and handles one-sided OI", () => {
    const source = snapshot();
    source.head.splice(4, 4, 0, 0, 50, 0);
    const [btc, eth] = assetNotionals(source);
    expect(btc.openInterest).toEqual({
      longRaw: "0",
      shortRaw: "0",
      totalRaw: "0",
      longSharePct: null,
      shortSharePct: null,
    });
    expect(eth.openInterest).toMatchObject({
      longSharePct: 100,
      shortSharePct: 0,
    });
  });

  it("rejects incoherent timestamps, malformed heads and negative notionals", () => {
    expect(
      houseSchema.safeParse({ ...snapshot(), sourceAsOfMs: now + 1 }).success,
    ).toBe(false);
    expect(
      houseSchema.safeParse({ ...snapshot(), head: [...snapshot().head, 0] })
        .success,
    ).toBe(false);
    for (const bad of [-1, Infinity, NaN]) {
      const source = snapshot();
      source.head[4] = bad;
      expect(houseSchema.safeParse(source).success).toBe(false);
    }
  });

  it("persists current and chart values consistently and refuses future/backward sources", async () => {
    const store = await memory();
    await expect(
      retainAssetSource(store, snapshot(now + 30_001), now),
    ).rejects.toThrow("future");
    expect(await store.get("asset-source")).toBeNull();
    expect(await store.analytics.samples(0, 0)).toEqual([]);

    await retainAssetSource(store, snapshot(), now);
    const replacement = snapshot(now - 1);
    replacement.head[4] = 999_999;
    await expect(
      retainAssetSource(store, replacement, now + 1),
    ).rejects.toThrow("backward");
    await refreshAssetAnalytics(store, now);
    const response = await readAssets(store, now);
    expect(response.stale).toBe(false);
    expect(response.assets[0].openInterest.longRaw).toBe(
      "1250125000000000000000",
    );
    expect(response.assets[0].history).toEqual([
      {
        instrument: 0,
        time: Math.floor(now / 60000) * 60000,
        longRaw: "1250125000000000000000",
        shortRaw: "3750375000000000000000",
        sourceBlock: null,
        sourceAt: now,
        receivedAt: now,
      },
    ]);
    expect(
      (await store.get<HouseSnapshot>("asset-source"))?.value.sourceAsOfMs,
    ).toBe(now);
  });

  it("marks both delayed collection and a freshly re-read old source as stale", async () => {
    const store = await memory();
    await retainAssetSource(store, snapshot(), now);
    await refreshAssetAnalytics(store, now);
    expect((await readAssets(store, now + 20_001)).stale).toBe(true);

    now += 31_000;
    await healthy(store);
    await retainAssetSource(store, snapshot(now - 31_000), now);
    await refreshAssetAnalytics(store, now);
    const response = await readAssets(store, now);
    expect(response.receivedAt).toBe(now);
    expect(response.sourceAt).toBe(now - 31_000);
    expect(response.stale).toBe(true);
    expect(response.assets[0].history.at(-1)?.sourceAt).toBe(now - 31_000);
    expect(response.assets[0].history.at(-1)?.time).toBe(
      Math.floor((now - 31_000) / 60000) * 60000,
    );
  });

  it("overlays the same-minute head and equal-clock corrections without rereading or rewriting history", async () => {
    const store = await memory();
    await retainAssetSource(store, snapshot(), now);
    await refreshAssetAnalytics(store, now);
    const retained = await store.get("asset-analytics");
    now += 5000;
    const current = snapshot();
    current.head[4] = 10_000_000_000.25;
    current.head[5] = 0;
    current.head[6] = 7_000_000_000.125;
    await retainAssetSource(store, current, now);
    const samples = vi.spyOn(store.analytics, "samples");
    const writes = vi.spyOn(store, "put");

    const response = await readAssets(store, now);
    expect(response.stale).toBe(false);
    for (const asset of response.assets) {
      expect(asset.history).toHaveLength(1);
      expect(asset.history[0]).toMatchObject({
        longRaw: asset.openInterest.longRaw,
        shortRaw: asset.openInterest.shortRaw,
        time: Math.floor(now / 60000) * 60000,
        sourceAt: response.sourceAt,
        receivedAt: response.receivedAt,
      });
    }
    expect(response.assets[0].history[0].longRaw).toBe(
      "10000000000250000000000000000",
    );
    expect(samples).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(await store.get("asset-analytics")).toEqual(retained);

    // A same-clock source correction is authoritative over the old publication.
    current.head[4] = 42;
    await retainAssetSource(store, current, now);
    const corrected = await readAssets(store, now);
    expect(corrected.assets[0].history.at(-1)?.longRaw).toBe(
      "42000000000000000000",
    );
    expect(corrected.assets[0].history.at(-1)?.sourceAt).toBe(now);
  });

  it("appends a bounded current minute without filling gaps or mutating older observations", async () => {
    const store = await memory();
    const points: AssetOiSample[] = Array.from({ length: 300 }, (_, i) => {
      const sourceAt = now - (309 - i) * 60000;
      return {
        instrument: 0,
        time: Math.floor(sourceAt / 60000) * 60000,
        longRaw: String(i + 1),
        shortRaw: "0",
        sourceBlock: null,
        sourceAt,
        receivedAt: sourceAt,
      };
    });
    await store.put(
      "asset-analytics",
      { activity: [], history: { 0: points, 1: [] } },
      now,
    );
    await retainAssetSource(store, snapshot(), now);
    const result = await readAssets(store, now);
    const btc = result.assets[0];
    expect(btc.history).toHaveLength(300);
    expect(btc.history.slice(0, -1)).toEqual(points.slice(1));
    expect(btc.history.at(-1)).toMatchObject({
      sourceAt: now,
      receivedAt: now,
      time: Math.floor(now / 60000) * 60000,
      longRaw: btc.openInterest.longRaw,
      shortRaw: btc.openInterest.shortRaw,
    });
    expect(btc.history.at(-1)!.time - btc.history.at(-2)!.time).toBe(
      10 * 60000,
    );
    // An asset with no prior publication still gets its genuine saved observation.
    expect(result.assets[1].history).toHaveLength(1);
    expect(result.stale).toBe(false);
  });

  it("preserves newer chart evidence when reads straddle a publication and marks the page delayed", async () => {
    const store = await memory();
    await retainAssetSource(store, snapshot(now - 5000), now - 5000);
    const newer: AssetOiSample = {
      instrument: 0,
      time: Math.floor(now / 60000) * 60000,
      longRaw: "99000000000000000000",
      shortRaw: "0",
      sourceBlock: null,
      sourceAt: now,
      receivedAt: now,
    };
    await store.put(
      "asset-analytics",
      { activity: [], history: { 0: [newer], 1: [] } },
      now,
    );
    const response = await readAssets(store, now);
    expect(response.stale).toBe(true);
    expect(response.error).toBe("Showing the last saved asset snapshot.");
    expect(response.sourceAt).toBe(now - 5000);
    expect(response.assets[0].history).toEqual([newer]);
    expect(response.assets[1].history.at(-1)?.sourceAt).toBe(now - 5000);
  });

  it("ignores invalid, future and foreign-asset history instead of replacing a valid head with them", async () => {
    const store = await memory();
    await retainAssetSource(store, snapshot(), now);
    await refreshAssetAnalytics(store, now);
    const baseline = (await readAssets(store, now)).assets[0].history[0];
    const historical = {
      ...baseline,
      sourceAt: now - 60000,
      receivedAt: now - 60000,
      time: baseline.time - 60000,
    };
    await store.put(
      "asset-analytics",
      {
        activity: [],
        history: {
          0: [
            historical,
            { ...baseline, instrument: 1, sourceAt: now + 1000 },
            {
              ...baseline,
              sourceAt: now + 60000,
              time: baseline.time + 60000,
              receivedAt: now + 60000,
            },
            { ...baseline, longRaw: "-1" },
            { ...baseline, longRaw: 4 },
            { ...baseline, sourceAt: now + 0.5 },
            { ...baseline, time: baseline.time + 1 },
          ],
          1: [],
        },
      },
      now,
    );
    const response = await readAssets(store, now);
    expect(response.stale).toBe(false);
    expect(response.assets[0].history).toEqual([historical, baseline]);
    expect(response.assets[1].history.at(-1)?.sourceAt).toBe(now);
  });

  it("does not overlay malformed or far-future saved heads even if cache storage is bypassed", async () => {
    const store = await memory();
    await retainAssetSource(store, snapshot(), now);
    await refreshAssetAnalytics(store, now);
    for (const [value, receivedAt] of [
      [snapshot(now + 30001), now],
      [snapshot(), now + 30001],
      [{ ...snapshot(), sourceAsOfMs: now - 1 }, now],
      [
        { ...snapshot(), head: [...snapshot().head.slice(0, 4), -1, 0, 0, 0] },
        now,
      ],
    ] as const) {
      await store.put("asset-source", value, receivedAt);
      const response = await readAssets(store, now);
      expect(response.assets).toEqual([]);
      expect(response.sourceAt).toBeNull();
      expect(response.receivedAt).toBeNull();
      expect(response.stale).toBe(true);
    }
  });

  it("does not present missing or delayed activity as a fresh complete asset page", async () => {
    const store = await memory();
    await retainAssetSource(store, snapshot(), now);
    expect((await readAssets(store, now)).stale).toBe(true);
    await refreshAssetAnalytics(store, now);
    now += 30_001;
    await healthy(store);
    await retainAssetSource(store, snapshot(), now);
    const response = await readAssets(store, now);
    expect(response.sourceAt).toBe(now);
    expect(response.stale).toBe(true);
    expect(response.error).toBeTruthy();
  });

  it("distinguishes historical intake gaps from current delays without clearing coverage evidence", async () => {
    const store = await memory();
    await retainAssetSource(store, snapshot(), now);
    await refreshAssetAnalytics(store, now);
    const errors = { "trade-ingestion-gap": "known historical gap" };
    const tradeIntake = { gap: { at: now - 60000 } };
    await store.put("collector-heartbeat", { at: now, errors, tradeIntake }, now);
    const fresh = await readAssets(store, now);
    expect(fresh).toMatchObject({ stale: true, freshness: { delayed: false, historyGap: true } });
    expect(fresh.error).toBeUndefined();
    expect((await store.get<{ errors: Record<string, string> }>("collector-heartbeat"))?.value.errors).toEqual(errors);

    await store.put("collector-heartbeat", { at: now, errors: { ...errors, recent: "current outage" }, tradeIntake }, now);
    expect(await readAssets(store, now)).toMatchObject({
      stale: true, freshness: { delayed: true, historyGap: true },
      error: "Trade activity snapshot is delayed.",
    });
    await store.put("collector-heartbeat", { at: now, errors, tradeIntake }, now);
    expect(await readAssets(store, now + 30_001)).toMatchObject({
      stale: true, freshness: { delayed: true, historyGap: true },
    });
  });

  it.each(["stream", "recent", "asset-activity"])(
    "marks a fresh asset projection delayed when collector %s is failing",
    async (failedFeed) => {
      const store = await memory();
      await retainAssetSource(store, snapshot(), now);
      await refreshAssetAnalytics(store, now);
      expect((await readAssets(store, now)).stale).toBe(false);

      await store.put(
        "collector-heartbeat",
        { at: now, errors: { [failedFeed]: "fixture outage" } },
        now,
      );
      const response = await readAssets(store, now);
      expect(response.receivedAt).toBe(now);
      expect(response.activityReceivedAt).toBe(now);
      expect(response.sourceAt).toBe(now);
      expect(response.stale).toBe(true);
      expect(response.error).toBe("Trade activity snapshot is delayed.");
      expect(response.assets[0].openInterest.totalRaw).toBe(
        "5000500000000000000000",
      );

      await healthy(store);
      expect((await readAssets(store, now)).stale).toBe(false);
    },
  );

  it.each(["connecting", "disconnected"])(
    "does not mark activity live while the stream is %s without an error yet",
    async (stream) => {
      const store = await memory();
      await retainAssetSource(store, snapshot(), now);
      await refreshAssetAnalytics(store, now);
      await store.put("overview", { status: { stream } }, now);
      expect((await readAssets(store, now)).stale).toBe(true);
    },
  );
});
