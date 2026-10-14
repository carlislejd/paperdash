import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "../src/store.js";
import { readWalletMarginRisk as cachedReadWalletMarginRisk } from "../src/wallet-risk.js";
import { PublicReadCache } from "../src/public-read-cache.js";
import { Upstream } from "../src/upstream.js";
import { buildApi } from "../src/api.js";
import type { WalletSnapshot } from "../../../packages/shared/src/types.js";

const at = 1800000000000;
const address = `0x${"a".repeat(40)}`;
const stores: Store[] = [];
// Clock/validation cases read their freshly edited fixtures directly; dedicated
// tests below exercise the production shared-cache behavior and expiry.
const uncached = new PublicReadCache({
  ttl: 0,
  maxEntries: 1,
  maxBytes: 65536,
  maxPending: 1,
});
const readWalletMarginRisk = (
  store: Store,
  address: string,
  snapshot: Parameters<typeof cachedReadWalletMarginRisk>[2],
  now: number,
  error?: string,
) => cachedReadWalletMarginRisk(store, address, snapshot, now, error, uncached);
const snapshot = (): WalletSnapshot => ({
  address,
  indexedThroughBlock: 123,
  indexedThroughTimestamp: at / 1000,
  accountRevision: 7,
  balance: "0",
  queued: "0",
  locked: "10000000000000000000",
  lifetime: {
    depositedRaw: "0",
    withdrawnRaw: "0",
    realizedPnlRaw: "0",
    feesPaidRaw: "0",
    tradedNotionalRaw: "0",
    paperRewardsClaimedRaw: "0",
  },
  paper: { balance: "0", staked: "0" },
  openPositions: [
    [
      "1",
      0,
      true,
      false,
      "1000000",
      "10000000000000000001",
      100,
      "995000",
      at - 60000,
      null,
    ],
  ],
});
const observed = () => ({
  value: snapshot(),
  receivedAt: at - 100,
  stale: false,
});
const quote = (instrument = 0, priceUsd = 100000.25) => ({
  instrument,
  // Deliberately includes old composite chart staleness: only quote-specific health applies here.
  stale: true,
  price: { instrument, priceUsd, sourceAt: at - 50, receivedAt: at - 20 },
});
async function memory() {
  const store = await createStore({ memory: true, databaseUrl: "" });
  stores.push(store);
  await store.put("market:0", quote(), at);
  await store.put("market:1", quote(1, 2500), at);
  // This timestamp is a connection transition, not a periodic heartbeat.
  await store.put(
    "market-connection",
    { connected: true, at: at - 86400000 },
    at - 86400000,
  );
  await store.put(
    "collector-heartbeat",
    { at, errors: { stream: "unrelated trade failure" } },
    at,
  );
  return store;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
});

