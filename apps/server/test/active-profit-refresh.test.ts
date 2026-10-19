import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "../src/store.js";
import { refreshActiveTraderProfits, ACTIVE_PROFIT_REFRESH_KEY, ACTIVE_PROFIT_MAX_PAGES } from "../src/active-profit-refresh.js";
import { accountKey } from "../src/following-store.js";
import { Upstream, RequestGate, UpstreamError } from "../src/upstream.js";
import { segmentAccount, segmentWallet } from "./market-segment-fixtures.js";
import { sampleTrade } from "./market-sampling-fixtures.js";

const stores: Store[] = [];
const sources: Upstream[] = [];
let now: number;
beforeEach(() => {
  now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(async () => {
  for (const source of sources.splice(0)) await source.close();
  for (const store of stores.splice(0)) await store.close();
  vi.restoreAllMocks();
});
async function setup() {
  const store = await createStore({ memory: true, databaseUrl: "" });
  stores.push(store);
  return store;
}
function page(index = 0, totalPages = 8, count = 100) {
  return {
    ok: true as const,
    accounts: Array.from({ length: count }, (_, n) => ({
      ...segmentAccount(index * 100 + n + 1, "2000000000000000000000"),
      lastActiveTs: Math.floor(now / 1000) - n,
    })),
    count: totalPages * 100,
    summary: { uniqueAccounts: totalPages * 100, trackedBalance: "0", trackedQueued: "0", trackedOpenNotional: "0", trackedPaper: "0" },
    pageInfo: { page: index, totalPages },
  };
}
function source(store: Store, load: (url: URL) => unknown | Promise<unknown>) {
  const fetcher = vi.fn(async (url: URL | RequestInfo) => {
    const body = await load(new URL(String(url)));
    return body instanceof Response ? body : Response.json(body);
  });
  const upstream = new Upstream(store, fetcher as typeof fetch, "https://source.invalid", new RequestGate(3, 0));
  sources.push(upstream);
  return { upstream, fetcher };
}
async function tick(store: Store, upstream: Pick<Upstream, "directoryPage">) {
  await refreshActiveTraderProfits(store, upstream, now);
  now += 2000;
}
async function targetNext(store: Store) {
  const saved = (await store.get<Record<string, unknown>>(ACTIVE_PROFIT_REFRESH_KEY))?.value;
  await store.put(ACTIVE_PROFIT_REFRESH_KEY, {
    version: 1, page: 0, cursor: "", pageFailures: 0, pageRetryAt: 0, retries: [],
    ...saved, turn: 4, nextRunAt: now,
  });
}

describe("active trader profit refresh", () => {
  it("backfills 800 active opening wallets in nine bounded source requests without viewers or history jobs", async () => {
    const store = await setup();
    for (let n = 1; n <= 800; n++)
      await store.recordTrade(sampleTrade(`active:${n}`, { wallet: segmentWallet(n), ts: now - 1000, instrument: n % 2 }));
    const discover = vi.spyOn(store.history, "discoverWallets");
    const { upstream, fetcher } = source(store, (url) => {
      const address = url.searchParams.get("q");
      return address ? { ...page(), accounts: [{ ...segmentAccount(Number.parseInt(address.slice(2), 16)), lastActiveTs: Math.floor(now / 1000) }] }
        : page(Number(url.searchParams.get("page")));
    });
    const started = now;
    for (let turn = 0; turn < 10; turn++) await tick(store, upstream);
    expect(now - started).toBe(20000);
    expect(fetcher).toHaveBeenCalledTimes(9);
    expect(fetcher.mock.calls.filter(([url]) => new URL(String(url)).searchParams.get("pageSize") === "100")).toHaveLength(8);
    for (const instrument of [0, 1]) {
      const data = await store.market.read(instrument, now);
      expect(data.profitable.coverage).toMatchObject({ observedWallets: 400, classifiedWallets: 400, unknownWallets: 0 });
    }
    expect(discover).not.toHaveBeenCalled();
    expect((await store.get<{ page: number }>(ACTIVE_PROFIT_REFRESH_KEY))?.value.page).toBe(0);
  });

  it("preserves original cached receipts and newer concurrent snapshots, and resumes its durable page", async () => {
    const store = await setup();
    const directoryPage = vi.fn(async (_q: string, _sort: string, index: number) => ({
      value: page(index), receivedAt: now - 10000, stale: false,
    }));
    await store.following.retainAccounts([segmentAccount(1, "999")], now - 5000);
    await tick(store, { directoryPage } as unknown as Pick<Upstream, "directoryPage">);
    expect(await store.get(accountKey(segmentWallet(1)))).toMatchObject({ receivedAt: now - 7000, value: { realizedPnl: "999" } });
    expect(await store.get(accountKey(segmentWallet(2)))).toMatchObject({ receivedAt: now - 12000 });
    // A fresh function invocation has no in-memory cursor to rely on.
    await tick(store, { directoryPage } as unknown as Pick<Upstream, "directoryPage">);
    expect(directoryPage.mock.calls.map((call) => call[2])).toEqual([0, 1]);
  });

  it("reuses the canonical shared source cache without re-aging profit receipts", async () => {
    const store = await setup();
    const { upstream, fetcher } = source(store, () => page(0, 1));
    const receivedAt = now;
    await tick(store, upstream);
    await tick(store, upstream);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await store.get(accountKey(segmentWallet(1)))).toMatchObject({ receivedAt });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(await store.get(`cache:${url.pathname}${url.search}`)).toMatchObject({ receivedAt });
    now += 15000;
    await tick(store, upstream);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await store.get(accountKey(segmentWallet(1))))?.receivedAt).toBe(now - 2000);
  });

  it("retains a page before advancing and persists Retry-After across restart", async () => {
    const store = await setup();
    const { upstream, fetcher } = source(store, () => page());
    const retain = vi.spyOn(store.following, "retainAccounts").mockRejectedValueOnce(new Error("storage busy"));
    await expect(refreshActiveTraderProfits(store, upstream, now)).rejects.toThrow("storage busy");
    expect((await store.get<{ page: number }>(ACTIVE_PROFIT_REFRESH_KEY))?.value.page).toBe(0);
    retain.mockRestore();
    now += 6000;
    await tick(store, upstream);
    expect((await store.get<{ page: number }>(ACTIVE_PROFIT_REFRESH_KEY))?.value.page).toBe(1);
    const retryAt = now + 60000;
    const limited = { directoryPage: vi.fn().mockRejectedValue(new UpstreamError("limited", 429, retryAt)) };
    await expect(refreshActiveTraderProfits(store, limited, now)).rejects.toThrow("limited");
    now += 30000;
    await refreshActiveTraderProfits(store, limited, now);
    expect(limited.directoryPage).toHaveBeenCalledTimes(1);
    expect((await store.get<{ nextRunAt: number }>(ACTIVE_PROFIT_REFRESH_KEY))?.value.nextRunAt).toBe(retryAt);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("repairs observed wallets missed by changing pages and rotates past absent accounts with durable backoff", async () => {
    const store = await setup();
    for (const n of [900, 901, 902]) await store.recordTrade(sampleTrade(`missed:${n}`, { wallet: segmentWallet(n), ts: now - 1000 }));
    const { upstream, fetcher } = source(store, (url) => {
      const address = url.searchParams.get("q");
      return { ...page(), accounts: address === segmentWallet(900) ? [] : [{ ...segmentAccount(Number.parseInt(address!.slice(2), 16)), lastActiveTs: now / 1000 }] };
    });
    await targetNext(store);
    await expect(refreshActiveTraderProfits(store, upstream, now)).rejects.toThrow("fresh matching account");
    const failed = (await store.get<{ retries: { address: string; retryAt: number }[] }>(ACTIVE_PROFIT_REFRESH_KEY))!.value.retries;
    expect(failed).toEqual([{ address: segmentWallet(900), retryAt: now + 5000, failures: 1 }]);
    now += 2000;
    await targetNext(store);
    await tick(store, upstream);
    await targetNext(store);
    await tick(store, upstream);
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("q"))).toEqual([segmentWallet(900), segmentWallet(901), segmentWallet(902)]);
    expect((await store.market.read(0, now)).profitable.coverage).toMatchObject({ observedWallets: 3, classifiedWallets: 2, unknownWallets: 1 });
  });

  it("bounds the scan and returns to new head accounts after old activity or maximum depth", async () => {
    const store = await setup();
    const directoryPage = vi.fn(async (_q: string, _sort: string, index: number) => ({
      value: page(index, 1000), receivedAt: now, stale: false,
    }));
    await store.put(ACTIVE_PROFIT_REFRESH_KEY, { version: 1, page: ACTIVE_PROFIT_MAX_PAGES - 1, turn: 0, cursor: "", nextRunAt: 0, pageRetryAt: 0, pageFailures: 0, retries: [] });
    await tick(store, { directoryPage } as unknown as Pick<Upstream, "directoryPage">);
    await tick(store, { directoryPage } as unknown as Pick<Upstream, "directoryPage">);
    expect(directoryPage.mock.calls.map((call) => call[2])).toEqual([63, 0]);
    directoryPage.mockImplementationOnce(async (_q, _sort, index) => ({
      value: { ...page(index, 1000), accounts: page().accounts.map((a) => ({ ...a, lastActiveTs: (now - 3901000) / 1000 })) }, receivedAt: now, stale: false,
    }));
    await tick(store, { directoryPage } as unknown as Pick<Upstream, "directoryPage">);
    expect((await store.get<{ page: number }>(ACTIVE_PROFIT_REFRESH_KEY))?.value.page).toBe(0);
  });

  it("returns to the head after a persistently invalidated page rather than starving recent traders", async () => {
    const store = await setup();
    await store.put(ACTIVE_PROFIT_REFRESH_KEY, { version: 1, page: 20, turn: 0, cursor: "", nextRunAt: 0, pageRetryAt: 0, pageFailures: 0, retries: [] });
    const directoryPage = vi.fn().mockRejectedValue(new UpstreamError("Page no longer available", 400));
    for (let n = 0; n < 3; n++) {
      await expect(refreshActiveTraderProfits(store, { directoryPage }, now)).rejects.toThrow("Page no longer available");
      now += 60000;
    }
    expect((await store.get<{ page: number; pageFailures: number }>(ACTIVE_PROFIT_REFRESH_KEY))?.value).toMatchObject({ page: 0, pageFailures: 3 });
    directoryPage.mockResolvedValue({ value: page(), receivedAt: now, stale: false });
    await tick(store, { directoryPage });
    expect(directoryPage).toHaveBeenLastCalledWith("", "lastActiveTs", 0, 100, true);
  });

  it("uses only the recent trading cohort and refreshes missing, stale, malformed and future accounts fairly", async () => {
    const store = await setup();
    for (let n = 1; n <= 8; n++) await store.recordTrade(sampleTrade(`cohort:${n}`, {
      wallet: segmentWallet(n), ts: now - 1000, instrument: n % 2,
    }));
    await store.following.retainAccounts([segmentAccount(1)], now);
    await store.following.retainAccounts([segmentAccount(2)], now - 240000);
    await store.following.retainAccounts([segmentAccount(3)], now - 240001);
    await store.following.retainAccounts([segmentAccount(4)], now + 1);
    await store.put(accountKey(segmentWallet(5)), { ...segmentAccount(5), realizedPnl: "+1" }, now);
    await store.put(accountKey(segmentWallet(6)), segmentAccount(99), now);
    await store.put(accountKey(segmentWallet(7)), { ...segmentAccount(7), realizedPnl: 1 }, now);
    await store.recordTrade(sampleTrade("old", { wallet: segmentWallet(9), ts: now - 3600001 }));
    await store.recordTrade(sampleTrade("future", { wallet: segmentWallet(10), ts: now + 1 }));
    await store.recordTrade(sampleTrade("closed", { wallet: segmentWallet(11), ts: now - 1000, kind: "close" }));
    await store.recordTrade(sampleTrade("liquidated", { wallet: segmentWallet(13), ts: now - 1000, kind: "liq" }));
    await store.recordTrade(sampleTrade("left-bound", { wallet: segmentWallet(12), ts: now - 3600000 }));
    expect(await store.following.profitRefreshCandidates("", now)).toEqual([3, 4, 5, 6, 7, 8, 11, 12, 13].map(segmentWallet));
    expect(await store.following.profitRefreshCandidates(segmentWallet(6), now)).toEqual([7, 8, 11, 12, 13, 3, 4, 5, 6].map(segmentWallet));
  });
});
