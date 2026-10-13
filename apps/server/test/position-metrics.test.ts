import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type Store } from "../src/store.js";
import { digest } from "../src/schemas.js";
import {
  createPgPositionMetrics,
  enqueuePositionMetrics,
  positionMetricsSchemaSql,
} from "../src/position-metrics-store.js";

const a = `0x${"1".repeat(40)}`,
  b = `0x${"2".repeat(40)}`;
const now = 1800000000000;
const closed = (fields: Record<string, unknown> = {}) => ({
  positionId: "1",
  kind: "PositionClosed",
  timestampMs: now - 1000,
  openedAtMs: now - 1100,
  leverage: 2,
  ...fields,
});
const stores: Store[] = [],
  databases: DatabaseSync[] = [],
  dirs: string[] = [];
async function local() {
  const dir = await mkdtemp(join(tmpdir(), "paperdash-position-"));
  dirs.push(dir);
  const store = await createStore({ dataDir: dir });
  stores.push(store);
  const db = new DatabaseSync(join(dir, "paperdash.sqlite"));
  databases.push(db);
  return { store, db, dir };
}
function retain(
  db: DatabaseSync,
  key: string,
  value: Record<string, unknown>,
  options: {
    address?: string;
    ambiguous?: number;
    at?: number;
    queue?: boolean;
  } = {},
) {
  const address = options.address ?? a,
    at = options.at ?? now;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "INSERT INTO history_records VALUES(?,'trades',?,?,?,?,?,?) ON CONFLICT(address,kind,record_key) DO UPDATE SET source_at=excluded.source_at,payload=excluded.payload,payload_hash=excluded.payload_hash,ambiguous=excluded.ambiguous,received_at=excluded.received_at WHERE history_records.received_at<=excluded.received_at",
    ).run(
      address,
      key,
      Number(value.timestampMs),
      JSON.stringify(value),
      digest(value),
      options.ambiguous ?? 0,
      at,
    );
    if (options.queue !== false) {
      const mark = enqueuePositionMetrics("", address, key);
      db.prepare(mark.sql).run(...mark.params);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function tradeJob(store: Store, at = Date.now()) {
  // Creation and claiming must share the caller's clock even if setup crosses
  // a millisecond boundary; otherwise the new job is not due at `at` yet.
  const clock = vi.spyOn(Date, "now").mockReturnValue(at);
  try {
    await store.history.ensureWallet(a);
    for (let i = 0; i < 8; i++) {
      const job = await store.history.claimJob(at);
      if (!job) throw new Error("No trade job available");
      if (job.kind === "trades" && !job.correctionId) return job;
      await store.history.failJob(job, "test deferral", at, at + 86400000);
    }
    throw new Error("No trade job found");
  } finally {
    clock.mockRestore();
  }
}
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
describe("incremental retained position metrics", () => {
  it("reads lifetime close counts from saved rollups with independent history coverage", async () => {
    const { store, db, dir } = await local();
    const unknown = `0x${"3".repeat(40)}`;
    expect((await store.positionMetrics.readMany([a], now))[a]).toMatchObject({
      recordedCount: null, indexedAt: null, backfillComplete: false, projectionPending: true,
    });
    retain(db, "one", closed());
    retain(db, "excluded", closed({ openedAtMs: now }));
    await store.history.ensureWallet(a);
    await store.history.ensureWallet(b);
    const state = JSON.stringify({ complete: true, cursor: null, lastSuccessAt: now - 1000 });
    db.prepare("UPDATE history_jobs SET state=? WHERE kind='trades'").run(state);
    await store.positionMetrics.tick();
    let values = await store.positionMetrics.readMany([a, b, unknown, a], now);
    expect(Object.keys(values)).toHaveLength(3);
    expect(values[a]).toEqual({ recordedCount: 2, indexedAt: now - 1000,
      backfillComplete: true, projectionPending: false, excludedCount: 1, stale: false });
    expect(values[b].recordedCount).toBe(0); // checked and genuinely empty
    expect(values[unknown].recordedCount).toBeNull(); // not checked is not zero

    retain(db, "new", closed({ positionId: "2" }), { at: now + 1 });
    values = await store.positionMetrics.readMany([a], now + 1);
    expect(values[a]).toMatchObject({ recordedCount: 2, projectionPending: true });
    await store.positionMetrics.tick();
    expect((await store.positionMetrics.readMany([a], now + 1))[a].recordedCount).toBe(3);
    // Removing a retained record subtracts its projected contribution too.
    db.prepare("DELETE FROM history_records WHERE address=? AND record_key='one'").run(a);
    db.prepare("INSERT INTO position_metrics_queue VALUES(?,'one',?)").run(a, now + 2);
    await store.positionMetrics.tick();
    expect((await store.positionMetrics.readMany([a], now + 2))[a].recordedCount).toBe(2);
    db.prepare("UPDATE history_jobs SET state=? WHERE address=? AND kind='trades'")
      .run(JSON.stringify({ complete: true, cursor: "older", lastSuccessAt: now - 400000, error: "timeout" }), a);
    expect((await store.positionMetrics.readMany([a], now))[a]).toMatchObject({
      recordedCount: 2, backfillComplete: false, stale: true,
    });
    const reopened = await createStore({ dataDir: dir });
    stores.push(reopened);
    expect((await reopened.positionMetrics.readMany([a], now))[a].recordedCount).toBe(2);
    await expect(store.positionMetrics.readMany(Array(26).fill(a))).rejects.toThrow("Invalid retained");
    expect(await store.positionMetrics.readMany([])).toEqual({});
  });

  it("uses one bounded SQL read for 25 leaderboard wallets without reading raw history", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const metrics = createPgPositionMetrics({ query } as never);
    const addresses = Array.from({ length: 25 }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`);
    await metrics.readMany(addresses, now);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual(addresses);
    expect(query.mock.calls[0][0]).not.toContain("history_records");
    expect(query.mock.calls[0][0]).not.toMatch(/count\(\*\)/i);
  });
  it("uses equal position weights globally and the same valid cohort for both means", async () => {
    const { store, db } = await local();
    expect(await store.positionMetrics.read()).toMatchObject({
      positionCount: 0,
      avgHoldMs: null,
      avgLeverage: null,
      excludedCount: 0,
      pending: true,
    });
    retain(db, "a", closed({ terminal: false, retired: true }));
    retain(db, "b", closed({ openedAtMs: now - 1300, leverage: 4 }));
    retain(
      db,
      "c",
      closed({ kind: "Liquidated", openedAtMs: now - 1800, leverage: 12 }),
      { address: b },
    );
    retain(db, "bad-leverage", closed({ leverage: 0 }));
    retain(db, "bad-duration", closed({ openedAtMs: now }));
    await store.positionMetrics.tick();
    expect(await store.positionMetrics.read()).toMatchObject({
      positionCount: 3,
      avgHoldMs: 400,
      avgLeverage: 6,
      excludedCount: 2,
      pending: false,
      projectionBackfillComplete: true,
    });
    expect(await store.positionMetrics.read(a)).toMatchObject({
      positionCount: 2,
      avgHoldMs: 200,
      avgLeverage: 3,
      excludedCount: 2,
    });
    expect(await store.positionMetrics.read(b)).toMatchObject({
      positionCount: 1,
      avgHoldMs: 800,
      avgLeverage: 12,
    });
  });
  it("subtracts old contributions on correction and coalesces replayed records", async () => {
    const { store, db } = await local();
    retain(db, "one", closed());
    await store.positionMetrics.tick();
    retain(db, "one", closed({ openedAtMs: now - 1400, leverage: 6 }), {
      at: now + 1,
    });
    retain(db, "one", closed({ openedAtMs: now - 1400, leverage: 6 }), {
      at: now + 1,
    });
    expect((await store.positionMetrics.read(a)).pending).toBe(true);
    expect((await store.positionMetrics.tick()).processed).toBe(1);
    expect(await store.positionMetrics.read()).toMatchObject({
      positionCount: 1,
      avgHoldMs: 400,
      avgLeverage: 6,
    });
    // A late old response cannot revert the retained record or its projection.
    retain(db, "one", closed(), { at: now });
    expect((await store.positionMetrics.tick()).processed).toBe(0);
    retain(db, "one", closed({ leverage: 1.5 }), { at: now + 2 });
    await store.positionMetrics.tick();
    expect(await store.positionMetrics.read()).toMatchObject({
      positionCount: 0,
      avgHoldMs: null,
      avgLeverage: null,
      excludedCount: 1,
    });
    retain(db, "one", closed({ openedAtMs: now - 1000 }), { at: now + 3 });
    await store.positionMetrics.tick();
    expect(await store.positionMetrics.read()).toMatchObject({
      positionCount: 1,
      avgHoldMs: 0,
      avgLeverage: 2,
      excludedCount: 0,
    });
  });
  it("excludes invalid and ambiguous rows and rechecks clock-skew exclusions when observed later", async () => {
    const { store, db } = await local();
    const values = [
      closed({ openedAtMs: -1 }),
      closed({ leverage: null }),
      closed({ leverage: Number.MAX_SAFE_INTEGER + 1 }),
      closed({ timestampMs: now + 30001 }),
      closed({ kind: "PositionOpened" }),
    ];
    values.forEach((value, i) => retain(db, `invalid-${i}`, value));
    retain(db, "ambiguous", closed(), { ambiguous: 1 });
    retain(db, "skew-allowed", closed({ timestampMs: now + 30000 }));
    await store.positionMetrics.tick();
    expect(await store.positionMetrics.read()).toMatchObject({
      positionCount: 1,
      excludedCount: 6,
    });
    // Same payload/hash, new observation time: previously future close is valid.
    retain(db, "invalid-3", values[3], { at: now + 30001 });
    await store.positionMetrics.tick();
    expect(await store.positionMetrics.read()).toMatchObject({
      positionCount: 2,
      excludedCount: 5,
    });
  });
  it("commits the source record, durable queue, and fenced checkpoint together", async () => {
    const { store, db } = await local();
    const at = Date.now(),
      job = await tradeJob(store, at);
    db.exec("DROP TABLE position_metrics_queue");
    await expect(
      store.history.commitPage(
        job,
        {
          items: [closed({ timestampMs: at - 1, openedAtMs: at - 101 })],
          nextCursor: null,
        },
        at,
        60000,
      ),
    ).rejects.toThrow();
    expect(
      db.prepare("SELECT count(*) n FROM history_records").get(),
    ).toMatchObject({ n: 0 });
    expect(
      (await store.history.getStatus(a)).find((j) => j.kind === "trades")?.state
        .pages,
    ).toBe(0);
    db.exec(positionMetricsSchemaSql("", false));
    await store.history.commitPage(
      job,
      {
        items: [closed({ timestampMs: at - 1, openedAtMs: at - 101 })],
        nextCursor: null,
      },
      at,
      60000,
    );
    expect(
      db.prepare("SELECT count(*) n FROM position_metrics_queue").get(),
    ).toMatchObject({ n: 1 });
    await store.positionMetrics.tick();
    expect(await store.positionMetrics.read()).toMatchObject({
      positionCount: 1,
      avgHoldMs: 100,
    });
    await expect(
      store.history.commitPage(
        job,
        { items: [closed({ positionId: "expired" })], nextCursor: null },
        at + 1,
        60000,
      ),
    ).rejects.toThrow();
    expect(
      db.prepare("SELECT count(*) n FROM history_records").get(),
    ).toMatchObject({ n: 1 });
  });
  it("preserves occurrence multiplicity but excludes the retained ambiguous copies", async () => {
    const { store } = await local();
    const at = Date.now(),
      item = closed({ timestampMs: at - 1, openedAtMs: at - 101 });
    await store.history.commitPage(
      await tradeJob(store, at),
      { items: [item, item], nextCursor: null },
      at,
      60000,
    );
    await store.positionMetrics.tick();
    expect(await store.positionMetrics.read()).toMatchObject({
      positionCount: 1,
      excludedCount: 1,
      avgHoldMs: 100,
    });
  });
  it("resumes a bounded legacy scan after restart and stops scanning once complete", async () => {
    const { store, db, dir } = await local();
    for (const key of ["b", "c", "d"])
      retain(db, key, closed(), { queue: false });
    expect(await store.positionMetrics.tick(1)).toMatchObject({
      backfilled: 1,
      processed: 1,
      projectionBackfillComplete: false,
      pending: true,
    });
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = await createStore({ dataDir: dir });
    stores.push(restarted);
    expect(await restarted.positionMetrics.tick(1)).toMatchObject({
      backfilled: 1,
      processed: 1,
    });
    expect(await restarted.positionMetrics.tick(1)).toMatchObject({
      backfilled: 1,
      processed: 1,
    });
    expect(await restarted.positionMetrics.tick(1)).toMatchObject({
      backfilled: 0,
      processed: 0,
      projectionBackfillComplete: true,
      pending: false,
    });
    // A newly retained key sorts behind the completed cursor, but live enqueue catches it.
    retain(db, "a", closed({ leverage: 10 }));
    expect(await restarted.positionMetrics.tick(1)).toMatchObject({
      backfilled: 0,
      processed: 1,
    });
    expect(await restarted.positionMetrics.read()).toMatchObject({
      positionCount: 4,
      avgLeverage: 4,
    });
  });
  it("rolls back a failed projection without consuming its queue or legacy checkpoint", async () => {
    const { store, db } = await local();
    retain(db, "one", closed());
    db.exec(
      "CREATE TRIGGER fail_projection BEFORE INSERT ON position_metrics_facts BEGIN SELECT RAISE(ABORT, 'test projection failure'); END",
    );
    await expect(store.positionMetrics.tick()).rejects.toThrow(
      "test projection failure",
    );
    expect(
      db.prepare("SELECT count(*) n FROM position_metrics_rollups").get(),
    ).toMatchObject({ n: 0 });
    expect(
      db.prepare("SELECT count(*) n FROM position_metrics_queue").get(),
    ).toMatchObject({ n: 1 });
    expect(
      db
        .prepare("SELECT complete,cursor_key FROM position_metrics_state")
        .get(),
    ).toMatchObject({ complete: 0, cursor_key: "" });
    db.exec("DROP TRIGGER fail_projection");
    await store.positionMetrics.tick();
    expect(await store.positionMetrics.read()).toMatchObject({
      positionCount: 1,
      pending: false,
    });
  });
  it("keeps exact accumulated sums above Number's safe integer limit", async () => {
    const { store, db } = await local();
    const end = Number.MAX_SAFE_INTEGER - 40000;
    for (let i = 0; i < 3; i++)
      retain(
        db,
        String(i),
        closed({
          timestampMs: end,
          openedAtMs: i,
          leverage: Number.MAX_SAFE_INTEGER - i,
        }),
        { at: end },
      );
    await store.positionMetrics.tick();
    expect(
      db
        .prepare(
          "SELECT hold_sum,leverage_sum FROM position_metrics_rollups WHERE scope='global'",
        )
        .get(),
    ).toMatchObject({
      hold_sum: (3n * BigInt(end) - 3n).toString(),
      leverage_sum: (3n * BigInt(Number.MAX_SAFE_INTEGER) - 3n).toString(),
    });
    expect(await store.positionMetrics.read()).toMatchObject({
      avgHoldMs: end - 1,
      avgLeverage: Number.MAX_SAFE_INTEGER - 1,
    });
  });
});
