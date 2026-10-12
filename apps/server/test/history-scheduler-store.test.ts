import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { createStore, type Store } from "../src/store.js";
import { createHistoryStore, historySchemaSql, type HistoryLane, type JobKind } from "../src/history-store.js";

const hour = 3_600_000;
const cold = 6 * hour;
const adaptive = { adaptive: true };
const address = `0x${"1".repeat(40)}`;
const other = `0x${"2".repeat(40)}`;
const kinds: JobKind[] = ["cashflows", "trades", "portfolio"];
const stores: Store[] = [];
const dirs: string[] = [];
let now: number;
beforeEach(() => {
  now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("PostgreSQL scheduler SQL parity", () => {
  it("applies exclusions, adaptive checkpoints, activation and disjoint stats using real PostgreSQL", async () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const client = await pool.connect();
    const prefix = "scheduler_test_";
    const parameters = (sql: string) => {
      let i = 0;
      return sql.replace(/\?/g, () => `$${++i}`);
    };
    try {
      await client.query("BEGIN");
      // These isolated fixture tables and all mutations roll back at the end.
      await client.query(historySchemaSql(prefix, true));
      const history = createHistoryStore({
        prefix,
        async rows<T>(sql: string, params: unknown[] = []) {
          return (await client.query(parameters(sql), params)).rows as T[];
        },
        async batch(statements) {
          await client.query("SAVEPOINT scheduler_batch");
          try {
            for (const statement of statements) {
              const result = await client.query(parameters(statement.sql), statement.params);
              if (statement.requireChanges !== undefined && result.rowCount !== statement.requireChanges)
                throw new Error("History job lease changed");
            }
            await client.query("RELEASE SAVEPOINT scheduler_batch");
          } catch (error) {
            await client.query("ROLLBACK TO SAVEPOINT scheduler_batch");
            throw error;
          }
        },
      });
      await history.ensureWallet(address);
      let job = await history.claimJob(now, 120000, "backfill", exceptCashflow());
      expect(job).not.toBeNull();
      await history.commitPage(job!, { items: [deposit(100)], nextCursor: null }, now, cold, adaptive);
      now += cold;
      job = await history.claimJob(now, 120000, "fair", exceptCashflow());
      await history.commitPage(job!, { items: [deposit(100)], nextCursor: null }, now, cold, adaptive);
      let saved = (await history.getStatus(address)).find((s) => s.kind === "cashflows")!;
      expect(saved.nextRun).toBe(now + 12 * hour);
      now = saved.nextRun;
      job = await history.claimJob(now, 120000, "fair", exceptCashflow());
      now++;
      await history.ensureWallet(address, 10);
      await history.commitPage(job!, { items: [deposit(100)], nextCursor: null }, now, cold, adaptive);
      saved = (await history.getStatus(address)).find((s) => s.kind === "cashflows")!;
      expect(saved.nextRun).toBe(now + 60000);
      expect(saved.state.unchangedCycles).toBe(0);
      await history.ensureWallet(other);
      job = await history.claimJob(now, 120000, "backfill", exceptCashflow(other));
      await history.commitPage(job!, { items: [{ ...deposit(100), kind: "Withdrawal", withdrawalStatus: "in_transit" }], nextCursor: "older" }, now, cold, adaptive);
      now += 300001;
      const exclude = [address, other].flatMap((a) => kinds.map((kind) => ({ address: a, kind })));
      for (const lane of ["active", "backfill", "fair"] as const)
        expect(await history.claimJob(now, 120000, lane, exclude)).toBeNull();
      const stats = await history.stats();
      expect(stats.pending).toBe(stats.activeDue + stats.backfillDue + stats.maintenanceDue + stats.correctionsDue);
      expect(stats.activeDue).toBeGreaterThan(0);
      expect(stats.backfillDue).toBeGreaterThan(0);
      expect(stats.correctionsDue).toBeGreaterThan(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  }, 20000);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function memory() {
  const store = await createStore({ memory: true, databaseUrl: "" });
  stores.push(store);
  return store;
}
function deposit(timestampMs: number, amountRaw = "1000000000000000000") {
  return { timestampMs, amountRaw, txHash: `0x${timestampMs.toString(16).padStart(64, "0")}`,
    kind: "Deposit", withdrawalStatus: null, recipientAmountRaw: null, route: null };
}
function exceptCashflow(target = address) {
  return [address, other].flatMap((a) => kinds
    .filter((kind) => a !== target || kind !== "cashflows")
    .map((kind) => ({ address: a, kind })));
}
async function claim(store: Store, target = address, lane: HistoryLane = "fair") {
  const job = await store.history.claimJob(now, 120000, lane, exceptCashflow(target));
  expect(job).not.toBeNull();
  expect(job?.address).toBe(target);
  expect(job?.kind).toBe("cashflows");
  return job!;
}
async function status(store: Store, target = address) {
  return (await store.history.getStatus(target)).find((s) => s.kind === "cashflows")!;
}
async function complete(store: Store, items = [deposit(300), deposit(200), deposit(100)]) {
  const job = await claim(store);
  await store.history.commitPage(job, { items, nextCursor: null }, now, cold, adaptive);
  return status(store);
}

describe("history scheduler retention and cadence", () => {
  it("only slows verified quiet completed head cycles and persists that policy across restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paperclub-schedule-"));
    dirs.push(dir);
    let store = await createStore({ dataDir: dir, databaseUrl: "" });
    stores.push(store);
    await store.history.ensureWallet(address);
    let saved = await complete(store);
    expect(saved.nextRun).toBe(now + cold);
    expect(saved.state.unchangedCycles).toBe(0);
    now = saved.nextRun;
    saved = await complete(store);
    expect(saved.nextRun).toBe(now + 12 * hour);
    expect(saved.state.unchangedCycles).toBe(1);
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    store = await createStore({ dataDir: dir, databaseUrl: "" });
    stores.push(store);
    now = saved.nextRun;
    saved = await complete(store);
    expect(saved.nextRun).toBe(now + 24 * hour);
    expect(saved.state.unchangedCycles).toBe(2);
    now = saved.nextRun;
    expect((await complete(store)).nextRun).toBe(now + 24 * hour);
  });

  it("carries changed payload evidence through a multi-page head cycle and resets quiet cadence", async () => {
    const store = await memory();
    await store.history.ensureWallet(address);
    let saved = await complete(store);
    now = saved.nextRun;
    saved = await complete(store);
    now = saved.nextRun;
    saved = await complete(store);
    now = saved.nextRun;
    await store.history.commitPage(await claim(store), {
      items: [deposit(300, "2000000000000000000")], nextCursor: "next-head",
    }, now, cold, adaptive);
    saved = await status(store);
    expect(saved.state).toMatchObject({ cursor: "next-head", cycleChanged: true });
    expect(saved.nextRun).toBe(now + 1000);
    now = saved.nextRun;
    await store.history.commitPage(await claim(store), {
      items: [deposit(200), deposit(100)], nextCursor: null,
    }, now, cold, adaptive);
    saved = await status(store);
    expect(saved.nextRun).toBe(now + cold);
    expect(saved.state).toMatchObject({ unchangedCycles: 0, cursor: null });
    expect(saved.state.cycleChanged).toBeUndefined();
    expect((await store.history.readPage(address, "cashflows")).items).toHaveLength(3);
  });

  it("treats a new record as activity and preserves explicit nonadaptive refresh intervals", async () => {
    const store = await memory();
    await store.history.ensureWallet(address);
    let saved = await complete(store);
    now = saved.nextRun;
    saved = await complete(store);
    now = saved.nextRun;
    saved = await complete(store, [deposit(400), deposit(300), deposit(200), deposit(100)]);
    expect(saved.nextRun).toBe(now + cold);
    expect(saved.state.unchangedCycles).toBe(0);
    now = saved.nextRun;
    await store.history.commitPage(await claim(store), {
      items: [deposit(400), deposit(300), deposit(200), deposit(100)], nextCursor: null,
    }, now, 123456);
    expect((await status(store)).nextRun).toBe(now + 123456);
  });

  it("honors activation during and just after a cold request without bypassing failure backoff", async () => {
    const store = await memory();
    await store.history.ensureWallet(address);
    let saved = await complete(store);
    now = saved.nextRun;
    saved = await complete(store);
    now = saved.nextRun;
    const coldClaim = await claim(store);
    expect(coldClaim.priority).toBe(0);
    now++;
    await store.history.ensureWallet(address, 20);
    await store.history.commitPage(coldClaim, {
      items: [deposit(300), deposit(200), deposit(100)], nextCursor: null,
    }, now, cold, adaptive);
    saved = await status(store);
    expect(saved.nextRun).toBe(now + 60000);
    expect(saved.state.unchangedCycles).toBe(0);

    now += 600001; // activity expires; a cold response completes first this time
    saved = await complete(store);
    const completedAt = now;
    now++;
    await store.history.ensureWallet(address, 10);
    expect((await status(store)).nextRun).toBe(completedAt + 60000);
    now = completedAt + 60000;
    const job = await claim(store);
    const retryAt = now + 3 * hour;
    await store.history.failJob(job, "source cooldown", now, retryAt);
    now++;
    await store.history.ensureWallet(address, 20);
    expect((await status(store)).nextRun).toBe(retryAt);
    expect(await store.history.claimJob(now, 120000, "active", exceptCashflow())).toBeNull();
  });

  it("keeps pending withdrawal reconciliation at five minutes even for a cold wallet", async () => {
    const store = await memory();
    await store.history.ensureWallet(address);
    const pending = { ...deposit(100), kind: "Withdrawal", withdrawalStatus: "in_transit" };
    await store.history.commitPage(await claim(store), {
      items: [pending], nextCursor: null,
    }, now, cold, adaptive);
    now += 300000;
    const correction = await claim(store);
    expect(correction.state.purpose).toBe("pending");
    await store.history.commitPage(correction, {
      items: [pending], nextCursor: null,
    }, now, cold, adaptive);
    now += 299999;
    expect(await store.history.claimJob(now, 120000, "fair", exceptCashflow())).toBeNull();
    now++;
    expect((await claim(store)).state.purpose).toBe("pending");
  });

  it("promotes a newly created head when activation arrived during the first cold backfill page", async () => {
    const store = await memory();
    await store.history.ensureWallet(address);
    const initial = await claim(store);
    now++;
    await store.history.ensureWallet(address, 10);
    await store.history.commitPage(initial, {
      items: [deposit(100)], nextCursor: "deep-backfill",
    }, now, cold, adaptive);
    const committedAt = now;
    now += 60000;
    const primary = await claim(store);
    expect(primary.correctionId).toBeUndefined();
    expect(primary.state.cursor).toBe("deep-backfill");
    const head = await claim(store);
    expect(head.state.purpose).toBe("head");
    expect(head.nextRun).toBe(committedAt + 60000);
  });

  it("reserves unfinished work ahead of cold maintenance and never drops exclusions on fallback", async () => {
    const store = await memory();
    await store.history.ensureWallet(address);
    const saved = await complete(store);
    now = saved.nextRun;
    now++;
    await store.history.ensureWallet(other);
    const onlyCashflows = [address, other].flatMap((a) =>
      ["trades", "portfolio"].map((kind) => ({ address: a, kind: kind as JobKind })));
    const backfill = await store.history.claimJob(now, 120000, "backfill", onlyCashflows);
    expect(backfill?.address).toBe(other);
    const exclude = [...onlyCashflows, { address, kind: "cashflows" as const }, { address: other, kind: "cashflows" as const }];
    expect(await store.history.claimJob(now, 120000, "active", exclude)).toBeNull();
    expect(await store.history.claimJob(now, 120000, "backfill", exclude)).toBeNull();
  });

  it("excludes independent head and pending correction jobs for a busy wallet ledger", async () => {
    const store = await memory();
    await store.history.ensureWallet(address, 10);
    const pending = { ...deposit(100), kind: "Withdrawal", withdrawalStatus: "in_transit" };
    await store.history.commitPage(await claim(store), {
      items: [pending], nextCursor: "deep-page",
    }, now, 60000, adaptive);
    now += 300001;
    const exclude = kinds.map((kind) => ({ address, kind }));
    for (const lane of ["active", "backfill", "fair"] as const)
      expect(await store.history.claimJob(now, 120000, lane, exclude)).toBeNull();
    const correction = await store.history.claimJob(now, 120000, "fair", exceptCashflow());
    expect(correction).not.toBeNull();
  });

  it("reports disjoint due categories, including corrections and leased work", async () => {
    const store = await memory();
    await store.history.ensureWallet(address);
    const pending = { ...deposit(100), kind: "Withdrawal", withdrawalStatus: "in_transit" };
    await store.history.commitPage(await claim(store), { items: [pending], nextCursor: null }, now, cold, adaptive);
    const firstAt = now;
    now += cold;
    await store.history.ensureWallet(other, 10);
    await store.history.claimJob(now, 120000, "active");
    let stats = await store.history.stats();
    expect(stats).toMatchObject({ activeDue: 3, backfillDue: 2, maintenanceDue: 1, correctionsDue: 1, pending: 7,
      oldestActiveDueAt: now, oldestBackfillDueAt: firstAt });
    now += 600001;
    stats = await store.history.stats();
    expect(stats).toMatchObject({ activeDue: 0, backfillDue: 5, maintenanceDue: 1, correctionsDue: 1, pending: 7,
      oldestActiveDueAt: null, oldestBackfillDueAt: firstAt });
  });
});
