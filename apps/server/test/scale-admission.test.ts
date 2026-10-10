import { afterEach, expect, it, vi } from "vitest";
import { createStore, type Store } from "../src/store.js";
import { Upstream, RequestGate } from "../src/upstream.js";
import { LocalCoordinator } from "../src/coordination.js";
import { buildApi } from "../src/api.js";
import { emptyOverview } from "../src/collector.js";
import { normalizeTrade, walletSchema } from "../src/schemas.js";
import { assetNotionals, houseSchema } from "../src/assets.js";
const stores: Store[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
});
async function fixture() {
  const store = await createStore({ memory: true, databaseUrl: "" });
  stores.push(store);
  return store;
}
it("bounds cold distinct refreshes, serves saved values, and releases slots after failure", async () => {
  const store = await fixture();
  const api = new Upstream(
    store,
    vi.fn() as typeof fetch,
    "https://invalid.example",
    new RequestGate(3, 0),
    new LocalCoordinator(),
  );
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const loader = vi.fn(async () => {
    await wait;
    return "ready";
  });
  const running = Array.from({ length: 32 }, (_, i) =>
    api.cached(`cold:${i}`, 1000, loader),
  );
  try {
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(32));
    await expect(api.cached("overflow", 1000, loader)).rejects.toMatchObject({
      status: 503,
    });
    await store.put("cache:saved", "retained", Date.now() - 10000);
    expect(await api.cached("saved", 1000, loader)).toMatchObject({
      value: "retained",
      stale: true,
      error: expect.stringContaining("capacity"),
    });
    const joined = api.cached("cold:0", 1000, loader);
    release();
    await Promise.all(running);
    expect((await joined).value).toBe("ready");
    expect((await api.cached("new", 1000, async () => "new")).value).toBe(
      "new",
    );
  } finally {
    release();
    await api.close();
  }
});
it("coalesces HTTP reads while preserving original source age and re-evaluating stale after cache expiry", async () => {
  const store = await fixture();
  let now = 1800000000000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  await store.put("overview", {
    ...emptyOverview("local"),
    status: {
      ...emptyOverview("local").status,
      sourceAt: now,
      receivedAt: now,
      stale: false,
      stream: "connected",
    },
  });
  const reads = vi.spyOn(store, "get");
  const app = await buildApi(store, undefined, undefined, {
    logger: false,
    rateLimit: 10000,
  });
  try {
    const responses = await Promise.all(
      Array.from({ length: 100 }, () => app.inject("/api/overview")),
    );
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    expect(reads).toHaveBeenCalledTimes(1);
    now += 16000;
    const next = (await app.inject("/api/overview")).json();
    expect(next.status).toMatchObject({
      stale: true,
      receivedAt: now - 16000,
      stream: "disconnected",
    });
    expect(reads).toHaveBeenCalledTimes(2);
  } finally {
    await app.close();
  }
});
it("retains and aggregates ten-billion-dollar positions at1000x without integer truncation or duplicate totals", async () => {
  const store = await fixture();
  const now = Date.now(),
    address = `0x${"1".repeat(40)}`;
  for (let i = 0; i < 100; i++) {
    const value = normalizeTrade(
      {
        seq: String(i),
        ts: now - 1000,
        wallet: address,
        instrument: "BTC",
        side: i % 2 ? "short" : "long",
        leverage: 1000,
        notionalUsd: 10_000_000_000,
        kind: i % 3 ? "open" : "liq",
        pnlUsd: null,
      },
      "recent-api",
    );
    await store.recordTrade(value);
    expect(await store.recordTrade(value)).toBe(false);
  }
  const [activity] = await store.analytics.activity([0], now);
  expect(activity.counts.total).toBe(100);
  expect(activity.notionalUsd).toEqual({
    total: 1_000_000_000_000,
    long: 500_000_000_000,
    short: 500_000_000_000,
  });
  expect(
    activity.recent.every(
      (trade) =>
        trade.leverage === 1000 && trade.notionalUsd === 10_000_000_000,
    ),
  ).toBe(true);
  const raw = "10000000000000000000000000000";
  const parsed = walletSchema.parse({
    address,
    indexedThroughBlock: 100,
    indexedThroughTimestamp: Math.floor(now / 1000),
    accountRevision: 1,
    balance: raw,
    queued: "0",
    locked: "0",
    paper: { balance: "0", staked: "0" },
    lifetime: {
      depositedRaw: raw,
      withdrawnRaw: "0",
      realizedPnlRaw: "0",
      feesPaidRaw: "0",
      tradedNotionalRaw: raw,
      paperRewardsClaimedRaw: "0",
    },
    openPositions: [],
  });
  expect(parsed.lifetime.depositedRaw).toBe(raw);
  const assets = assetNotionals(
    houseSchema.parse({
      ok: true,
      historyGeneration: "a",
      historyRevision: "1",
      sourceAsOfMs: now,
      head: [now, 1e10, -1e10, 0, 1e10, 1e10, 0, 0],
    }),
  );
  expect(assets[0].openInterest.totalRaw).toBe("20000000000000000000000000000");
  expect(assets[0].openInterest.longSharePct).toBe(50);
});