describe("wallet margin-risk saved quote adapter", () => {
  it("shares one compact head read across concurrent wallets and rereads after expiry", async () => {
    const store = await memory();
    const clock = vi.spyOn(Date, "now").mockReturnValue(at);
    const other = `0x${"b".repeat(40)}`;
    const original = store.getMany.bind(store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vi.spyOn(store, "getMany").mockImplementation(async (keys) => {
      await gate;
      return original(keys);
    });
    await store.put(
      "market:0",
      { ...quote(), points: "large chart".repeat(10000) },
      at,
    );
    const first = cachedReadWalletMarginRisk(store, address, observed(), at);
    const second = cachedReadWalletMarginRisk(
      store,
      other,
      { ...observed(), value: { ...snapshot(), address: other } },
      at,
    );
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    release();
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.address)).toEqual([address, other]);
    expect(
      results.every((result) => result.references[0].priceUsd === 100000.25),
    ).toBe(true);
    clock.mockReturnValue(at + 999);
    await store.put("market:0", quote(0, 100001), at + 999);
    const cached = await cachedReadWalletMarginRisk(
      store,
      address,
      observed(),
      at + 999,
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(cached.references[0].priceUsd).toBe(100000.25);
    expect(cached.references[0].sourceAt).toBe(at - 50);
    clock.mockReturnValue(at + 1001);
    const refreshed = await cachedReadWalletMarginRisk(
      store,
      address,
      observed(),
      at + 1001,
    );
    expect(read).toHaveBeenCalledTimes(2);
    expect(refreshed.references[0].priceUsd).toBe(100001);
  });
  it("recomputes quote age on cached heads and never caches a failed read", async () => {
    const store = await memory();
    vi.spyOn(Date, "now").mockReturnValue(at);
    // Source starts just inside its freshness bound while all receipt clocks are current.
    await store.put(
      "market:0",
      { ...quote(), price: { ...quote().price, sourceAt: at - 29900 } },
      at,
    );
    const read = vi.spyOn(store, "getMany");
    expect(
      (await cachedReadWalletMarginRisk(store, address, observed(), at))
        .references[0].stale,
    ).toBe(false);
    expect(
      (await cachedReadWalletMarginRisk(store, address, observed(), at + 200))
        .references[0].stale,
    ).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    const failedStore = await memory();
    const failure = vi
      .spyOn(failedStore, "getMany")
      .mockRejectedValueOnce(new Error("unavailable"));
    expect(
      (await cachedReadWalletMarginRisk(failedStore, address, observed(), at))
        .stale,
    ).toBe(true);
    expect(
      (await cachedReadWalletMarginRisk(failedStore, address, observed(), at))
        .stale,
    ).toBe(false);
    expect(failure).toHaveBeenCalledTimes(2);
  });
  it("uses one bounded bulk read without market history scans, preserving independent clocks", async () => {
    const store = await memory();
    const read = vi.spyOn(store, "getMany");
    const history = vi.spyOn(store.market, "read");
    const result = await readWalletMarginRisk(store, address, observed(), at);
    expect(read).toHaveBeenCalledExactlyOnceWith([
      "market:0",
      "market:1",
      "market-connection",
      "collector-heartbeat",
    ]);
    expect(history).not.toHaveBeenCalled();
    expect(result.snapshot).toEqual({
      sourceAt: at,
      receivedAt: at - 100,
      indexedThroughBlock: 123,
      accountRevision: 7,
      stale: false,
    });
    expect(result.stale).toBe(false);
    expect(result.references[0]).toMatchObject({
      source: "hyperliquid-bbo-mid",
      priceUsd: 100000.25,
      priceRaw: "100000250000000000000000",
      sourceAt: at - 50,
      receivedAt: at - 20,
      stale: false,
    });
    expect(result.assets[0].totals.initialMarginRaw).toBe(
      "10000000000000000001",
    );
    expect(result.assets[0].bands).not.toBeNull();
  });
  it.each(["market-quotes", "asset-live"])(
    "keeps valid reference scenarios visibly stale when %s fails",
    async (loop) => {
      const store = await memory();
      await store.put(
        "collector-heartbeat",
        { at, errors: { [loop]: "failed" } },
        at,
      );
      const result = await readWalletMarginRisk(store, address, observed(), at);
      expect(result.stale).toBe(true);
      expect(result.references[0].stale).toBe(true);
      expect(result.assets[0].bands).not.toBeNull();
      expect(result.snapshot?.stale).toBe(false);
    },
  );
  it.each(["source", "receipt", "snapshot", "heartbeat", "connection"])(
    "marks a %s quote-health delay without re-aging prices",
    async (part) => {
      const store = await memory();
      const value = quote();
      if (part === "source") value.price.sourceAt = at - 30001;
      if (part === "receipt") {
        value.price.receivedAt = at - 30001;
        value.price.sourceAt = at - 30001;
      }
      await store.put("market:0", value, at);
      if (part === "heartbeat")
        await store.put("collector-heartbeat", { at: at - 30001 }, at);
      if (part === "connection")
        await store.put("market-connection", { connected: false, at }, at);
      const result = await readWalletMarginRisk(
        store,
        address,
        observed(),
        part === "snapshot" ? at + 15001 : at,
      );
      expect(result.references[0]).toMatchObject({
        stale: true,
        sourceAt: value.price.sourceAt,
        receivedAt: value.price.receivedAt,
      });
      expect(result.stale).toBe(true);
    },
  );
  it("rejects invalid/future references and never substitutes execution or wallet entry prices", async () => {
    const store = await memory();
    for (const bad of [
      { ...quote(), instrument: 1 },
      { ...quote(), price: { ...quote().price, instrument: 1 } },
      { ...quote(), price: { ...quote().price, priceUsd: 0 } },
      { ...quote(), price: { ...quote().price, priceUsd: -1 } },
      { ...quote(), price: { ...quote().price, sourceAt: at + 30001 } },
      { ...quote(), price: { ...quote().price, receivedAt: at + 30001 } },
      { ...quote(), price: { ...quote().price, receivedAt: at - 60000 } },
      { ...quote(), price: { ...quote().price, sourceAt: "1800000000000" } },
      { ...quote(), price: null },
    ]) {
      await store.put("market:0", bad, at);
      const result = await readWalletMarginRisk(store, address, observed(), at);
      expect(result.references.some((r) => r.instrumentId === 0)).toBe(false);
      expect(result.assets[0]).toMatchObject({
        reference: null,
        bands: null,
        nearest: [],
        totals: { initialMarginRaw: "10000000000000000001" },
      });
      expect(result.stale).toBe(true);
    }
  });
  it("retains snapshot errors and staleness independently of fresh quotes", async () => {
    const store = await memory();
    for (const input of [
      { ...observed(), stale: true },
      { ...observed(), error: "Saved account observation." },
      { ...observed(), receivedAt: at - 30001 },
      {
        ...observed(),
        value: { ...snapshot(), indexedThroughTimestamp: (at - 31000) / 1000 },
      },
    ]) {
      const result = await readWalletMarginRisk(store, address, input, at);
      expect(result.snapshot?.stale).toBe(true);
      expect(result.stale).toBe(true);
      expect(result.references.every((r) => !r.stale)).toBe(true);
    }
  });
  it("returns a true empty snapshot as zero without quotes, but missing snapshot as unavailable", async () => {
    const store = await memory();
    const read = vi
      .spyOn(store, "getMany")
      .mockRejectedValue(new Error("unavailable"));
    const empty = await readWalletMarginRisk(
      store,
      address,
      { ...observed(), value: { ...snapshot(), openPositions: [] } },
      at,
    );
    expect(empty).toMatchObject({
      stale: false,
      assets: [],
      coverage: { snapshotPositionCount: 0, includedCount: 0 },
    });
    const missing = await readWalletMarginRisk(
      store,
      address,
      null,
      at,
      "Wallet observation is pending.",
    );
    expect(missing).toMatchObject({
      stale: true,
      snapshot: null,
      assets: [],
      coverage: { snapshotPositionCount: null },
      error: "Wallet observation is pending.",
    });
    expect(read).not.toHaveBeenCalled();
  });
  it("keeps retained position totals when quote storage fails", async () => {
    const store = await memory();
    vi.spyOn(store, "getMany").mockRejectedValue(
      new Error("private storage diagnostic"),
    );
    const result = await readWalletMarginRisk(store, address, observed(), at);
    expect(result).toMatchObject({
      stale: true,
      snapshot: { accountRevision: 7 },
      error: "Market references are temporarily unavailable.",
    });
    expect(result.assets[0]).toMatchObject({
      bands: null,
      nearest: [],
      totals: { positionCount: 1 },
    });
    expect(JSON.stringify(result)).not.toContain("private storage diagnostic");
  });
});

