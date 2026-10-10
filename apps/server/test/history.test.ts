import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore, type Store } from "../src/store.js";
import { HistoryIndexer } from "../src/history.js";
import type {
  HistoryJob,
  JobKind,
  SourcePortfolio,
} from "../src/history-store.js";

const address = `0x${"1".repeat(40)}`;
const txHash = `0x${"2".repeat(64)}`;
const item = (time: number, amount = "10000000000000000001") => ({
  timestampMs: time,
  txHash,
  amountRaw: amount,
  kind: "Deposit",
  recipientAmountRaw: null,
  route: null,
  withdrawalStatus: null,
});
const stores: Store[] = [],
  dirs: string[] = [];
async function memory() {
  const s = await createStore({ memory: true });
  stores.push(s);
  return s;
}
async function claim(
  store: Store,
  kind: JobKind,
  at: number,
): Promise<HistoryJob> {
  for (let i = 0; i < 12; i++) {
    const job = await store.history.claimJob(at);
    if (!job) throw new Error(`No ${kind} job due`);
    if (job.kind === kind && !job.correctionId) return job;
    await store.history.failJob(job, "test deferral", at, at + 86400000);
  }
  throw new Error("Job did not become available");
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) await s.close();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("durable source history", () => {
  it("advances pending-correction targets without forgetting absent unresolved withdrawals", async () => {
    let now = 1800000000000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const store = await memory();
    await store.history.ensureWallet(address);
    const a = {
      ...item(100),
      kind: "Withdrawal",
      withdrawalStatus: "in_transit",
    };
    const b = {
      ...item(200),
      kind: "Withdrawal",
      withdrawalStatus: "submitted",
    };
    await store.history.commitPage(
      await claim(store, "cashflows", now),
      { items: [a], nextCursor: null },
      now,
      86400000,
    );
    async function correction() {
      for (let i = 0; i < 10; i++) {
        const job = await store.history.claimJob(now);
        if (job?.state.purpose === "pending") return job;
        if (!job) throw new Error("No pending correction due");
        await store.history.failJob(job, "test deferral", now, now + 86400000);
      }
      throw new Error("Correction did not become available");
    }
    now += 300001;
    await store.history.commitPage(
      await correction(),
      { items: [b, { ...a, withdrawalStatus: "settled" }], nextCursor: null },
      now,
      60000,
    );
    now += 300001;
    const onlyB = await correction();
    expect(onlyB.state.targets).toHaveLength(1);
    const retained = await store.history.readPage<{
      id: string;
      timestampMs: number;
    }>(address, "cashflows");
    expect(onlyB.state.targets).toEqual([
      retained.items.find((r) => r.timestampMs === 200)!.id,
    ]);
    // A has left the source page, but its explicit settlement was retained.
    await store.history.commitPage(
      onlyB,
      { items: [b], nextCursor: null },
      now,
      60000,
    );
    expect(
      (await store.history.readPage(address, "cashflows")).coverage.error,
    ).toBeUndefined();
    now += 300001;
    await store.history.commitPage(
      await correction(),
      { items: [], nextCursor: null },
      now,
      60000,
    );
    expect(
      (await store.history.readPage(address, "cashflows")).coverage.error,
    ).toContain("unresolved");
    expect((await store.history.stats()).pendingCorrections).toBe(1);
    now += 3600001;
    const missing = await correction();
    expect(missing.state.targets).toEqual(onlyB.state.targets);
    await store.history.commitPage(
      missing,
      { items: [{ ...b, withdrawalStatus: "failed" }], nextCursor: null },
      now,
      60000,
    );
    expect((await store.history.stats()).pendingCorrections).toBe(0);
    expect(
      (await store.history.readPage(address, "cashflows")).coverage.error,
    ).toBeUndefined();
  });
  it("does not let viewers shorten failed backfill or independent-head retry windows", async () => {
    let now = 1800000000000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const store = await memory();
    await store.history.ensureWallet(address);
    await store.history.commitPage(
      await claim(store, "cashflows", now),
      { items: [item(100)], nextCursor: "older" },
      now,
      6 * 3600000,
    );
    now += 61000;
    await store.history.ensureWallet(address, 10);
    const backfill = await claim(store, "cashflows", now);
    const retryAt = now + 3600000;
    await store.history.failJob(backfill, "retry after one hour", now, retryAt);
    let head: HistoryJob | null = null;
    for (let i = 0; i < 5 && !head; i++) {
      const candidate = await store.history.claimJob(now);
      if (candidate?.state.purpose === "head") head = candidate;
      else if (candidate)
        await store.history.failJob(
          candidate,
          "test deferral",
          now,
          now + 86400000,
        );
    }
    expect(head).not.toBeNull();
    await store.history.failJob(
      head!,
      "retry head after one hour",
      now,
      retryAt,
    );
    now += 61000;
    await store.history.ensureWallet(address, 20);
    const state = (await store.history.getStatus(address)).find(
      (j) => j.kind === "cashflows",
    )!;
    expect(state.nextRun).toBe(retryAt);
    expect(await store.history.claimJob(now, 120000, "active")).toBeNull();
  });
  it("resumes the cursor and duplicate occurrence carry after restart, without collapsing equal events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paperdash-history-"));
    dirs.push(dir);
    let store = await createStore({ dataDir: dir });
    await store.history.ensureWallet(address);
    const at = Date.now() + 100;
    const first = await claim(store, "cashflows", at);
    await store.history.commitPage(
      first,
      { items: [item(100), item(100)], nextCursor: "older-1" },
      at + 1,
      3600000,
    );
    await store.close();
    store = await createStore({ dataDir: dir });
    stores.push(store);
    const second = await claim(store, "cashflows", at + 1002);
    expect(second.state.cursor).toBe("older-1");
    expect(Object.values(second.state.occurrences!)).toEqual([2]);
    await store.history.commitPage(
      second,
      { items: [item(100), item(99)], nextCursor: null },
      at + 1003,
      3600000,
    );
    const page = await store.history.readPage<Record<string, unknown>>(
      address,
      "cashflows",
      undefined,
      2,
    );
    expect(page.coverage).toMatchObject({
      retainedCount: 4,
      backfillComplete: true,
      sourceComplete: null,
      identityAmbiguous: true,
    });
    const older = await store.history.readPage<Record<string, unknown>>(
      address,
      "cashflows",
      page.nextCursor!,
      2,
    );
    expect(new Set([...page.items, ...older.items].map((r) => r.id)).size).toBe(
      4,
    );
    expect(
      [...page.items, ...older.items].every(
        (r) => r.amountRaw === "10000000000000000001",
      ),
    ).toBe(true);
  });
  it("rolls rows and checkpoint back together if page-observation storage fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paperdash-history-atomic-"));
    dirs.push(dir);
    const store = await createStore({ dataDir: dir });
    stores.push(store);
    await store.history.ensureWallet(address);
    const at = Date.now() + 100,
      job = await claim(store, "cashflows", at);
    const fault = new DatabaseSync(join(dir, "paperdash.sqlite"));
    fault.exec("DROP TABLE history_pages");
    fault.close();
    await expect(
      store.history.commitPage(
        job,
        { items: [item(100)], nextCursor: "next" },
        at + 1,
        60000,
      ),
    ).rejects.toThrow();
    expect(
      (await store.history.readPage(address, "cashflows")).items,
    ).toHaveLength(0);
    expect(
      (await store.history.getStatus(address)).find(
        (j) => j.kind === "cashflows",
      )!.state.cursor,
    ).toBeNull();
  });
  it("detects multi-page cursor cycles and advances empty pages without pretending the backfill is complete", async () => {
    const store = await memory();
    await store.history.ensureWallet(address);
    let at = Date.now() + 100;
    await store.history.commitPage(
      await claim(store, "cashflows", at),
      { items: [], nextCursor: "A" },
      at + 1,
      3600000,
    );
    at += 1002;
    await store.history.commitPage(
      await claim(store, "cashflows", at),
      { items: [item(100)], nextCursor: "B" },
      at + 1,
      3600000,
    );
    at += 1002;
    const cycle = await claim(store, "cashflows", at);
    await expect(
      store.history.commitPage(
        cycle,
        { items: [item(99)], nextCursor: "A" },
        at + 1,
        3600000,
      ),
    ).rejects.toThrow("repeated a cursor");
    const state = (await store.history.getStatus(address)).find(
      (j) => j.kind === "cashflows",
    )!.state;
    expect(state).toMatchObject({ cursor: "B", complete: false });
    expect(
      (await store.history.readPage(address, "cashflows")).coverage
        .retainedCount,
    ).toBe(1);
  });
  it("bounds work per tick and persists an upstream failure with backoff", async () => {
    const store = await memory();
    await store.history.ensureWallet(address, 10);
    const now = Date.now() + 100;
    const loader = vi.fn(async () => {
      throw new Error("source offline");
    });
    const indexer = new HistoryIndexer(store.history, loader, () => now);
    expect(await indexer.tick({ maxRequests: 2 })).toBe(2);
    expect(loader).toHaveBeenCalledTimes(2);
    const status = await store.history.getStatus(address);
    expect(
      status.filter((s) => s.state.error === "source offline"),
    ).toHaveLength(2);
    expect(
      status
        .filter((s) => s.state.failures)
        .every((s) => s.nextRun >= now + 30000),
    ).toBe(true);
  });
  it("retains older protocol points and applies corrected values by timestamp", async () => {
    const store = await memory();
    await store.history.retainProtocol(
      [
        { time: 1, value: 10 },
        { time: 2, value: 20 },
      ],
      100,
    );
    await store.history.retainProtocol(
      [
        { time: 2, value: 25 },
        { time: 3, value: 30 },
      ],
      200,
    );
    await store.history.retainProtocol([{ time: 2, value: 19 }], 99);
    expect(await store.history.protocolPoints()).toEqual([
      { time: 1, value: 10 },
      { time: 2, value: 25 },
      { time: 3, value: 30 },
    ]);
  });
});