it("admits a shared-NAT burst above sixty SSE connections and returns bounded-capacity retry guidance", async () => {
  const { EventHub } = await import("../src/event-hub.js");
  const store = await fixture();
  const joining = vi
    .spyOn(EventHub.prototype, "add")
    .mockImplementation(async (response) => {
      response.end();
    });
  const app = await buildApi(store, undefined, undefined, { logger: false });
  try {
    const responses = await Promise.all(
      Array.from({ length: 100 }, () =>
        app.inject("/api/events?topics=overview"),
      ),
    );
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    expect(joining).toHaveBeenCalledTimes(100);
    vi.spyOn(EventHub.prototype, "size", "get").mockReturnValue(6000);
    const full = await app.inject("/api/events");
    expect(full.statusCode).toBe(503);
    expect(full.headers["retry-after"]).toBe("15");
    expect(joining).toHaveBeenCalledTimes(100);
  } finally {
    await app.close();
  }
});

it("serves1000 distinct cold-wallet requests with bounded admission while source snapshots hang and awaits background work on close", async () => {
  const store = await fixture();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetcher = vi.fn(async (url: URL | RequestInfo) => {
    const address = new URL(String(url)).searchParams.get("wallet");
    await pending;
    return new Response(
      `event: wallet\ndata: ${JSON.stringify({ address, indexedThroughBlock: 100, indexedThroughTimestamp: Math.floor(Date.now() / 1000), accountRevision: 1, balance: "10000000000000000000000000000", queued: "0", locked: "0", paper: { balance: "0", staked: "0" }, lifetime: { depositedRaw: "10000000000000000000000000000", withdrawnRaw: "0", realizedPnlRaw: "0", feesPaidRaw: "0", tradedNotionalRaw: "0", paperRewardsClaimedRaw: "0" }, openPositions: [] })}\n\n`,
    );
  });
  const upstream = new Upstream(
    store,
    fetcher as typeof fetch,
    "https://invalid.example",
    new RequestGate(3, 0),
    new LocalCoordinator(),
  );
  const app = await buildApi(store, upstream, undefined, { logger: false });
  try {
    const responses = await Promise.all(
      Array.from({ length: 1000 }, (_, i) =>
        app.inject(`/api/wallets/0x${(i + 1).toString(16).padStart(40, "0")}`),
      ),
    );
    const accepted = responses.filter((r) => r.statusCode === 200),
      rejected = responses.filter((r) => r.statusCode === 503);
    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted.length).toBeLessThanOrEqual(32);
    expect(accepted.length + rejected.length).toBe(1000);
    expect(
      accepted.every(
        (r) =>
          r.json().snapshot === null &&
          r.json().stale &&
          r
            .json()
            .errors.some((error: string) => error.includes("being collected")),
      ),
    ).toBe(true);
    expect(rejected.every((r) => r.headers["retry-after"] === "2")).toBe(true);
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(3);
    let closed = false;
    const closing = upstream.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(32);
    const saved = await store.get(
      "cache:wallet:0x0000000000000000000000000000000000000001",
    );
    expect(saved).not.toBeNull();
  } finally {
    release();
    await app.close();
    await upstream.close();
  }
});
