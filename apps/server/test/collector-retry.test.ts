import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Collector } from "../src/collector.js";
import { createStore, type Store } from "../src/store.js";
import { Upstream, UpstreamError } from "../src/upstream.js";
import { CoordinationError } from "../src/coordination.js";
import { ChangeBus } from "../src/bus.js";
import { config } from "../src/config.js";
vi.mock("../src/market-feed.js", () => ({
  MarketFeed: class {
    start() {}
    async stop() {}
  },
}));

// Exercise the real collector scheduling and persistence without connecting a
// test to the public exchange WebSocket or making any upstream HTTP requests.
vi.mock("centrifuge", () => ({
  Centrifuge: class {
    on() {
      return this;
    }
    connect() {}
    disconnect() {}
    newSubscription() {
      return {
        on() {
          return this;
        },
        subscribe() {},
        unsubscribe() {},
      };
    }
  },
}));

let store: Store;
let collector: Collector;
let upstream: Upstream;
let bus: ChangeBus;
const historyPath = "/query/protocol/history?interval=1h";
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1800000000000);
  vi.spyOn(console, "error").mockImplementation(() => {});
  store = await createStore({ memory: true, databaseUrl: "" });
  upstream = new Upstream(store);
  bus = new ChangeBus();
  collector = new Collector(store, upstream, bus);
});
afterEach(async () => {
  await collector.stop();
  await upstream.close();
  bus.close();
  await store.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function source(path: string): unknown {
  if (path === "/query/protocol/summary")
    return {
      ok: true,
      source: { block: "1", at: Date.now() },
      balances: {
        tvl: "1000000000000000000",
        margin: "0",
        lp: "0",
        reserve: "0",
        queue: "0",
      },
      activity: { volume: "0", open: 0 },
      fees: { pending: "0", lifetime: "0" },
      paper: { supply: "0", staked: "0" },
    };
  if (path === historyPath)
    return {
      startMs: Math.floor(Date.now() / 3600000) * 3600000 - 3600000,
      intervalMs: 3600000,
      source: { asOfMs: Date.now(), revision: "1", generation: "test" },
      columns: { tvl: [1] },
    };
  if (path === "/query/protocol/trades/recent") return { ok: true, events: [] };
  if (path.startsWith("/state/leaderboard/accounts?"))
    return {
      ok: true,
      accounts: [],
      count: 0,
      pageInfo: { page: 0, totalPages: 1 },
      summary: {
        uniqueAccounts: 0,
        trackedBalance: "0",
        trackedQueued: "0",
        trackedOpenNotional: "0",
        trackedPaper: "0",
      },
    };
  throw new Error(`Unexpected test source request: ${path}`);
}
function failFirst(path: string, error: Error) {
  let attempts = 0;
  const spy = vi
    .spyOn(upstream, "request")
    .mockImplementation(async <T>(requestPath: string) => {
      if (requestPath === path && attempts++ === 0) throw error;
      return source(requestPath) as T;
    });
  return () =>
    spy.mock.calls.filter(([requestPath]) => requestPath === path).length;
}

describe("collector loop recovery", () => {
  it("retries an hourly collection failure after 30 seconds, clears its error, and restores the normal interval", async () => {
    const count = failFirst(
      historyPath,
      new CoordinationError("Redis temporarily unavailable"),
    );
    const timers = vi.spyOn(globalThis, "setTimeout");
    await collector.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(count()).toBe(1);
    expect(
      (await store.get<{ errors: Record<string, string> }>(
        "collector-heartbeat",
      ))!.value.errors.history,
    ).toContain("Redis temporarily unavailable");
    await vi.advanceTimersByTimeAsync(29999);
    expect(count()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(count()).toBe(2);
    expect(
      (await store.get<{ errors: Record<string, string> }>(
        "collector-heartbeat",
      ))!.value.errors.history,
    ).toBeUndefined();
    expect(await store.history.protocolPoints()).toHaveLength(1);
    expect(
      timers.mock.calls.filter(([, delay]) => delay === config.historyInterval),
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(count()).toBe(2);
  });
  it("waits for an upstream Retry-After deadline longer than the shortened retry interval", async () => {
    const count = failFirst(
      historyPath,
      new UpstreamError("rate limited", 429, Date.now() + 90000),
    );
    await collector.start();
    await vi.advanceTimersByTimeAsync(89999);
    expect(count()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(count()).toBe(2);
    expect(
      (await store.get<{ errors: Record<string, string> }>(
        "collector-heartbeat",
      ))!.value.errors.history,
    ).toBeUndefined();
  });
  it("keeps a normally fast loop at its existing interval after a transient failure", async () => {
    const count = failFirst(
      "/query/protocol/summary",
      new Error("temporary outage"),
    );
    await collector.start();
    await vi.advanceTimersByTimeAsync(config.summaryInterval - 1);
    expect(count()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(count()).toBe(2);
    expect((await store.get("summary"))?.value).toBeDefined();
  });
});
