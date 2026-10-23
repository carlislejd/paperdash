import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Overview,
  ProtocolSummary,
} from "../../../packages/shared/src/types.js";
import { Collector, readOverviewSnapshot } from "../src/collector.js";
import { createStore, type Store } from "../src/store.js";
import { Upstream } from "../src/upstream.js";
import { ChangeBus } from "../src/bus.js";

const start = 1_800_000_000_000;
const summary: ProtocolSummary = {
  ok: true,
  source: { at: start, block: "1" },
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
let store: Store;
let upstream: Upstream;
let bus: ChangeBus;
let collector: Collector;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  store = await createStore({ memory: true, databaseUrl: "" });
  upstream = new Upstream(store);
  bus = new ChangeBus();
  collector = new Collector(store, upstream, bus, null);
  await store.put("summary", summary);
  await store.sample(start, 1);
});
afterEach(async () => {
  await collector.stop();
  await upstream.close();
  bus.close();
  await store.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function countWrites(spy: ReturnType<typeof vi.spyOn>, key: string) {
  return spy.mock.calls.filter(([name]) => name === key).length;
}

// No source sockets or HTTP are needed to exercise the real collector lanes.
describe("collector persistence coalescing", () => {
  it("coalesces concurrent publications and skips all overview reads/writes for idle maintenance loops", async () => {
    const points = vi.spyOn(store.history, "protocolPoints");
    const samples = vi.spyOn(store, "samples");
    const trades = vi.spyOn(store, "trades");
    const bounds = vi.spyOn(store, "eventBounds");
    const put = vi.spyOn(store, "put");
    await Promise.all(Array.from({ length: 20 }, () => collector["publish"]()));
    expect(points).toHaveBeenCalledTimes(1);
    expect(countWrites(put, "overview")).toBe(1);
    const work = vi.fn(async () => {});
    collector["loop"]("maintenance", 100, work);
    await vi.advanceTimersByTimeAsync(10000);
    expect(work).toHaveBeenCalledTimes(101);
    expect(points).toHaveBeenCalledTimes(1);
    expect(samples).toHaveBeenCalledTimes(1);
    expect(trades).toHaveBeenCalledTimes(1);
    expect(bounds).toHaveBeenCalledTimes(1);
    expect(countWrites(put, "overview")).toBe(1);
    expect(countWrites(put, "collector-heartbeat")).toBe(3);
    expect(
      (await store.get<{ at: number }>("collector-heartbeat"))!.value.at,
    ).toBe(start + 10000);
    expect((await readOverviewSnapshot(store)).overview.status).toMatchObject({
      receivedAt: start,
      sourceAt: start,
      stale: false,
    });
  });

  it("persists health changes and expiry without source reads or advancing the snapshot replay cursor", async () => {
    await collector["publish"]();
    await collector["persistStatus"]();
    const saved = await readOverviewSnapshot(store);
    const points = vi.spyOn(store.history, "protocolPoints");
    const bounds = vi.spyOn(store, "eventBounds");
    const put = vi.spyOn(store, "put");
    // A financial event after the snapshot still has to be replayed, even when
    // a health-only snapshot is saved after this event commits.
    const event = await store.event({
      type: "history",
      data: {
        history: [{ time: start, value: 2 }],
        historyCoverage: "observed",
      },
    });
    collector["errors"].set("maintenance", "temporarily unavailable");
    await collector["persistStatus"]();
    await collector["publish"](false);
    expect(countWrites(put, "collector-heartbeat")).toBe(1);
    expect((await readOverviewSnapshot(store)).cursor).toBe(saved.cursor);
    expect((await store.events(saved.cursor)).map((row) => row.id)).toContain(
      event,
    );
    collector["errors"].delete("maintenance");
    await collector["persistStatus"]();
    await collector["publish"](false);
    expect(countWrites(put, "collector-heartbeat")).toBe(2);
    vi.setSystemTime(start + 15001);
    await collector["publish"](false);
    const expired = (await store.get<Overview>("overview"))!.value;
    expect(expired.status).toMatchObject({
      receivedAt: start,
      sourceAt: start,
      stale: true,
    });
    expect(expired.status.message).toBeUndefined();
    expect(points).not.toHaveBeenCalled();
    expect(bounds).not.toHaveBeenCalled();
    expect(countWrites(put, "overview")).toBe(3);
  });

  it("folds invalidations during slow reads into one follow-up and keeps cursor capture before financial reads", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = store.samples.bind(store);
    const samples = vi
      .spyOn(store, "samples")
      .mockImplementationOnce(async () => {
        entered();
        await gate;
        return original();
      });
    const bounds = vi.spyOn(store, "eventBounds");
    const first = collector["publish"]();
    await reading;
    const later = Array.from({ length: 20 }, () => collector["publish"]());
    await store.sample(start, 2);
    release();
    await Promise.all([first, ...later]);
    expect(samples).toHaveBeenCalledTimes(2);
    expect(bounds).toHaveBeenCalledTimes(2);
    expect(bounds.mock.invocationCallOrder[0]).toBeLessThan(
      samples.mock.invocationCallOrder[0],
    );
    expect(bounds.mock.invocationCallOrder[1]).toBeLessThan(
      samples.mock.invocationCallOrder[1],
    );
    expect((await store.get<Overview>("overview"))!.value.history).toEqual([
      { time: start, value: 2 },
    ]);
  });

  it("does not lose a refresh arriving between drain completion and promise settlement", async () => {
    const original = collector["publishOverview"].bind(collector);
    const samples = vi.spyOn(store, "samples");
    let late!: Promise<void>;
    let requested!: () => void;
    const request = new Promise<void>((resolve) => {
      requested = resolve;
    });
    vi.spyOn(
      collector as unknown as { publishOverview(): Promise<void> },
      "publishOverview",
    ).mockImplementationOnce(async () => {
      await original();
      // The first microtask queues the caller behind the drain's continuation,
      // but ahead of the run's promise-settlement callbacks.
      void Promise.resolve().then(() =>
        Promise.resolve().then(() => {
          late = collector["publish"]();
          requested();
        }),
      );
    });
    await collector["publish"]();
    await request;
    await late;
    expect(samples).toHaveBeenCalledTimes(2);
  });

  it("periodically advances replay after identical full source reads while preserving source receipt clocks", async () => {
    await collector["publish"]();
    const initial = await readOverviewSnapshot(store);
    const latest = (await store.eventBounds()).latest!;
    expect(latest).not.toBe(initial.cursor);
    const put = vi.spyOn(store, "put");
    vi.setSystemTime(start + 1000);
    await collector["publish"]();
    expect((await readOverviewSnapshot(store)).cursor).toBe(initial.cursor);
    expect(countWrites(put, "overview")).toBe(0);
    vi.setSystemTime(start + 10000);
    await collector["publish"]();
    expect(countWrites(put, "overview")).toBe(1);
    const refreshed = await readOverviewSnapshot(store);
    expect(refreshed.cursor).toBe(latest);
    expect(refreshed.overview.status).toMatchObject({
      receivedAt: start,
      sourceAt: start,
    });
  });

  it("retries failed snapshot persistence without losing dirty sources or falsifying receipt clocks", async () => {
    await collector["publish"]();
    await store.put(
      "summary",
      { ...summary, source: { at: start + 1, block: "2" } },
      start + 1,
    );
    const original = store.put.bind(store);
    vi.spyOn(store, "put").mockImplementationOnce(async (key, value, at) => {
      if (key === "overview") throw new Error("write unavailable");
      return original(key, value, at);
    });
    await expect(collector["publish"]()).rejects.toThrow("write unavailable");
    await collector["publish"](false);
    expect((await store.get<Overview>("overview"))!.value.status).toMatchObject({
      receivedAt: start + 1,
      sourceAt: start + 1,
      indexedBlock: "2",
    });
  });

  it.each([false, true])(
    "retains source invalidation after heartbeat failure when source work partially fails: %s",
    async (partialFailure) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      await collector["publish"]();
      const original = store.put.bind(store);
      let failHeartbeat = true;
      vi.spyOn(store, "put").mockImplementation(async (key, value, at) => {
        if (key === "collector-heartbeat" && failHeartbeat) {
          failHeartbeat = false;
          throw new Error("heartbeat unavailable");
        }
        return original(key, value, at);
      });
      const reads = vi.spyOn(store.history, "protocolPoints");
      const corrected = { time: start - 60000, value: 2 };
      const sourceWork = vi.fn(async () => {
        await store.history.retainProtocol([corrected]);
        if (partialFailure) throw new Error("partial source persistence");
      });
      collector["loop"]("history", 3600000, sourceWork, true);
      await vi.advanceTimersByTimeAsync(0);
      expect(failHeartbeat).toBe(false);
      expect(reads).not.toHaveBeenCalled();
      expect(
        (await store.get<Overview>("overview"))!.value.history,
      ).not.toContainEqual(corrected);

      // An unrelated loop must recover the committed source change immediately;
      // the hourly source lane has not run again and must not be required.
      collector["loop"]("maintenance", 1000, async () => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(sourceWork).toHaveBeenCalledTimes(1);
      expect(reads).toHaveBeenCalledTimes(1);
      const recovered = (await store.get<Overview>("overview"))!.value;
      expect(recovered.history).toContainEqual(corrected);
      expect(recovered.status).toMatchObject({
        receivedAt: start,
        sourceAt: start,
      });
      expect(recovered.status.message).toBe(
        partialFailure ? "history: partial source persistence" : undefined,
      );
    },
  );

  it("reconciles a committed trade when its acknowledgement is lost, before the duplicate retry", async () => {
    await collector["publish"]();
    const original = store.recordTrade.bind(store);
    vi.spyOn(store, "recordTrade").mockImplementationOnce(async (trade) => {
      await original(trade);
      throw new Error("commit acknowledgement lost");
    });
    collector["intake"].start();
    collector["intake"].enqueue(
      [{
        ts: start,
        wallet: `0x${"1".repeat(40)}`,
        instrument: "BTC",
        side: "long",
        leverage: 2,
        notionalUsd: 10,
        kind: "open",
        pnlUsd: null,
      }],
      "public-stream",
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(collector["intake"].snapshot().retrying).toBe(true);
    expect((await store.get<Overview>("overview"))!.value.trades).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(collector["intake"].snapshot().retrying).toBe(false);
    expect((await store.get<Overview>("overview"))!.value.trades).toHaveLength(1);
  });

  it("refreshes the saved trade snapshot after a committed intake batch and keeps idle ticks cheap", async () => {
    await collector["publish"]();
    const reads = vi.spyOn(store, "trades");
    collector["intake"].start();
    collector["intake"].enqueue(
      Array.from({ length: 5 }, (_, i) => ({
        ts: start + i,
        wallet: `0x${"1".repeat(40)}`,
        instrument: "BTC",
        side: "long",
        leverage: 2,
        notionalUsd: 10,
        kind: "open",
        pnlUsd: null,
      })),
      "public-stream",
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect((await store.get<Overview>("overview"))!.value.trades).toHaveLength(5);
    const afterBatch = reads.mock.calls.length;
    expect(afterBatch).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(4000);
    expect(reads).toHaveBeenCalledTimes(afterBatch);
  });
});
