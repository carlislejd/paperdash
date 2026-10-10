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
    ] as const) expect(sourceUsdRaw(value)).toBe(expected);
    for (const value of [-1, NaN, Infinity, -Infinity])
      expect(() => sourceUsdRaw(value)).toThrow("Invalid source notional");
  });

  it("leaves shares undefined for an empty market and handles one-sided OI", () => {
    const source = snapshot();
    source.head.splice(4, 4, 0, 0, 50, 0);
    const [btc, eth] = assetNotionals(source);
    expect(btc.openInterest).toEqual({ longRaw: "0", shortRaw: "0", totalRaw: "0", longSharePct: null, shortSharePct: null });
    expect(eth.openInterest).toMatchObject({ longSharePct: 100, shortSharePct: 0 });
  });

  it("rejects incoherent timestamps, malformed heads and negative notionals", () => {
    expect(houseSchema.safeParse({ ...snapshot(), sourceAsOfMs: now + 1 }).success).toBe(false);
    expect(houseSchema.safeParse({ ...snapshot(), head: [...snapshot().head, 0] }).success).toBe(false);
    for (const bad of [-1, Infinity, NaN]) {
      const source = snapshot();
      source.head[4] = bad;
      expect(houseSchema.safeParse(source).success).toBe(false);
    }
  });

  it("persists current and chart values consistently and refuses future/backward sources", async () => {
    const store = await memory();
    await expect(retainAssetSource(store, snapshot(now + 30_001), now)).rejects.toThrow("future");
    expect(await store.get("asset-source")).toBeNull();
    expect(await store.analytics.samples(0, 0)).toEqual([]);

    await retainAssetSource(store, snapshot(), now);
    const replacement = snapshot(now - 1);
    replacement.head[4] = 999_999;
    await expect(retainAssetSource(store, replacement, now + 1)).rejects.toThrow("backward");
    await refreshAssetAnalytics(store, now);
    const response = await readAssets(store, now);
    expect(response.stale).toBe(false);
    expect(response.assets[0].openInterest.longRaw).toBe("1250125000000000000000");
    expect(response.assets[0].history).toEqual([
      {
        instrument: 0, time: Math.floor(now / 60000) * 60000,
        longRaw: "1250125000000000000000", shortRaw: "3750375000000000000000",
        sourceBlock: null, sourceAt: now, receivedAt: now,
      },
    ]);
    expect((await store.get<HouseSnapshot>("asset-source"))?.value.sourceAsOfMs).toBe(now);
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

  it.each(["stream", "recent", "asset-activity"])(
    "marks a fresh asset projection delayed when collector %s is failing",
    async (failedFeed) => {
      const store = await memory();
      await retainAssetSource(store, snapshot(), now);
      await refreshAssetAnalytics(store, now);
      expect((await readAssets(store, now)).stale).toBe(false);

      await store.put("collector-heartbeat", { at: now, errors: { [failedFeed]: "fixture outage" } }, now);
      const response = await readAssets(store, now);
      expect(response.receivedAt).toBe(now);
      expect(response.activityReceivedAt).toBe(now);
      expect(response.sourceAt).toBe(now);
      expect(response.stale).toBe(true);
      expect(response.error).toBe("Trade activity snapshot is delayed.");
      expect(response.assets[0].openInterest.totalRaw).toBe("5000500000000000000000");

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