describe("wallet response margin-risk enrichment", () => {
  it("uses exactly the same loaded wallet revision and its own receipt time, with no new source fetch", async () => {
    const store = await memory();
    vi.spyOn(Date, "now").mockReturnValue(at);
    const fetcher = vi.fn<typeof fetch>();
    const upstream = new Upstream(store, fetcher);
    const input = observed();
    const snapshotCall = vi
      .spyOn(upstream, "snapshot")
      .mockResolvedValue(input);
    vi.spyOn(upstream, "history").mockResolvedValue({
      value: { items: [], nextCursor: null },
      receivedAt: at - 3600000,
      stale: true,
    });
    vi.spyOn(store.history, "readPortfolio").mockResolvedValue(null);
    const bulk = vi.spyOn(store, "getMany");
    const app = await buildApi(store, upstream, undefined, { logger: false });
    try {
      const response = await app.inject(`/api/wallets/${address}`);
      expect(response.statusCode).toBe(200);
      const result = response.json();
      expect(result.snapshot).toEqual(input.value);
      expect(result.receivedAt).toBe(at - 3600000);
      expect(result.stale).toBe(true);
      expect(result.marginRisk).toMatchObject({
        stale: false,
        snapshot: {
          receivedAt: at - 100,
          accountRevision: input.value.accountRevision,
          sourceAt: at,
        },
      });
      expect(snapshotCall).toHaveBeenCalledExactlyOnceWith(address, false, 1500);
      expect(fetcher).not.toHaveBeenCalled();
      expect(bulk).toHaveBeenCalledTimes(1);
      expect(bulk.mock.calls[0][0].some((key) => key.includes("wallet"))).toBe(
        false,
      );
      expect(response.headers["cdn-cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });
  it("does not fail the existing profile if risk reference reads fail", async () => {
    const store = await memory();
    vi.spyOn(Date, "now").mockReturnValue(at);
    const upstream = new Upstream(store, vi.fn<typeof fetch>());
    vi.spyOn(upstream, "snapshot").mockResolvedValue(observed());
    vi.spyOn(upstream, "history").mockResolvedValue({
      value: { items: [], nextCursor: null },
      receivedAt: at,
      stale: false,
    });
    vi.spyOn(store.history, "readPortfolio").mockResolvedValue(null);
    vi.spyOn(store, "getMany").mockRejectedValue(
      new Error("quote read failed"),
    );
    try {
      const result = await upstream.wallet(address);
      expect(result.snapshot).toEqual(snapshot());
      expect(result.marginRisk).toMatchObject({
        stale: true,
        error: "Market references are temporarily unavailable.",
      });
      expect(result.marginRisk?.snapshot?.stale).toBe(false);
    } finally {
      await upstream.close();
    }
  });
});
