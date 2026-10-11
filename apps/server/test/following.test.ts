import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "../src/store.js";
import { buildApi } from "../src/api.js";
import { Upstream, RequestGate } from "../src/upstream.js";
import { LocalCoordinator } from "../src/coordination.js";
import { readWalletBatch, refreshWatchedWallet } from "../src/following.js";
import { accountKey } from "../src/following-store.js";
import type {
  Account,
  TradeEvent,
} from "../../../packages/shared/src/types.js";

const stores: Store[] = [];
const addr = (n = 1) => `0x${n.toString(16).padStart(40, "0")}`;
const at = 1800000012345;
const account = (n = 1, balance = "100"): Account => ({
  address: addr(n),
  leaderboardName: null,
  currentBalance: balance,
  currentQueued: "0",
  currentOpenNotional: "0",
  currentOpenPositionCount: 0,
  currentUnrealizedPnl: "0",
  realizedPnl: "0",
  totalVolume: "0",
  totalWindowedPnl: "0",
  paperTotal: "0",
  lastActiveTs: 1,
});
const trade = (id: string, extra: Partial<TradeEvent> = {}): TradeEvent => ({
  id,
  ts: at - 1000,
  wallet: addr(),
  instrument: 0,
  side: "long",
  kind: "open",
  leverage: 1000,
  notionalUsd: 10000,
  pnlUsd: null,
  provenance: "public-stream",
  priceUsd: 80000,
  ...extra,
});
async function setup() {
  const store = await createStore({ memory: true });
  stores.push(store);
  await store.put("collector-heartbeat", { at });
  await store.put("overview", { status: { stream: "connected" } });
  return store;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) await s.close();
});
describe("retained Following", () => {
  it("reuses fresh per-address observations without source work and clears failures after a frozen-clock fetch success", async () => {
    const store = await setup();
    await store.following.retainAccounts([account()], at);
    await store.following.touch([addr()], at);
    const directoryPage = vi.fn();
    await refreshWatchedWallet(
      store,
      { directoryPage } as unknown as Upstream,
      at,
    );
    expect(directoryPage).not.toHaveBeenCalled();
    await store.following.failWatch(addr(), 2, at);
    vi.spyOn(Date, "now").mockReturnValue(at + 61000);
    await store.following.touch([addr()], at + 61000);
    const value = {
      ok: true,
      accounts: [account(1, "500")],
      count: 1,
      summary: {
        uniqueAccounts: 1,
        trackedBalance: "500",
        trackedQueued: "0",
        trackedOpenNotional: "0",
        trackedPaper: "0",
      },
      pageInfo: { page: 0, totalPages: 1 },
    };
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(value), { status: 200 }));
    const upstream = new Upstream(
      store,
      fetcher,
      "https://source.invalid",
      new RequestGate(1, 0),
      new LocalCoordinator(),
    );
    try {
      await refreshWatchedWallet(store, upstream, at + 61000);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(await store.following.nextWatch(at + 122000)).toEqual({
        address: addr(),
        failures: 0,
      });
      expect(await store.get(accountKey(addr()))).toMatchObject({
        receivedAt: at + 61000,
        value: { currentBalance: "500" },
      });
    } finally {
      await upstream.close();
    }
  });
  it("serves normalized missing/known rows without upstream requests and preserves original valuation ages", async () => {
    const store = await setup();
    await store.following.retainAccounts([account()], at - 70000);
    await store.following.retainAccounts([account(1, "90")], at - 80000);
    await store.history.ensureWallet(addr(2));
    await store.recordTrade(trade("s1"));
    await store.analytics.backfill(100);
    const result = await readWalletBatch(
      store,
      [addr(3), addr(2), addr(1)],
      at,
    );
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({
      account: { currentBalance: "100" },
      receivedAt: at - 70000,
      stale: true,
      sourceAt: null,
      refreshQueued: true,
    });
    expect(result.rows[1]).toMatchObject({
      account: null,
      refreshQueued: true,
    });
    expect(result.rows[2]).toMatchObject({
      account: null,
      refreshQueued: false,
    });
    expect(result.activity.items).toHaveLength(1);
    expect(result.activity.stale).toBe(false);
    expect(result.stale).toBe(true);
  });
  it("bounds admission, deduplicates touches, preserves backoff, expires watches and refreshes fairly", async () => {
    const store = await setup();
    await store.following.retainAccounts([account(1), account(2)], at - 100000);
    await store.following.touch([addr(1), addr(2), addr(1)], at);
    expect(await store.following.nextWatch(at)).toEqual({
      address: addr(1),
      failures: 0,
    });
    await store.following.failWatch(addr(1), 3, at, at + 200000);
    await store.following.touch([addr(1)], at + 40000);
    expect(await store.following.nextWatch(at + 40000)).toEqual({
      address: addr(2),
      failures: 0,
    });
    expect(await store.following.nextWatch(at + 40001)).toBeNull();
    expect(await store.following.nextWatch(at + 160001)).toBeNull();
    expect(await store.following.touch([addr(99)], at)).toEqual([]);
  });
  it("serializes concurrent local admission at the durable1000-row cap", async () => {
    const store = await setup();
    for (let first = 1; first <= 1025; first += 25)
      await store.following.retainAccounts(
        Array.from({ length: 25 }, (_, i) => account(first + i)),
        at,
      );
    const requests = Array.from({ length: 41 }, (_, group) =>
      Array.from({ length: 25 }, (_, i) => addr(1 + group * 25 + i)),
    );
    const admitted = await Promise.all(
      requests.map((addresses) => store.following.touch(addresses, at)),
    );
    expect(admitted.flat()).toHaveLength(1000);
    expect(await store.following.touch(requests[40], at)).toEqual([]);
    await store.following.nextWatch(at + 120001); // bounded expiry reclaims capacity
    expect(await store.following.touch(requests[40], at + 120001)).toHaveLength(
      25,
    );
  });
  it("uses exact24h bounds and maximum source multiplicity, stable IDs, real metadata and bounded latest50", async () => {
    const store = await setup();
    await store.recordTrade(trade("s1"));
    await store.recordTrade(trade("s2"));
    const first = await store.following.activity([addr()], at);
    await store.recordTrade(trade("r1", { provenance: "recent-api" }));
    await store.recordTrade(trade("r2", { provenance: "recent-api" }));
    expect(
      (await store.following.activity([addr()], at)).items.map((r) => r.id),
    ).toEqual(first.items.map((r) => r.id));
    await store.recordTrade(trade("outside", { ts: at - 86400001 }));
    await store.recordTrade(
      trade("left", { ts: at - 86400000, wallet: addr(2) }),
    );
    await store.recordTrade(trade("future", { ts: at + 1 }));
    for (let i = 0; i < 60; i++)
      await store.recordTrade(
        trade(`tail:${i}`, { ts: at - i, notionalUsd: i }),
      );
    const result = await store.following.activity([addr(), addr(2)], at);
    expect(result.items).toHaveLength(50);
    expect(result.coverage.truncated).toBe(true);
    expect(result.items.every((r) => r.ts <= at && r.ts >= at - 86400000)).toBe(
      true,
    );
    expect((await store.following.activity([addr(2)], at)).items[0].ts).toBe(
      at - 86400000,
    );
  });
  it("canonicalizes the API cache, validates before dedupe, rejects extras and never fans out to upstream", async () => {
    const store = await setup();
    const fetcher = vi.fn().mockRejectedValue(new Error("unexpected upstream"));
    const upstream = new Upstream(
      store,
      fetcher,
      "https://source.invalid",
      new RequestGate(),
      new LocalCoordinator(),
    );
    const api = await buildApi(store, upstream, undefined, { logger: false });
    try {
      const touch = vi.spyOn(store.following, "touch");
      const url = `/api/wallets/batch?addresses=${addr(2)},${addr(1)}`;
      expect((await api.inject(url)).statusCode).toBe(200);
      expect(
        (await api.inject(`/api/wallets/batch?addresses=${addr(1)},${addr(2)}`))
          .statusCode,
      ).toBe(200);
      expect(touch).toHaveBeenCalledTimes(1);
      expect(fetcher).not.toHaveBeenCalled();
      for (const suffix of [
        "",
        Array(26).fill(addr()).join(","),
        `${addr()}&extra=1`,
        "bad",
      ])
        expect(
          (await api.inject(`/api/wallets/batch?addresses=${suffix}`))
            .statusCode,
        ).toBe(400);
    } finally {
      await api.close();
      await upstream.close();
    }
  });
  it("worker refresh makes one exact-address lookup, keeps source timestamps, and persists retry state", async () => {
    const store = await setup();
    await store.following.retainAccounts([account()], at - 100000);
    await store.following.touch([addr()], at);
    const directoryPage = vi.fn().mockResolvedValue({
      value: { accounts: [account(1, "200")] },
      receivedAt: at - 10,
      stale: false,
    });
    await refreshWatchedWallet(
      store,
      { directoryPage } as unknown as Upstream,
      at,
    );
    expect(directoryPage).toHaveBeenCalledWith(
      addr(),
      "currentBalance",
      0,
      10,
      true,
    );
    expect(await store.get(accountKey(addr()))).toMatchObject({
      receivedAt: at - 10,
      value: { currentBalance: "200" },
    });
    await store.following.retainAccounts([account(1, "50")], at - 20);
    expect(
      (await store.get<Account>(accountKey(addr())))?.value.currentBalance,
    ).toBe("200");
    expect(await store.following.nextWatch(at + 1000)).toBeNull();
  });
});
