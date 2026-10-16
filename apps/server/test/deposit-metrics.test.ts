import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHistoryStore, historySchemaSql } from "../src/history-store.js";
import {
  createLocalDepositMetrics,
  createPgDepositMetrics,
  depositMetricsSchemaSql,
  enqueueDepositMetrics,
} from "../src/deposit-metrics-store.js";
import { digest } from "../src/schemas.js";

const DAY = 86400000,
  start = 1800000000000 - (1800000000000 % DAY),
  now = start + 5 * DAY;
const a = `0x${"1".repeat(40)}`,
  b = `0x${"2".repeat(40)}`;
const huge = 900719925474099312345678901234567890n;
const databases: DatabaseSync[] = [],
  dirs: string[] = [];
const deposit = (timestampMs = start + 1000, amountRaw = "100") => ({
  kind: "Deposit",
  timestampMs,
  amountRaw,
  txHash: `0x${"a".repeat(64)}`,
});
function fixture(path = ":memory:") {
  const db = new DatabaseSync(path);
  databases.push(db);
  db.exec(historySchemaSql("", false));
  db.exec(depositMetricsSchemaSql("", false));
  const metrics = createLocalDepositMetrics(db, async () => {});
  return { db, metrics };
}
function mark(db: DatabaseSync, wallet: string, key: string) {
  const q = enqueueDepositMetrics("", wallet, key);
  db.prepare(q.sql).run(...q.params);
}
function retain(
  db: DatabaseSync,
  key: string,
  payload: Record<string, unknown>,
  options: { address?: string; at?: number; queue?: boolean } = {},
) {
  const wallet = options.address ?? a;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "INSERT INTO history_records VALUES(?,'cashflows',?,?,?,?,1,?) ON CONFLICT(address,kind,record_key) DO UPDATE SET source_at=excluded.source_at,payload=excluded.payload,payload_hash=excluded.payload_hash,received_at=excluded.received_at WHERE history_records.received_at<=excluded.received_at",
    ).run(
      wallet,
      key,
      Number(payload.timestampMs),
      JSON.stringify(payload),
      digest(payload),
      options.at ?? now,
    );
    if (options.queue !== false) mark(db, wallet, key);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function remove(db: DatabaseSync, wallet: string, key: string) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "DELETE FROM history_records WHERE address=? AND kind='cashflows' AND record_key=?",
    ).run(wallet, key);
    mark(db, wallet, key);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("incremental credited deposits", () => {
  it("preserves October 8 deposits and the first-depositor date across the October 10 trading launch", async () => {
    const { db, metrics } = fixture();
    const depositsOpenDay = Date.UTC(2026, 9, 8);
    const tradingDay = Date.UTC(2026, 9, 10);
    retain(db, "prelaunch", deposit(depositsOpenDay + 14 * 3600000, "1000"));
    retain(db, "after-launch", deposit(tradingDay + 15 * 3600000, "250"));
    await metrics.tick();
    expect(await metrics.read(depositsOpenDay, tradingDay + DAY)).toMatchObject({
      observedFrom: depositsOpenDay + 14 * 3600000,
      days: [
        { time: depositsOpenDay, depositVolumeRaw: "1000", depositCount: 1, firstDepositors: 1 },
        { time: tradingDay, depositVolumeRaw: "250", depositCount: 1, firstDepositors: 0 },
      ],
    });
  });

  it("keeps exact daily amounts, counts ambiguous retained deposits, and credits one first day per wallet", async () => {
    const { db, metrics } = fixture();
    retain(db, "one", deposit(start + 1000, String(huge)));
    retain(db, "two", deposit(start + DAY, "23"));
    retain(db, "three", deposit(start + DAY + 1, "7"), { address: b });
    retain(db, "withdrawal", { ...deposit(), kind: "Withdrawal" });
    retain(db, "zero", deposit(start - DAY, "0"));
    expect(await metrics.tick()).toMatchObject({
      processed: 5,
      pending: false,
    });
    expect(await metrics.read(start - DAY, start + 3 * DAY)).toMatchObject({
      days: [
        {
          time: start,
          depositVolumeRaw: String(huge),
          depositCount: 1,
          firstDepositors: 1,
        },
        {
          time: start + DAY,
          depositVolumeRaw: "30",
          depositCount: 2,
          firstDepositors: 1,
        },
      ],
      observedFrom: start + 1000,
      excludedRecords: 0,
      projectionBackfillComplete: true,
    });
  });

  it("moves first-depositor days earlier and later and retracts corrected or explicitly removed records", async () => {
    const { db, metrics } = fixture();
    retain(db, "later", deposit(start + 2 * DAY, "20"));
    await metrics.tick();
    retain(db, "earlier", deposit(start + DAY, "10"));
    await metrics.tick();
    expect((await metrics.read(start, start + 4 * DAY)).days).toEqual([
      {
        time: start + DAY,
        depositVolumeRaw: "10",
        depositCount: 1,
        firstDepositors: 1,
      },
      {
        time: start + 2 * DAY,
        depositVolumeRaw: "20",
        depositCount: 1,
        firstDepositors: 0,
      },
    ]);
    // Same retained key changes amount and day. The wallet's earliest moves later.
    retain(db, "earlier", deposit(start + 3 * DAY, "40"), { at: now + 1 });
    await metrics.tick();
    expect((await metrics.read(start, start + 4 * DAY)).days).toEqual([
      {
        time: start + DAY,
        depositVolumeRaw: "0",
        depositCount: 0,
        firstDepositors: 0,
      },
      {
        time: start + 2 * DAY,
        depositVolumeRaw: "20",
        depositCount: 1,
        firstDepositors: 1,
      },
      {
        time: start + 3 * DAY,
        depositVolumeRaw: "40",
        depositCount: 1,
        firstDepositors: 0,
      },
    ]);
    remove(db, a, "later");
    await metrics.tick();
    expect(
      (await metrics.read(start, start + 4 * DAY)).days.at(-1)?.firstDepositors,
    ).toBe(1);
    retain(
      db,
      "earlier",
      { ...deposit(start + 3 * DAY, "40"), kind: "Withdrawal" },
      { at: now + 2 },
    );
    await metrics.tick();
    const empty = await metrics.read(start, start + 4 * DAY);
    expect(empty.observedFrom).toBeNull();
    expect(
      empty.days.every(
        (day) => day.depositVolumeRaw === "0" && day.firstDepositors === 0,
      ),
    ).toBe(true);
  });

  it("skips receipt-only replays but reconsiders a formerly future deposit on a later observation", async () => {
    const { db, metrics } = fixture();
    retain(db, "one", deposit());
    await metrics.tick();
    retain(db, "one", deposit(), { at: now + 10 });
    expect(await metrics.tick()).toMatchObject({ processed: 0 });
    const future = deposit(now + 30001, "5");
    retain(db, "future", future);
    await metrics.tick();
    expect((await metrics.read(start, start + 6 * DAY)).excludedRecords).toBe(
      1,
    );
    retain(db, "future", future, { at: now + 1 });
    expect(await metrics.tick()).toMatchObject({ processed: 1 });
    expect(await metrics.read(start, start + 6 * DAY)).toMatchObject({
      excludedRecords: 0,
      days: [
        { time: start, depositVolumeRaw: "100" },
        { time: start + 5 * DAY, depositVolumeRaw: "5" },
      ],
    });
    retain(db, "one", deposit(start + 1000, "999"), { at: now - 1 });
    expect(await metrics.tick()).toMatchObject({ processed: 0 }); // stale producer loses source guard
    expect(
      (await metrics.read(start, start + DAY)).days[0].depositVolumeRaw,
    ).toBe("100");
  });

  it("resumes bounded legacy keysets and projects newly queued keys behind the saved cursor after restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paperclub-deposits-"));
    dirs.push(dir);
    const path = join(dir, "store.sqlite");
    let { db, metrics } = fixture(path);
    for (const key of ["b", "c", "d"])
      retain(db, key, deposit(), { queue: false });
    expect(await metrics.tick(1)).toMatchObject({
      backfilled: 1,
      processed: 1,
      projectionBackfillComplete: false,
    });
    db.close();
    databases.splice(databases.indexOf(db), 1);
    ({ db, metrics } = fixture(path));
    retain(db, "a", deposit(start - DAY, "13"));
    await metrics.tick(1);
    await metrics.tick(1);
    await metrics.tick(1);
    const value = await metrics.read(start - DAY, start + DAY);
    expect(value.pending).toBe(false);
    expect(value.days).toEqual([
      {
        time: start - DAY,
        depositVolumeRaw: "13",
        depositCount: 1,
        firstDepositors: 1,
      },
      {
        time: start,
        depositVolumeRaw: "300",
        depositCount: 3,
        firstDepositors: 0,
      },
    ]);
  });

  it("rolls back failed projections and preserves the queue and legacy checkpoint for retry", async () => {
    const { db, metrics } = fixture();
    retain(db, "one", deposit(), { queue: false });
    db.exec(
      "CREATE TRIGGER fail_projection BEFORE INSERT ON deposit_metrics_days BEGIN SELECT RAISE(ABORT,'projection failed'); END",
    );
    await expect(metrics.tick()).rejects.toThrow("projection failed");
    expect(
      db.prepare("SELECT count(*) n FROM deposit_metrics_facts").get(),
    ).toMatchObject({ n: 0 });
    expect(
      db.prepare("SELECT cursor_key,complete FROM deposit_metrics_state").get(),
    ).toMatchObject({ cursor_key: "", complete: 0 });
    db.exec("DROP TRIGGER fail_projection");
    await metrics.tick();
    expect((await metrics.read(start, start + DAY)).days[0]).toMatchObject({
      depositVolumeRaw: "100",
      firstDepositors: 1,
    });
  });

  it("atomically fences the source cashflow, projection mark and history checkpoint", async () => {
    const { db, metrics } = fixture();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const history = createHistoryStore({
      prefix: "",
      async rows<T>(sql: string, params = []) {
        return db.prepare(sql).all(...(params as never[])) as T[];
      },
      async batch(statements) {
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const q of statements) {
            const result = db
              .prepare(q.sql)
              .run(...((q.params ?? []) as never[]));
            if (
              q.requireChanges !== undefined &&
              result.changes !== q.requireChanges
            )
              throw new Error("History job lease changed");
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    });
    await history.ensureWallet(a);
    const job = await history.claimJob(now);
    db.exec("DROP TABLE deposit_metrics_queue");
    await expect(
      history.commitPage(
        job!,
        { items: [deposit()], nextCursor: null },
        now,
        DAY,
      ),
    ).rejects.toThrow();
    expect(
      db.prepare("SELECT count(*) n FROM history_records").get(),
    ).toMatchObject({ n: 0 });
    db.exec(depositMetricsSchemaSql("", false));
    await history.commitPage(
      job!,
      { items: [deposit()], nextCursor: null },
      now,
      DAY,
    );
    await metrics.tick();
    await expect(
      history.commitPage(
        job!,
        { items: [deposit(start + DAY)], nextCursor: null },
        now + 1,
        DAY,
      ),
    ).rejects.toThrow("History job lease changed");
    expect((await metrics.read(start, start + 2 * DAY)).days).toHaveLength(1);
  });

  it("bounds chart reads to one statement over saved rollups and indexed facts", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const metrics = createPgDepositMetrics({ query } as never);
    await metrics.read(start, start + 30 * DAY);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).not.toContain("history_records");
    await expect(metrics.read(start + 1, start + DAY)).rejects.toThrow(
      "Invalid deposit chart range",
    );
    await expect(metrics.read(start, start + 367 * DAY)).rejects.toThrow(
      "Invalid deposit chart range",
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
});
