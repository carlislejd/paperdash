import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PAPER_PRICE_MAX_AGE_MS,
  paperPriceDelayed,
  validPaperPrice,
} from "../../../packages/shared/src/paper-price.js";
import {
  decodePaperPrice,
  PAPER_PRICE_KEY,
  refreshPaperPrice,
} from "../src/paper-price.js";
import { createStore, type Store } from "../src/store.js";
import { readPaperEconomics, refreshProtocolCharts } from "../src/protocol-charts.js";
import type { PaperPriceQuote, ProtocolSummary } from "../../../packages/shared/src/types.js";
import { VERIFIED_PROTOCOL_GENESIS } from "../../../packages/shared/src/staking-yield.js";

const now = 1800000000000;
const stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  vi.restoreAllMocks();
});
async function memory() {
  const store = await createStore({ memory: true, databaseUrl: "" });
  stores.push(store);
  return store;
}
function book(at = now, bid = "0.0247", ask = "0.0249") {
  return { coin: "para:PAPER", time: at, levels: [[{ px: bid }], [{ px: ask }]] };
}
const response = (value: unknown) => new Response(JSON.stringify(value));

describe("Paragon PAPER reference prices", () => {
  it("decodes the exact timestamped USDC midpoint, retaining all decimal precision", () => {
    expect(decodePaperPrice(book(), now)).toEqual({
      source: "hyperliquid", market: "para:PAPER", basis: "perp-mid",
      bidUsdRaw: "24700000000000000", askUsdRaw: "24900000000000000",
      priceUsdRaw: "24800000000000000", sourceAt: now, receivedAt: now,
    });
    const exact = decodePaperPrice(book(now, "9007199254740993.000000000000000001", "9007199254740993.000000000000000002"), now);
    expect(exact?.priceUsdRaw).toBe("9007199254740993000000000000000001");
  });

  it("rejects wrong markets, empty or crossed books, invalid decimals, and unusable clocks", () => {
    for (const value of [
      null, {}, { ...book(), coin: "PAPER" }, { ...book(), coin: "BTC" },
      { ...book(), levels: [[], []] }, { ...book(), levels: [[{ px: "1" }]] },
      { ...book(), levels: [Array(21).fill({ px: "1" }), [{ px: "2" }]] },
      book(now, "2", "1"), book(now, "0", "1"), book(now, "-1", "1"),
      book(now, "1e-3", "1"), book(now, "0.0000000000000000001", "1"),
      book(now, "9".repeat(61), "9".repeat(61)),
      book(0), book(NaN), book(now + 0.1), book(now + 30001),
      book(now - PAPER_PRICE_MAX_AGE_MS - 1),
    ]) expect(decodePaperPrice(value, now)).toBeNull();
    expect(decodePaperPrice(book(), NaN)).toBeNull();
    expect(decodePaperPrice(book(8.64e15 + 1), 8.64e15 + 1)).toBeNull();
  });

  it("separates quote validity from independent source and receipt freshness", () => {
    const quote = decodePaperPrice(book(), now)!;
    expect(validPaperPrice(quote)).toEqual(quote);
    expect(paperPriceDelayed(quote, now + 60000)).toBe(false);
    expect(paperPriceDelayed(quote, now + 60001)).toBe(true);
    expect(validPaperPrice({ ...quote, receivedAt: now + 60001 })).not.toBeNull();
    expect(paperPriceDelayed({ ...quote, receivedAt: now + 60001 }, now + 60001)).toBe(true);
    expect(paperPriceDelayed({ ...quote, sourceAt: now + 1 }, now)).toBe(true);
    expect(paperPriceDelayed(quote, NaN)).toBe(true);
    for (const override of [
      { source: "other" }, { market: "PAPER" }, { basis: "spot" },
      { priceUsdRaw: "0" }, { priceUsdRaw: "24800000000000001" },
      { bidUsdRaw: "00" }, { askUsdRaw: "9".repeat(79) },
      { sourceAt: 8.64e15 + 1 }, { receivedAt: Infinity },
      { sourceAt: now + 30001 },
    ]) expect(validPaperPrice({ ...quote, ...override })).toBeNull();
  });

  it("makes one bounded request, saves original clocks, and never renews a duplicate or regressed book", async () => {
    const store = await memory();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(book()))
      .mockResolvedValueOnce(response(book())).mockResolvedValueOnce(response(book(now - 1)))
      .mockResolvedValueOnce(response(book()));
    await refreshPaperPrice(store, fetcher, () => now);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("https://api.hyperliquid.xyz/info");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({ type: "l2Book", coin: "para:PAPER" });
    expect(fetcher.mock.calls[0][1]!.signal).toBeInstanceOf(AbortSignal);
    const original = await store.get<PaperPriceQuote>(PAPER_PRICE_KEY);
    await refreshPaperPrice(store, fetcher, () => now + 10000);
    expect(await store.get(PAPER_PRICE_KEY)).toEqual(original);
    await expect(refreshPaperPrice(store, fetcher, () => now + 20000)).rejects.toThrow("moved backward");
    expect(await store.get(PAPER_PRICE_KEY)).toEqual(original);
    await expect(refreshPaperPrice(store, fetcher, () => now + 60001)).rejects.toThrow("invalid or delayed");
    expect(await store.get(PAPER_PRICE_KEY)).toEqual(original);
    expect(paperPriceDelayed(original!.value, now + 60001)).toBe(true);
  });

  it("persists exponential backoff and Retry-After through a restarted refresh, retaining the last quote", async () => {
    const store = await memory();
    const original = decodePaperPrice(book(), now)!;
    await store.put(PAPER_PRICE_KEY, original, now);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("limited", { status: 429, headers: { "Retry-After": "90" } }))
      .mockRejectedValueOnce(new Error("network failed with private transport text"))
      .mockResolvedValueOnce(response(book(now + 110000)));
    await expect(refreshPaperPrice(store, fetcher, () => now)).rejects.toMatchObject({ retryAt: now + 90000 });
    await expect(refreshPaperPrice(store, fetcher, () => now + 89999)).rejects.toMatchObject({ retryAt: now + 90000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(refreshPaperPrice(store, fetcher, () => now + 90000)).rejects.toMatchObject({ retryAt: now + 110000, message: "PAPER reference price refresh failed." });
    expect((await store.get(PAPER_PRICE_KEY))?.value).toEqual(original);
    await refreshPaperPrice(store, fetcher, () => now + 110000);
    expect((await store.get<PaperPriceQuote>(PAPER_PRICE_KEY))?.value.sourceAt).toBe(now + 110000);
    expect((await store.get("paper-price-status"))?.value).toEqual({ failures: 0, retryAt: 0 });
  });

  it("limits response size and preserves good data on parse and storage failures", async () => {
    const store = await memory();
    const original = decodePaperPrice(book(), now)!;
    await store.put(PAPER_PRICE_KEY, original, now);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(" ".repeat(32769)))
      .mockResolvedValueOnce(new Response("not JSON"))
      .mockResolvedValueOnce(response(book(now + 30000)));
    await expect(refreshPaperPrice(store, fetcher, () => now)).rejects.toThrow("size limit");
    await expect(refreshPaperPrice(store, fetcher, () => now + 10000)).rejects.toThrow("refresh failed");
    const put = store.put.bind(store);
    vi.spyOn(store, "put").mockImplementation(async (key, value, receivedAt) => {
      if (key === PAPER_PRICE_KEY) throw new Error("storage unavailable");
      return put(key, value, receivedAt);
    });
    await expect(refreshPaperPrice(store, fetcher, () => now + 30000)).rejects.toThrow("refresh failed");
    expect((await store.get(PAPER_PRICE_KEY))?.value).toEqual(original);
    expect((await store.get("paper-price-status"))?.value).toEqual({ failures: 3, retryAt: now + 70000 });
  });

  it.each(["headers", "body"])("uses a five-second abort deadline during %s and records a retry", async (phase) => {
    const store = await memory();
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (phase === "headers") return new Promise((_resolve, reject) =>
        init!.signal!.addEventListener("abort", () => reject(new Error("timeout"))));
      return new Response(new ReadableStream({
        start(body) {
          init!.signal!.addEventListener("abort", () => body.error(new Error("body timeout")));
        },
      }));
    });
    const result = refreshPaperPrice(store, fetcher, () => now);
    const rejection = expect(result).rejects.toMatchObject({ retryAt: now + 10000 });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(timeout).toHaveBeenCalledWith(5000);
    controller.abort();
    await rejection;
  });

  it("does not publish a retired saved quote or let its delay affect reward freshness", async () => {
    const store = await memory();
    const summary: ProtocolSummary = {
      ok: true, source: { at: now, block: "1", genesis: VERIFIED_PROTOCOL_GENESIS },
      balances: { tvl: "1", margin: "0", lp: "0", reserve: "0", queue: "0" },
      activity: { volume: "0", open: 1 }, fees: { pending: "0", lifetime: "0" },
      paper: { supply: "100", staked: "50" },
    };
    const quote = decodePaperPrice(book(now - 61000), now - 61000)!;
    await store.put(PAPER_PRICE_KEY, quote, quote.receivedAt);
    await store.put("summary", summary, now);
    await store.put("collector-heartbeat", { at: now, errors: { "paper-price": "Temporarily delayed" } }, now);
    await refreshProtocolCharts(store, now);
    const reads = vi.spyOn(store, "get");
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not fetch"));
    const results = await Promise.all(Array.from({ length: 20 }, () => readPaperEconomics(store, now)));
    for (const result of results) {
      expect(result.paperPrice).toBeUndefined();
      expect(result.stale).toBe(false);
    }
    expect(new Set(reads.mock.calls.map(([key]) => key))).toEqual(new Set(["paper-economics", "collector-heartbeat"]));
    expect(fetcher).not.toHaveBeenCalled();
  });
});
