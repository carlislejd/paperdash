import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { createStore, type Store } from "../src/store.js";
import { createHistoryStore, historySchemaSql, type HistoryLane, type JobKind } from "../src/history-store.js";
import { depositMetricsSchemaSql } from "../src/deposit-metrics-store.js";

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
      await client.query(depositMetricsSchemaSql(prefix, true));
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
      for (const lane of ["viewed-head", "active-head", "active", "backfill", "retry", "fair"] as const)
        expect(await history.claimJob(now, 120000, lane, exclude)).toBeNull();
      const stats = await history.stats();
      expect(stats.pending).toBe(stats.activeDue + stats.backfillDue + stats.maintenanceDue + stats.correctionsDue);
      expect(stats.activeDue).toBeGreaterThan(0);
      expect(stats.backfillDue).toBeGreaterThan(0);
      expect(stats.correctionsDue).toBeGreaterThan(0);
      const indexes = (await client.query(
        "SELECT indexname,indexdef FROM pg_indexes WHERE indexname IN ($1,$2)",
        [`${prefix}history_jobs_retry_due`, `${prefix}history_corrections_retry_due`],
      )).rows;
      expect(indexes).toHaveLength(2);
      expect(indexes.every((index) => index.indexdef.includes("failures") && index.indexdef.includes("WHERE"))).toBe(true);

      // A failed primary job remains fenced and respects its source deadline.
      job = await history.claimJob(now, 120000, "fair", exceptCashflow());
      const retryAt = now + hour;
      await history.failJob(job!, "HTTP 502", now, retryAt);
      now += 30000;
      expect(await history.claimJob(now, 120000, "retry", exceptCashflow())).toBeNull();
      now = retryAt;
      expect(await history.claimJob(now, 120000, "retry", exclude)).toBeNull();
      job = await history.claimJob(now, 120000, "retry", exceptCashflow());
      expect(job?.state.failures).toBe(1);

      expect(await history.claimJob(now, 120000, "retry", exceptCashflow())).toBeNull();
      await history.commitPage(job!, { items: [deposit(100)], nextCursor: null }, now, cold, adaptive);
      expect((await history.getStatus(address)).find((s) => s.kind === "cashflows")?.state.failures).toBe(0);

      // The same retry predicate includes failed correction rows. Hold the
      // primary continuation so this fixture can reach its pending sidejob.
      let correction = await history.claimJob(now, 120000, "fair", exceptCashflow(other));
      if (!correction?.correctionId)
        correction = await history.claimJob(now, 120000, "fair", exceptCashflow(other));
      expect(correction?.correctionId).toBeDefined();
      await history.failJob(correction!, "request timeout", now);
      now += 30000;
      job = await history.claimJob(now, 120000, "retry", exceptCashflow(other));
      expect(job?.correctionId).toBe(correction!.correctionId);
      expect(job?.state.failures).toBe(1);

      // The new head lane uses the same PostgreSQL cursor/purpose semantics.
      const activeAddress = `0x${"3".repeat(40)}`;
      await history.ensureWallet(activeAddress, 10);
      const headOnly = [...exclude, ...["trades", "portfolio"].map((kind) => ({ address: activeAddress, kind: kind as JobKind }))];
      job = await history.claimJob(now, 120000, "active-head", headOnly);
      expect(job?.address).toBe(activeAddress);
      await history.commitPage(job!, { items: [], nextCursor: "older-active" }, now, 60000, adaptive);
      now += 60000;
      job = await history.claimJob(now, 120000, "active-head", headOnly);
      expect(job?.correctionId).toBe(`head:${activeAddress}:cashflows`);
      expect(job?.state.cursor).toBeNull();

      // Viewed heads use the same filters and fences without raising capacity.
      const viewedAddress = `0x${"4".repeat(40)}`;
      const viewedOnly = [...headOnly, ...kinds.map((kind) => ({ address: activeAddress, kind })),
        ...["trades", "portfolio"].map((kind) => ({ address: viewedAddress, kind: kind as JobKind }))];
      await history.ensureWallet(viewedAddress, 30);
      await history.ensureWallet(viewedAddress, 20);
      job = await history.claimJob(now, 120000, "viewed-head", viewedOnly);
      expect(job?.address).toBe(viewedAddress);
      expect(job?.priority).toBe(30);
      await history.commitPage(job!, { items: [], nextCursor: "viewed-backfill" }, now, 60000, adaptive);
      now += 60000;
      job = await history.claimJob(now, 120000, "viewed-head", viewedOnly);
      expect(job?.correctionId).toBe(`head:${viewedAddress}:cashflows`);
      const viewedRetryAt = now + 300000;
      await history.failJob(job!, "HTTP 429", now, viewedRetryAt);
      await history.ensureWallet(viewedAddress, 30);
      // Exclude the primary continuation by claiming it: no head can bypass its backoff.
      const continuation = await history.claimJob(now, 120000, "backfill", viewedOnly);
      expect(continuation?.state.cursor).toBe("viewed-backfill");
      expect(await history.claimJob(now, 120000, "viewed-head", viewedOnly)).toBeNull();
      now = viewedRetryAt;
      expect((await history.claimJob(now, 120000, "viewed-head", viewedOnly))?.correctionId)
        .toBe(`head:${viewedAddress}:cashflows`);
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
const emptyPortfolio = () => ({
  baseTimeMs: now, timeOffsetsMs: [], columns: { equity: [], pnl: [] }, gapIndices: [],
  coverage: { availableFromMs: null, availableToMs: null, complete: true },
});
async function completeWallet(store: Store, target: string, refreshMs: number) {
  for (const kind of kinds) {
    const exclude = [address, other].flatMap((a) => kinds
      .filter((k) => a !== target || k !== kind).map((k) => ({ address: a, kind: k })));
    const job = await store.history.claimJob(now, 120000, "fair", exclude);
    expect(job?.kind).toBe(kind);
    if (kind === "portfolio") await store.history.commitPortfolio(job!, emptyPortfolio(), "all", now, refreshMs);
    else await store.history.commitPage(job!, { items: [], nextCursor: null }, now, refreshMs);
  }
}

