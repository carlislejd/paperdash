import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletSnapshot } from "../../../packages/shared/src/types.js";
import { LocalCoordinator } from "../src/coordination.js";
import { createStore, type Store } from "../src/store.js";
import { RequestGate, Upstream } from "../src/upstream.js";

const address = `0x${"1".repeat(40)}`;
const now = 1800000000000,
  oldAt = now - 46 * 3600000,
  historyAt = now - 86400000;
const snapshot = (
  balance = "6154000000000000000000000",
  sourceAt = now,
): WalletSnapshot => ({
  address,
  indexedThroughBlock: 100,
  indexedThroughTimestamp: sourceAt / 1000,
  accountRevision: 10,
  balance,
  queued: "0",
  locked: "0",
  paper: { balance: "0", staked: "0" },
  lifetime: {
    depositedRaw: balance,
    withdrawnRaw: "0",
    realizedPnlRaw: "0",
    feesPaidRaw: "0",
    tradedNotionalRaw: "0",
    paperRewardsClaimedRaw: "0",
  },
  openPositions: [],
});
const event = (value = snapshot()) =>
  new Response(`event: wallet\ndata: ${JSON.stringify(value)}\n\n`);
const stores: Store[] = [],
  clients: Upstream[] = [],
  cleanupLoads: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(now);
});
afterEach(async () => {
  cleanupLoads.splice(0).forEach((finish) => finish());
  await vi.advanceTimersByTimeAsync(15000);
  for (const client of clients.splice(0)) await client.close();
  for (const store of stores.splice(0)) await store.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function memory() {
  const store = await createStore({ memory: true, databaseUrl: "" });
  stores.push(store);
  return store;
}
function api(
  store: Store,
  fetcher: typeof fetch,
  coordinator = new LocalCoordinator(),
) {
  const client = new Upstream(
    store,
    fetcher,
    "https://papertrade.test",
    new RequestGate(3, 0),
    coordinator,
  );
  clients.push(client);
  // Retained history deliberately has an older clock than the account check.
  vi.spyOn(client, "history").mockResolvedValue({
    value: {
      items: [{ kind: "Deposit", amountRaw: "123", timestampMs: historyAt }],
      nextCursor: null,
    },
    receivedAt: historyAt,
    stale: true,
  });
  return client;
}
function deferredFetch() {
  let resolve!: (response: Response) => void, reject!: (error: Error) => void;
  const pending = new Promise<Response>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const fetcher = vi.fn(() => pending);
  cleanupLoads.push(() => resolve(event()));
  return { fetcher, resolve, reject };
}

describe("bounded wallet account freshness", () => {
  it.each([false, true])(
    "persists a full snapshot after a revision reset (equal chain clocks: %s)",
    async (equalClocks) => {
      const store = await memory();
      const saved = {
        ...snapshot("4651000000000000000000000", now - 60000),
        accountRevision: 3,
      };
      const candidate = {
        ...snapshot(),
        accountRevision: 1,
        indexedThroughBlock: equalClocks
          ? saved.indexedThroughBlock
          : saved.indexedThroughBlock + 1,
        indexedThroughTimestamp: equalClocks
          ? saved.indexedThroughTimestamp
          : now / 1000,
      };
      await store.put(`cache:wallet:${address}`, saved, now - 60000);
      const fetcher = vi.fn(async () => event(candidate));
      const client = api(store, fetcher as typeof fetch);
      const response = await client.wallet(address);
      expect(response.snapshot).toEqual(candidate);
      expect(response.accountFreshness).toMatchObject({
        receivedAt: now,
        refreshing: false,
        sourceAt: candidate.indexedThroughTimestamp * 1000,
      });
      expect(response.errors.join(" ")).not.toContain(
        "older indexed account state",
      );
      expect(await store.get(`cache:wallet:${address}`)).toEqual({
        value: candidate,
        receivedAt: now,
      });
      expect(await store.get(`cache-error:wallet:${address}`)).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("replaces a 46-hour saved account during the first response without borrowing history's clock", async () => {
    const store = await memory();
    await store.put(
      `cache:wallet:${address}`,
      snapshot("4651000000000000000000000", oldAt),
      oldAt,
    );
    const fetcher = vi.fn(async () => event());
    const client = api(store, fetcher as typeof fetch);
    const result = await client.wallet(address);
    expect(result.snapshot?.balance).toBe(snapshot().balance);
    expect(result.accountFreshness).toEqual({
      receivedAt: now,
      sourceAt: now,
      stale: false,
      refreshing: false,
    });
    expect(result.receivedAt).toBe(historyAt);
    expect(result.stale).toBe(true); // retained history still has its own state
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps source-age staleness even when a recent account check succeeds", async () => {
    const store = await memory();
    const client = api(
      store,
      vi.fn(async () =>
        event(snapshot(undefined, now - 240000)),
      ) as typeof fetch,
    );
    const result = await client.wallet(address);
    expect(result.accountFreshness).toEqual({
      receivedAt: now,
      sourceAt: now - 240000,
      stale: true,
      refreshing: false,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports invalid or excessively future account clocks as unavailable and stale", async () => {
    const store = await memory(),
      client = api(store, vi.fn<typeof fetch>());
    const read = vi.spyOn(client, "snapshot");
    for (const indexedThroughTimestamp of [
      Number.MAX_SAFE_INTEGER,
      (now + 31000) / 1000,
    ]) {
      read.mockResolvedValue({
        value: { ...snapshot(), indexedThroughTimestamp },
        receivedAt: now,
        stale: false,
      });
      expect((await client.wallet(address)).accountFreshness).toEqual({
        receivedAt: now,
        sourceAt: null,
        stale: true,
        refreshing: false,
      });
    }
    read.mockResolvedValue({
      value: snapshot(),
      receivedAt: NaN,
      stale: false,
    });
    expect((await client.wallet(address)).accountFreshness).toEqual({
      receivedAt: null,
      sourceAt: now,
      stale: true,
      refreshing: false,
    });
  });

  it("returns saved data at 1500ms while the shared refresh persists its eventual result", async () => {
    const store = await memory();
    const saved = snapshot("4651000000000000000000000", oldAt);
    await store.put(`cache:wallet:${address}`, saved, oldAt);
    const load = deferredFetch(),
      client = api(store, load.fetcher as typeof fetch);
    let settled = false;
    const request = client.wallet(address).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(1499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await request;
    expect(result.snapshot?.balance).toBe(saved.balance);
    expect(result.accountFreshness).toEqual({
      receivedAt: oldAt,
      sourceAt: oldAt,
      stale: true,
      refreshing: true,
    });
    expect(result.cashflows.items).toHaveLength(1);
    load.resolve(event());
    await vi.advanceTimersByTimeAsync(0);
    expect(
      (await store.get<WalletSnapshot>(`cache:wallet:${address}`))?.value
        .balance,
    ).toBe(snapshot().balance);
    const followup = await client.wallet(address);
    expect(followup.accountFreshness).toEqual({
      receivedAt: now + 1500,
      sourceAt: now,
      stale: false,
      refreshing: false,
    });
    expect(load.fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains history on a cold timeout and handles a late failure without a follow-up request storm", async () => {
    const store = await memory(),
      load = deferredFetch();
    const client = api(store, load.fetcher as typeof fetch);
    const request = client.wallet(address);
    await vi.advanceTimersByTimeAsync(1500);
    const result = await request;
    expect(result.snapshot).toBeNull();
    expect(result.accountFreshness).toEqual({
      receivedAt: null,
      sourceAt: null,
      stale: true,
      refreshing: true,
    });
    expect(result.cashflows.items).toHaveLength(1);
    load.reject(new Error("source unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    const following = await client.wallet(address);
    expect(following.accountFreshness).toEqual({
      receivedAt: null,
      sourceAt: null,
      stale: true,
      refreshing: false,
    });
    expect(following.errors.join(" ")).toContain("source unavailable");
    expect(load.fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares one fetch across simultaneous viewers and instances, then keeps the existing TTL", async () => {
    const store = await memory(),
      load = deferredFetch(),
      coordinator = new LocalCoordinator();
    await store.put(`cache:wallet:${address}`, snapshot("1", oldAt), oldAt);
    const first = api(store, load.fetcher as typeof fetch, coordinator);
    const second = api(store, load.fetcher as typeof fetch, coordinator);
    const views = Array.from({ length: 12 }, (_, i) =>
      (i % 2 ? first : second).wallet(address),
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(load.fetcher).toHaveBeenCalledTimes(1);
    load.resolve(event());
    await vi.advanceTimersByTimeAsync(100);
    for (const result of await Promise.all(views)) {
      expect(result.snapshot?.balance).toBe(snapshot().balance);
      expect(result.accountFreshness?.refreshing).toBe(false);
    }
    await vi.advanceTimersByTimeAsync(29000);
    await Promise.all([first.wallet(address), second.wallet(address)]);
    expect(load.fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves shared Retry-After for failed refreshes and reports no refresh while in backoff", async () => {
    const store = await memory(),
      coordinator = new LocalCoordinator();
    await store.put(`cache:wallet:${address}`, snapshot("1", oldAt), oldAt);
    const fetcher = vi.fn(
      async () =>
        new Response("", { status: 429, headers: { "Retry-After": "90" } }),
    );
    const first = api(store, fetcher as typeof fetch, coordinator),
      second = api(store, fetcher as typeof fetch, coordinator);
    expect((await first.wallet(address)).accountFreshness).toEqual({
      receivedAt: oldAt,
      sourceAt: oldAt,
      stale: true,
      refreshing: false,
    });
    expect((await second.wallet(address)).accountFreshness?.refreshing).toBe(
      false,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      (await store.get<{ until: number }>(`cache-error:wallet:${address}`))
        ?.value.until,
    ).toBe(now + 90000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps the opt-in wait and rejects invalid budgets before admitting a loader", async () => {
    const store = await memory(),
      client = api(store, vi.fn<typeof fetch>());
    let release!: (value: string) => void;
    const loader = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    for (const waitMs of [-1, NaN, 1.5])
      await expect(
        client.cached("invalid", 30000, loader, { waitMs }),
      ).rejects.toThrow("Invalid cache refresh wait budget");
    expect(loader).not.toHaveBeenCalled();
    await store.put("cache:budget", "saved", oldAt);
    const request = client.cached("budget", 30000, loader, { waitMs: 100000 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(await request).toMatchObject({ value: "saved", refreshing: true });
    release("late");
    await vi.advanceTimersByTimeAsync(0);
    expect((await store.get("cache:budget"))?.value).toBe("late");
    expect(vi.getTimerCount()).toBe(0);
  });
});
