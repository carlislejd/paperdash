import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshDirectoryHead } from "../src/directory-refresh.js";
import { createStore, type Store } from "../src/store.js";
import {
  canonicalPath,
  RequestGate,
  Upstream,
  UpstreamError,
} from "../src/upstream.js";

const key = "directory-head-rotation";
const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const stores: Store[] = [];
const directories: string[] = [];
const upstreams: Upstream[] = [];
let now: number;

beforeEach(() => {
  now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(async () => {
  for (const upstream of upstreams.splice(0)) await upstream.close();
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function fixture(dataDir?: string) {
  const store = await createStore({
    databaseUrl: "",
    memory: !dataDir,
    dataDir,
  });
  stores.push(store);
  return store;
}
function page(path: string, size = 25) {
  const params = new URL(path, "https://source.test").searchParams;
  const index = Number(params.get("page"));
  const paper = params.get("sortKey") === "paperTotal";
  return {
    ok: true as const,
    count: 100,
    pageInfo: { page: index, totalPages: 4 },
    summary: {
      uniqueAccounts: 2000,
      trackedBalance: "0",
      trackedQueued: "0",
      trackedOpenNotional: "0",
      trackedPaper: "1000000000000000000000000000",
    },
    accounts: Array.from({ length: size }, (_, i) => ({
      address: wallet((paper ? index * 25 : 200) + i + 1),
      leaderboardName: `Account ${i}`,
      currentBalance: "1",
      currentQueued: "0",
      currentOpenNotional: "0",
      currentOpenPositionCount: 0,
      currentUnrealizedPnl: "0",
      realizedPnl: "0",
      totalVolume: "0",
      totalWindowedPnl: "0",
      paperTotal: "1000000000000000000",
      lastActiveTs: Math.floor(now / 1000),
    })),
  };
}
function source(load: (path: string) => unknown | Promise<unknown> = page) {
  const request = vi.fn(async (path: string) => load(path));
  return { request } as unknown as Pick<Upstream, "request"> & {
    request: typeof request;
  };
}
function paperPath(index: number) {
  return canonicalPath("/state/leaderboard/accounts", {
    window: "all",
    sortKey: "paperTotal",
    sortDir: "desc",
    page: index,
    pageSize: 25,
  });
}

describe("bounded collector directory rotation", () => {
  it("rotates one request per turn, retains all 100 holders, and warms the canonical leaderboard cache", async () => {
    const store = await fixture();
    const upstream = source();
    const discover = vi.spyOn(store.history, "discoverWallets");
    for (let turn = 0; turn < 8; turn++) {
      await refreshDirectoryHead(store, upstream);
      expect(upstream.request).toHaveBeenCalledTimes(turn + 1);
      now += 30000;
    }
    expect(
      upstream.request.mock.calls.map(([path]) => {
        const query = new URL(path, "https://source.test").searchParams;
        expect(query.get("pageSize")).toBe("25");
        return `${query.get("sortKey")}:${query.get("page")}`;
      }),
    ).toEqual([
      "currentBalance:0",
      "paperTotal:0",
      "currentBalance:0",
      "paperTotal:1",
      "currentBalance:0",
      "paperTotal:2",
      "currentBalance:0",
      "paperTotal:3",
    ]);
    expect(
      discover.mock.calls
        .filter(([, priority]) => priority === 10)
        .flatMap(([addresses]) => addresses),
    ).toEqual(Array.from({ length: 100 }, (_, i) => wallet(i + 1)));
    expect((await store.history.stats()).wallets).toBe(125);
    expect((await store.get(key))?.value).toEqual({
      version: 1,
      nextTurn: "balance",
      paperPage: 0,
    });
    expect((await store.get("account-count"))?.value).toBe(2000);
    expect(await store.get(`account-summary:${wallet(100)}`)).toMatchObject({
      value: { paperTotal: "1000000000000000000" },
      receivedAt: now - 30000,
    });

    // Read while the actual shared source cache is still fresh. Enrichment is
    // local; neither account retention nor source HTTP should run again.
    now -= 15000;
    const fetcher = vi.fn(async () => {
      throw new Error("Unexpected source read");
    });
    const reader = new Upstream(
      store,
      fetcher as typeof fetch,
      "https://source.test",
      new RequestGate(3, 0),
    );
    upstreams.push(reader);
    const result = await reader.leaderboard("paper", 3, "", "all");
    expect(result.rows).toHaveLength(25);
    expect(result.rows[0].address).toBe(wallet(76));
    expect(fetcher).not.toHaveBeenCalled();
    expect(discover).toHaveBeenCalledTimes(8);
  });

  it("reserves the balance turn before a failed PAPER request and retries the same page after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paperclub-directory-"));
    directories.push(directory);
    let store = await fixture(directory);
    await store.put(key, { version: 1, nextTurn: "paper", paperPage: 2 });
    const error = new UpstreamError("Rate limited", 429, now + 120000);
    const upstream = source(async () => {
      expect((await store.get(key))?.value).toEqual({
        version: 1,
        nextTurn: "balance",
        paperPage: 2,
      });
      throw error;
    });
    await expect(refreshDirectoryHead(store, upstream)).rejects.toBe(error);
    expect(upstream.request).toHaveBeenCalledTimes(1);
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    store = await fixture(directory);
    const recovered = source();
    now += 120000;
    await refreshDirectoryHead(store, recovered);
    now += 30000;
    await refreshDirectoryHead(store, recovered);
    expect(recovered.request.mock.calls[0][0]).toContain(
      "sortKey=currentBalance",
    );
    expect(recovered.request.mock.calls[1][0]).toBe(paperPath(2));
    expect((await store.get(key))?.value).toEqual({
      version: 1,
      nextTurn: "balance",
      paperPage: 3,
    });
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    store = await fixture(directory);
    now += 30000;
    await refreshDirectoryHead(store, recovered);
    now += 30000;
    await refreshDirectoryHead(store, recovered);
    expect(recovered.request.mock.calls[3][0]).toBe(paperPath(3));
    expect(recovered.request).toHaveBeenCalledTimes(4);
  });

  it("does not advance a partially retained PAPER page until discovery succeeds", async () => {
    const store = await fixture();
    await store.put(key, { version: 1, nextTurn: "paper", paperPage: 1 });
    const upstream = source();
    vi.spyOn(store.history, "discoverWallets").mockRejectedValueOnce(
      new Error("storage temporarily unavailable"),
    );
    await expect(refreshDirectoryHead(store, upstream)).rejects.toThrow(
      "storage temporarily unavailable",
    );
    expect((await store.get(key))?.value).toEqual({
      version: 1,
      nextTurn: "balance",
      paperPage: 1,
    });
    expect(await store.get(`cache:${paperPath(1)}`)).not.toBeNull();
    now += 30000;
    await refreshDirectoryHead(store, upstream);
    now += 30000;
    await refreshDirectoryHead(store, upstream);
    expect(upstream.request.mock.calls.map(([path]) => path)).toEqual([
      paperPath(1),
      expect.stringContaining("sortKey=currentBalance"),
      paperPath(1),
    ]);
    expect((await store.history.stats()).wallets).toBe(50);
    expect((await store.history.stats()).jobs).toBe(150);
    expect((await store.get(key))?.value).toEqual({
      version: 1,
      nextTurn: "balance",
      paperPage: 2,
    });
  });

  it("does not fetch when the durable reservation cannot be saved", async () => {
    const store = await fixture();
    const upstream = source();
    vi.spyOn(store, "put").mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(refreshDirectoryHead(store, upstream)).rejects.toThrow(
      "disk unavailable",
    );
    expect(upstream.request).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { version: 2, nextTurn: "paper", paperPage: 1 },
    { version: 1, nextTurn: "paper", paperPage: 4 },
    { version: 1, nextTurn: "paper", paperPage: -1 },
    { version: 1, nextTurn: "paper", paperPage: 0.5 },
    { version: 1, nextTurn: "unexpected", paperPage: 1 },
  ])("safely resets corrupt rotation state %j", async (value) => {
    const store = await fixture();
    await store.put(key, value);
    const upstream = source();
    await refreshDirectoryHead(store, upstream);
    expect(upstream.request).toHaveBeenCalledTimes(1);
    expect(upstream.request.mock.calls[0][0]).toContain(
      "sortKey=currentBalance",
    );
    expect((await store.get(key))?.value).toEqual({
      version: 1,
      nextTurn: "paper",
      paperPage: 0,
    });
  });

  it("bounds oversized pages, deduplicates writes, skips zero-holder promotion, and wraps a shrinking directory", async () => {
    const store = await fixture();
    await store.put(key, { version: 1, nextTurn: "paper", paperPage: 3 });
    const value = page(paperPath(3), 30);
    value.pageInfo.totalPages = 2;
    value.accounts[1] = value.accounts[0];
    value.accounts[2].paperTotal = "0";
    const upstream = source(() => value);
    const discover = vi.spyOn(store.history, "discoverWallets");
    const retain = vi.spyOn(store.following, "retainAccounts");
    await refreshDirectoryHead(store, upstream);
    expect(retain.mock.calls[0][0]).toHaveLength(24);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(
      discover.mock.calls.find(([, priority]) => priority === 10)?.[0],
    ).toHaveLength(23);
    expect(discover).toHaveBeenCalledWith([wallet(78)]);
    expect(await store.get(`account-summary:${wallet(101)}`)).toBeNull();
    expect(
      (await store.get<{ accounts: unknown[] }>(`cache:${paperPath(3)}`))?.value
        .accounts,
    ).toHaveLength(24);
    expect((await store.get(key))?.value).toEqual({
      version: 1,
      nextTurn: "balance",
      paperPage: 0,
    });
  });

  it("preserves stronger active trade priority and failed history checkpoints", async () => {
    const store = await fixture();
    await store.history.ensureWallet(wallet(1), 20);
    const job = await store.history.claimJob(now);
    expect(job?.kind).toBe("cashflows");
    await store.history.commitPage(
      job!,
      { items: [], nextCursor: "next-page" },
      now,
      3600000,
    );
    now += 1000;
    const continuation = await store.history.claimJob(now, 120000, "fair", [
      { address: wallet(1), kind: "trades" },
      { address: wallet(1), kind: "portfolio" },
    ]);
    expect(continuation?.state.cursor).toBe("next-page");
    await store.history.failJob(
      continuation!,
      "Retry later",
      now,
      now + 120000,
    );
    const before = (await store.history.getStatus(wallet(1))).find(
      (status) => status.kind === "cashflows",
    );
    await store.put(key, { version: 1, nextTurn: "paper", paperPage: 0 });
    now += 30000;
    await refreshDirectoryHead(
      store,
      source((path) => page(path, 1)),
    );
    expect(
      (await store.history.getStatus(wallet(1))).find(
        (status) => status.kind === "cashflows",
      ),
    ).toEqual(before);
    const active = await store.history.claimJob(now, 120000, "active");
    expect(active?.address).toBe(wallet(1));
    expect(active?.priority).toBe(20);
  });

  it("activates positive holders for ten minutes without activating zero holdings", async () => {
    const store = await fixture();
    await store.put(key, { version: 1, nextTurn: "paper", paperPage: 0 });
    const value = page(paperPath(0), 2);
    value.accounts[1].paperTotal = "0";
    await refreshDirectoryHead(
      store,
      source(() => value),
    );
    const active = await store.history.claimJob(now);
    expect(active?.address).toBe(wallet(1));
    expect(active?.priority).toBe(10);
    const excludeHolder = ["cashflows", "trades", "portfolio"].map((kind) => ({
      address: wallet(1),
      kind: kind as "cashflows" | "trades" | "portfolio",
    }));
    const cold = await store.history.claimJob(
      now,
      120000,
      "fair",
      excludeHolder,
    );
    expect(cold?.address).toBe(wallet(2));
    expect(cold?.priority).toBe(0);
    now += 600001;
    const expired = await store.history.claimJob(now);
    expect(expired?.address).toBe(wallet(1));
    expect(expired?.priority).toBe(0);
  });
});