describe("history scheduler retention and cadence", () => {
  it.each(["active-head", "viewed-head"] as const)("reserves %s ledger heads while general active turns still serve older portfolios and continuations", async (lane) => {
    const store = await memory();
    await store.history.ensureWallet(address, lane === "viewed-head" ? 30 : 10);
    const pending = { ...deposit(100), kind: "Withdrawal", withdrawalStatus: "in_transit" };
    await store.history.commitPage(await claim(store), { items: [pending], nextCursor: "deep-page" }, now, 60000, adaptive);
    now += 300001;
    const exclude = [{ address, kind: "trades" as const }];
    const head = await store.history.claimJob(now, 120000, lane, exclude);
    expect(head?.correctionId).toBe(`head:${address}:cashflows`);
    expect(head?.state.cursor).toBeNull();
    expect((await status(store)).state.cursor).toBe("deep-page");
    const general = await store.history.claimJob(now, 120000, "active", [
      ...exclude, { address, kind: "cashflows" },
    ]);
    expect(general?.kind).toBe("portfolio");
    await store.history.commitPortfolio(general!, emptyPortfolio(), "all", now, 300000);
    await store.history.commitPage(head!, { items: [], nextCursor: "head-continuation" }, now, 60000, adaptive);
    now += 1000;
    await store.history.ensureWallet(other, 20);
    // A head continuation and primary deep cursor stay out of the reserved lane.
    const next = await store.history.claimJob(now, 120000, lane, exclude);
    expect(next?.address).toBe(other);
    expect(next?.state.cursor).toBeNull();
    const continuing = await store.history.claimJob(now, 120000, "backfill", exceptCashflow());
    expect(continuing?.state.cursor).toBe("deep-page");
  });

  it("reserves viewed heads ahead of the active queue while other turns retain oldest-due ordering", async () => {
    const store = await memory();
    const viewed = `0x${"3".repeat(40)}`;
    const secondViewed = `0x${"4".repeat(40)}`;
    await store.history.ensureWallet(address); // Older cold work keeps the fair turn.
    now++;
    await store.history.ensureWallet(other, 20);
    now++;
    await store.history.ensureWallet(viewed, 30);
    now++;
    await store.history.ensureWallet(secondViewed, 30);
    const first = await store.history.claimJob(now, 120000, "viewed-head");
    expect(first?.address).toBe(viewed);
    expect(first?.priority).toBe(30);
    const exclusions = kinds.map((kind) => ({ address: viewed, kind }));
    expect((await store.history.claimJob(now, 120000, "viewed-head", exclusions))?.address)
      .toBe(secondViewed);
    expect((await store.history.claimJob(now, 120000, "active-head"))?.address).toBe(other);
    expect((await store.history.claimJob(now, 120000, "fair"))?.address).toBe(address);
  });

  it("preserves profile promotion during lower-priority activity, clamps it, and expires after inactivity", async () => {
    const store = await memory();
    await store.history.ensureWallet(address, 100);
    now += 1000;
    await store.history.ensureWallet(address, 10);
    const viewed = await store.history.claimJob(now, 120000, "viewed-head");
    expect(viewed?.address).toBe(address);
    expect(viewed?.priority).toBe(30);
    now += 600001;
    await store.history.ensureWallet(other, 20);
    // The expired profile cannot displace a currently active head.
    expect((await store.history.claimJob(now, 120000, "viewed-head"))?.address).toBe(other);
    const expired = await store.history.claimJob(now, 120000, "fair");
    expect(expired?.address).toBe(address);
    expect(expired?.priority).toBe(0);
    await store.history.ensureWallet(address, 20);
    const reactivated = await store.history.claimJob(now, 120000, "active-head", [
      ...kinds.map((kind) => ({ address: other, kind })),
      { address, kind: expired!.kind },
    ]);
    expect(reactivated?.address).toBe(address);
    expect(reactivated?.priority).toBe(20);
  });

  it("never lets a viewed promotion bypass primary-head backoff or a sibling exclusion", async () => {
    const store = await memory();
    await store.history.ensureWallet(address, 30);
    const job = await claim(store, address, "viewed-head");
    const retryAt = now + 120000;
    await store.history.failJob(job, "HTTP 429", now, retryAt);
    now += 1000;
    await store.history.ensureWallet(address, 30);
    expect((await status(store)).nextRun).toBe(retryAt);
    expect(await store.history.claimJob(now, 120000, "viewed-head", exceptCashflow())).toBeNull();
    now = retryAt;
    const excluded = [...exceptCashflow(), { address, kind: "cashflows" as const }];
    expect(await store.history.claimJob(now, 120000, "viewed-head", excluded)).toBeNull();
    const retry = await claim(store, address, "viewed-head");
    expect(retry.state.failures).toBe(1);
    expect(await store.history.claimJob(now, 120000, "viewed-head", exceptCashflow())).toBeNull();
  });

  it.each(["backfill", "retry"] as const)("borrows an empty %s turn for active work before older cold maintenance", async (lane) => {
    const store = await memory();
    await store.history.ensureWallet(address);
    await completeWallet(store, address, cold);
    now += cold + 1;
    await store.history.ensureWallet(other, 10);
    await completeWallet(store, other, 60000);
    now += 60000;
    expect((await store.history.claimJob(now, 120000, lane))?.address).toBe(other);
    expect((await store.history.claimJob(now, 120000, "fair"))?.address).toBe(address);
  });

  it("keeps priority 10 holders and priority 20 traders in oldest-due head order", async () => {
    const store = await memory();
    await store.history.ensureWallet(address, 10);
    now++;
    await store.history.ensureWallet(other, 20);
    expect((await store.history.claimJob(now, 120000, "active-head"))?.address).toBe(address);
  });

  it("preserves deep cursors and retry deadlines across restart while a due head progresses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paperclub-head-resume-"));
    dirs.push(dir);
    let store = await createStore({ dataDir: dir, databaseUrl: "" });
    stores.push(store);
    await store.history.ensureWallet(address, 10);
    await store.history.commitPage(await claim(store), { items: [deposit(100)], nextCursor: "saved-deep" }, now, 60000, adaptive);
    now += 1000;
    const continuing = await claim(store);
    await store.history.failJob(continuing, "HTTP 429", now, now + hour);
    const saved = await status(store);
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    store = await createStore({ dataDir: dir, databaseUrl: "" });
    stores.push(store);
    now += 60000;
    const head = await claim(store, address, "active-head");
    expect(head.correctionId).toBe(`head:${address}:cashflows`);
    await store.history.commitPage(head, { items: [], nextCursor: null }, now, 60000, adaptive);
    expect(await status(store)).toEqual(saved);
    expect((await store.history.readPage(address, "cashflows")).items).toHaveLength(1);
    const exclude = [...exceptCashflow(), { address, kind: "cashflows" as const }];
    for (const lane of ["active-head", "backfill", "retry"] as const)
      expect(await store.history.claimJob(now, 120000, lane, exclude)).toBeNull();
  });
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
    for (const lane of ["active-head", "active", "backfill", "retry", "fair"] as const)
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

  it("gives due transient failures a retry before older healthy maintenance, then returns them to normal work", async () => {
    const store = await memory();
    await store.history.ensureWallet(address);
    const healthy = await complete(store);
    now++;
    await store.history.ensureWallet(other);
    await store.history.commitPage(await claim(store, other), {
      items: [deposit(100)], nextCursor: null,
    }, now, cold, adaptive);
    now = (await status(store, other)).nextRun;
    expect(healthy.nextRun).toBeLessThan(now);
    expect((await status(store, other)).state).toMatchObject({ complete: true, phase: "head" });
    await store.history.failJob(await claim(store, other), "request timeout", now);
    now += 30000;
    const onlyCashflows = [address, other].flatMap((a) => kinds
      .filter((kind) => kind !== "cashflows").map((kind) => ({ address: a, kind })));
    const retry = await store.history.claimJob(now, 120000, "retry", onlyCashflows);
    expect(retry?.address).toBe(other);
    expect(retry?.state.failures).toBe(1);
    await store.history.commitPage(retry!, { items: [deposit(100)], nextCursor: null }, now, cold, adaptive);
    expect((await status(store, other)).state).toMatchObject({ failures: 0, complete: true });
    expect((await status(store, other)).state.error).toBeUndefined();
    // No failed jobs remain: the reserved turn falls back to oldest fair work.
    expect((await store.history.claimJob(now, 120000, "retry", onlyCashflows))?.address).toBe(address);
  });

  it("never lets retry priority bypass source backoff, busy exclusions, or an unexpired lease", async () => {
    const store = await memory();
    await store.history.ensureWallet(address);
    const retryAt = now + hour;
    await store.history.failJob(await claim(store), "HTTP 429", now, retryAt);
    now += 30000;
    expect(await store.history.claimJob(now, 120000, "retry", exceptCashflow())).toBeNull();
    now = retryAt;
    expect(await store.history.claimJob(now, 120000, "retry", [
      ...exceptCashflow(), { address, kind: "cashflows" },
    ])).toBeNull();
    const first = await claim(store, address, "retry");
    expect(await store.history.claimJob(now, 120000, "retry", exceptCashflow())).toBeNull();
    now += 120001;
    const replacement = await claim(store, address, "retry");
    expect(replacement.token).not.toBe(first.token);
    await expect(store.history.commitPage(first, { items: [], nextCursor: null }, now, cold, adaptive))
      .rejects.toThrow("History job lease changed");
    await store.history.failJob(replacement, "request timeout", now);
    expect((await status(store)).state.failures).toBe(2);
    expect((await status(store)).nextRun).toBe(now + 60000);
    now += 59999;
    expect(await store.history.claimJob(now, 120000, "retry", exceptCashflow())).toBeNull();
    now++;
    expect((await claim(store, address, "retry")).state.failures).toBe(2);
  });

  it("retries a failed pending correction without changing its targets or the main checkpoint", async () => {
    const store = await memory();
    await store.history.ensureWallet(address);
    const pending = { ...deposit(100), kind: "Withdrawal", withdrawalStatus: "in_transit" };
    await store.history.commitPage(await claim(store), { items: [pending], nextCursor: null }, now, cold, adaptive);
    const original = await status(store);
    now += 300000;
    const correction = await claim(store);
    expect(correction.state.purpose).toBe("pending");
    await store.history.failJob(correction, "HTTP 502", now);
    now += 29999;
    expect(await store.history.claimJob(now, 120000, "retry", exceptCashflow())).toBeNull();
    now++;
    expect(await store.history.claimJob(now, 120000, "retry", [
      ...exceptCashflow(), { address, kind: "cashflows" },
    ])).toBeNull();
    const retry = await claim(store, address, "retry");
    expect(retry.correctionId).toBe(correction.correctionId);
    expect(retry.state.targets).toEqual(correction.state.targets);
    expect(await store.history.claimJob(now, 120000, "retry", exceptCashflow())).toBeNull();
    await store.history.commitPage(retry, {
      items: [{ ...pending, withdrawalStatus: "settled" }], nextCursor: null,
    }, now, cold, adaptive);
    expect(await status(store)).toEqual(original);
    expect((await store.history.stats()).failed).toBe(0);
    expect((await store.history.stats()).pendingCorrections).toBe(0);
    expect(await store.history.claimJob(now, 120000, "retry", exceptCashflow())).toBeNull();
  });
});