describe("retained portfolio projections", () => {
  const series = (revision: string, generation = "a"): SourcePortfolio => ({
    fromMs: 100,
    toMs: 300,
    intervalMs: 60,
    baseTimeMs: 100,
    timeOffsetsMs: [0, 0, 100],
    columns: { equity: [1, 2, 3], pnl: [0, 1, 2] },
    gapIndices: [],
    coverage: { availableFromMs: 100, availableToMs: 300, complete: true },
    source: { asOfMs: 300, revision, generation },
  });
  it("preserves repeated sample times, replaces corrected overlap, and rejects backwards source revisions", async () => {
    const store = await memory();
    await store.history.ensureWallet(address);
    let at = Date.now() + 100;
    await store.history.commitPortfolio(
      await claim(store, "portfolio", at),
      series("10:2"),
      "all",
      at + 1,
      1000,
    );
    expect(
      (await store.history.readPortfolio(address))!.value.columns.equity,
    ).toEqual([1, 2, 3]);
    at += 1002;
    const job = await claim(store, "portfolio", at);
    await expect(
      store.history.commitPortfolio(job, series("9:2"), "1d", at + 1, 1000),
    ).rejects.toThrow("moved backward");
    const correction = {
      ...series("10:3"),
      baseTimeMs: 150,
      timeOffsetsMs: [0],
      columns: { equity: [4], pnl: [3] },
    };
    await store.history.commitPortfolio(job, correction, "1d", at + 2, 1000);
    const result = (await store.history.readPortfolio(address))!.value;
    expect(result.columns.equity).toEqual([4]);
    expect(result.coverage.complete).toBe(true);
    // The source covers through300 despite its last change sample being150.
    expect(
      (await store.history.getStatus(address)).find(
        (j) => j.kind === "portfolio",
      )!.state.portfolio!.availableToMs,
    ).toBe(300);
  });
  it("does not mix generations and schedules a new full baseline after a partial-range rebuild", async () => {
    const store = await memory();
    await store.history.ensureWallet(address);
    let at = Date.now() + 100;
    await store.history.commitPortfolio(
      await claim(store, "portfolio", at),
      series("10:2"),
      "all",
      at + 1,
      1000,
    );
    at += 1002;
    const replacement = {
      ...series("1:1", "b"),
      fromMs: 200,
      baseTimeMs: 200,
      timeOffsetsMs: [0],
      columns: { equity: [9], pnl: [4] },
    };
    await store.history.commitPortfolio(
      await claim(store, "portfolio", at),
      replacement,
      "1d",
      at + 1,
      3600000,
    );
    const data = (await store.history.readPortfolio(address))!;
    expect(data.value.columns.equity).toEqual([9]);
    expect(data.value.coverage.complete).toBe(false);
    expect(data.coverage.backfillComplete).toBe(false);
    const state = (await store.history.getStatus(address)).find(
      (j) => j.kind === "portfolio",
    )!;
    expect(state.nextRun).toBe(at + 1001);
  });
});
