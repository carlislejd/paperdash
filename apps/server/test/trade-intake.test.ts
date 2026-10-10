import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "../src/store.js";
import { TradeIntake } from "../src/trade-intake.js";
import { normalizeTrade } from "../src/schemas.js";
import { InboxCapacityError } from "../src/trade-inbox-store.js";

let store: Store;
let intake: TradeIntake;
let paths: string[];
const now = 1800000000000;
function wire(n: number) {
  return {
    ts: now,
    wallet: `0x${n.toString(16).padStart(40, "0")}`,
    instrument: "BTC",
    side: "long",
    leverage: 5,
    notionalUsd: n * 10,
    kind: "liq",
    pnlUsd: -n,
  };
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.spyOn(console, "error").mockImplementation(() => {});
  paths = [];
  store = await createStore({ memory: true, databaseUrl: "" });
  intake = new TradeIntake(store);
});
afterEach(async () => {
  const stopped = intake.stop(0).catch(() => {});
  await vi.advanceTimersByTimeAsync(1);
  await stopped;
  await store.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const path of paths) await rm(path, { recursive: true, force: true });
});

describe("bounded durable trade intake", () => {
  it("retries a committed write with a lost reply using the same ID, discovers its wallet, and retains the batch suffix exactly once", async () => {
    const original = store.recordTrade.bind(store);
    let lost = true;
    const record = vi
      .spyOn(store, "recordTrade")
      .mockImplementation(async (value) => {
        const result = await original(value);
        if (lost) {
          lost = false;
          throw new Error("Query read timeout");
        }
        return result;
      });
    const discover = vi.spyOn(store.history, "ensureWallet");
    intake.enqueue([wire(1), wire(2), wire(3)], "public-stream");
    await vi.advanceTimersByTimeAsync(0);
    const ids = (await store.tradeInbox.head()).map((value) => value.id);
    expect(ids).toHaveLength(3);
    expect(await store.trades()).toHaveLength(1);
    expect(discover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(record.mock.calls.map(([value]) => value.id)).toEqual([
      ids[0],
      ids[0],
      ids[1],
      ids[2],
    ]);
    expect(discover).toHaveBeenCalledTimes(3);
    expect(discover).toHaveBeenCalledWith(wire(1).wallet, 20);
    expect(await store.trades()).toHaveLength(3);
    expect(await store.events()).toHaveLength(3);
    expect((await store.analytics.activity([0], now))[0].counts.total).toBe(3);
    expect((await store.liquidations.stats(undefined, now)).day.count).toBe(3);
    expect((await store.tradeInbox.status()).pending).toBe(0);
  });

  it("keeps a normalized batch unchanged when inbox COMMIT succeeds but its reply is lost", async () => {
    const original = store.tradeInbox.append.bind(store.tradeInbox);
    let lost = true;
    const append = vi
      .spyOn(store.tradeInbox, "append")
      .mockImplementation(async (values, at) => {
        await original(values, at);
        if (lost) {
          lost = false;
          throw new Error("Query read timeout");
        }
      });
    intake.enqueue([wire(1), wire(2)], "public-stream");
    await vi.advanceTimersByTimeAsync(0);
    expect(intake.snapshot().memoryRecords).toBe(2);
    expect((await store.tradeInbox.status()).pending).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(append.mock.calls[1][0]).toEqual(append.mock.calls[0][0]);
    expect(await store.trades()).toHaveLength(2);
    expect(await store.events()).toHaveLength(2);
    expect(intake.snapshot().memoryRecords).toBe(0);
  });

  it("retains failures before commit and retries wallet discovery and unknown acknowledgement without double counting", async () => {
    const record = vi
      .spyOn(store, "recordTrade")
      .mockRejectedValueOnce(new Error("ECONNRESET"));
    const discover = vi
      .spyOn(store.history, "ensureWallet")
      .mockRejectedValueOnce(new Error("ECONNRESET"));
    const ack = store.tradeInbox.acknowledge.bind(store.tradeInbox);
    let lost = true;
    vi.spyOn(store.tradeInbox, "acknowledge").mockImplementation(async (id) => {
      await ack(id);
      if (lost) {
        lost = false;
        throw new Error("Query read timeout");
      }
    });
    intake.enqueue([wire(1), wire(2)], "public-stream");
    await vi.advanceTimersByTimeAsync(0);
    expect(await store.trades()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(8000);
    expect(await store.trades()).toHaveLength(2);
    expect(await store.events()).toHaveLength(2);
    expect((await store.tradeInbox.status()).pending).toBe(0);
    expect(record).toHaveBeenCalledTimes(4);
    expect(discover).toHaveBeenCalledTimes(3);
  });

  it("replays a persisted inbox after process restart and preserves sticky gap evidence", async () => {
    await store.close();
    const dir = await mkdtemp(join(tmpdir(), "paperdash-intake-"));
    paths.push(dir);
    store = await createStore({ dataDir: dir, databaseUrl: "" });
    const values = [
      normalizeTrade(wire(1), "public-stream", "persisted-one"),
      normalizeTrade(wire(2), "public-stream", "persisted-two"),
    ];
    await store.tradeInbox.append(values, now);
    await store.recordTrade(values[0]); // Simulate a crash before wallet discovery/ack.
    await store.tradeInbox.recordGap({
      firstAt: now - 1,
      at: now,
      kind: "malformed",
      count: 1,
      reason: "An earlier observation was malformed.",
    });
    await store.close();
    store = await createStore({ dataDir: dir, databaseUrl: "" });
    intake = new TradeIntake(store);
    const discover = vi.spyOn(store.history, "ensureWallet");
    intake.start();
    await vi.waitFor(async () => expect(await store.trades()).toHaveLength(2));
    await vi.waitFor(async () =>
      expect((await store.tradeInbox.status()).pending).toBe(0),
    );
    expect(await store.events()).toHaveLength(2);
    expect(discover).toHaveBeenCalledTimes(2);
    expect((await store.tradeInbox.status()).pending).toBe(0);
    expect(intake.snapshot().gap?.firstAt).toBe(now - 1);
  });

  it("bounds memory and retry work under overload without deleting admitted observations", async () => {
    const overflow = vi.fn(),
      recovered = vi.fn();
    intake = new TradeIntake(
      store,
      { overflow, capacityAvailable: recovered },
      { records: 3, bytes: 1048576 },
    );
    const append = vi
      .spyOn(store.tradeInbox, "append")
      .mockRejectedValue(new Error("Database unavailable"));
    intake.enqueue(
      [wire(1), wire(2), wire(3), wire(4), wire(5)],
      "public-stream",
    );
    for (let i = 0; i < 1000; i++) intake.enqueue([wire(6)], "public-stream");
    await vi.advanceTimersByTimeAsync(31000);
    expect(intake.snapshot()).toMatchObject({
      memoryRecords: 3,
      admissionPaused: true,
      gap: { kind: "overflow", count: 2 },
    });
    expect(overflow).toHaveBeenCalledTimes(1);
    expect(append.mock.calls.length).toBeLessThanOrEqual(7);
    expect(vi.getTimerCount()).toBe(1);
    append.mockRestore();
    await vi.advanceTimersByTimeAsync(15000);
    expect(await store.trades()).toHaveLength(3);
    expect((await store.tradeInbox.status()).gap?.kind).toBe("overflow");
    expect(intake.snapshot().memoryRecords).toBe(0);
    expect(intake.canAccept).toBe(true);
    expect(recovered).toHaveBeenCalledTimes(1);
    intake.enqueue([wire(6)], "public-stream");
    await vi.advanceTimersByTimeAsync(0);
    expect(await store.trades()).toHaveLength(4);
    expect((await store.tradeInbox.status()).gap?.kind).toBe("overflow");
  });

  it("independently enforces the byte bound and preserves valid neighbors of a malformed row", async () => {
    intake.enqueue(
      [wire(1), { ...wire(2), side: "invalid" }, wire(3)],
      "public-stream",
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(await store.trades()).toHaveLength(2);
    expect((await store.tradeInbox.status()).gap).toMatchObject({
      kind: "malformed",
      count: 1,
    });
    intake.enqueue([wire(4)], "public-stream");
    await vi.advanceTimersByTimeAsync(1000);
    expect(intake.snapshot().gap?.kind).toBe("malformed");
    await intake.stop();
    intake = new TradeIntake(store, {}, { records: 1000, bytes: 1 });
    intake.enqueue([wire(5)], "public-stream");
    expect(intake.snapshot()).toMatchObject({
      memoryBytes: 0,
      memoryRecords: 0,
      admissionPaused: true,
      gap: { kind: "overflow", count: 1 },
    });
    await vi.advanceTimersByTimeAsync(0);
  });

  it("does not read more than 50 durable rows or re-admit completed recent observations", async () => {
    const values = Array.from({ length: 50 }, (_, i) =>
      normalizeTrade({ ...wire(i + 1), seq: String(i + 1) }, "recent-api"),
    );
    await store.tradeInbox.append(values, now);
    await store.tradeInbox.append(
      [normalizeTrade(wire(51), "public-stream", "extra")],
      now,
    );
    expect(await store.tradeInbox.head(100000)).toHaveLength(50);
    await store.recordTrade(values[0]);
    await store.tradeInbox.acknowledge(values[0].id);
    await store.tradeInbox.append([values[0]], now + 1);
    expect((await store.tradeInbox.status()).pending).toBe(50);
  });

  it("bounds shutdown during a persistence outage and reports unconfirmed RAM admissions", async () => {
    vi.spyOn(store.tradeInbox, "append").mockRejectedValue(
      new Error("offline"),
    );
    intake.enqueue([wire(1)], "public-stream");
    await vi.advanceTimersByTimeAsync(0);
    const closing = expect(intake.stop(50)).rejects.toThrow(
      "shutdown deadline",
    );
    await vi.advanceTimersByTimeAsync(60);
    await closing;
    expect(intake.snapshot()).toMatchObject({
      memoryRecords: 1,
      admissionPaused: true,
      gap: { kind: "shutdown", count: 1 },
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(console.error).toHaveBeenCalled();
  });

  it("fails shutdown on the total deadline even while a database operation remains unresolved", async () => {
    let finish!: () => void;
    vi.spyOn(store.tradeInbox, "append").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    intake.enqueue([wire(1)], "public-stream");
    const closing = expect(intake.stop(50)).rejects.toThrow(
      "shutdown deadline",
    );
    await vi.advanceTimersByTimeAsync(50);
    await closing;
    expect(intake.canAccept).toBe(false);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(await store.trades()).toHaveLength(0);
  });

  it("frees durable capacity during healthy shutdown until RAM is saved, without resuming admission", async () => {
    const retained = normalizeTrade(wire(1), "public-stream", "old-head");
    await store.tradeInbox.append([retained], now);
    const append = store.tradeInbox.append.bind(store.tradeInbox);
    vi.spyOn(store.tradeInbox, "append").mockImplementation(
      async (values, at) => {
        if ((await store.tradeInbox.status()).pending)
          throw new InboxCapacityError();
        return append(values, at);
      },
    );
    const resumed = vi.fn();
    intake = new TradeIntake(store, { capacityAvailable: resumed });
    intake.enqueue([wire(2)], "public-stream");
    const closing = intake.stop(1000);
    await vi.advanceTimersByTimeAsync(20);
    await closing;
    expect(intake.snapshot().memoryRecords).toBe(0);
    expect((await store.tradeInbox.head()).map((row) => row.wallet)).toEqual([
      wire(2).wallet,
    ]);
    expect((await store.trades()).map((row) => row.wallet)).toEqual([
      wire(1).wallet,
    ]);
    expect(resumed).not.toHaveBeenCalled();
  });

  it("marks old durable backlog delayed until its retained head catches up", async () => {
    await store.tradeInbox.append(
      [normalizeTrade(wire(1), "public-stream", "old")],
      now - 60000,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const record = store.recordTrade.bind(store);
    vi.spyOn(store, "recordTrade").mockImplementation(async (trade) => {
      await gate;
      return record(trade);
    });
    intake.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(intake.snapshot().error).toMatch(/catching up/);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(intake.snapshot().error).toBeNull();
  });
});
