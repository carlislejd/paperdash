import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createStore, type Store } from "../src/store.js";
import { digest } from "../src/schemas.js";
import { enqueuePositionMetrics } from "../src/position-metrics-store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const wallet = `0x${"9".repeat(40)}`;
const at = 1800000000000;
const value = (leverage = 2) => ({
  kind: "PositionClosed",
  positionId: "1",
  timestampMs: at - 1000,
  openedAtMs: at - 1100,
  leverage,
  instrumentId: 0,
  isLong: true,
  symbol: "BTC",
  adjustedPnlRaw: String(leverage),
});
const cleanups: (() => Promise<void>)[] = [];
const placeholders = (sql: string) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};
async function isolated() {
  const schema = `position_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  url.searchParams.set("application_name", schema);
  const scoped = new Pool({ connectionString: url.toString() });
  const stores: Store[] = [];
  cleanups.push(async () => {
    for (const store of stores) await store.close();
    await scoped.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const first = await createStore({
    databaseUrl: url.toString(),
    autoMigrate: true,
  });
  stores.push(first);
  const second = await createStore({
    databaseUrl: url.toString(),
    autoMigrate: false,
  });
  stores.push(second);
  async function retain(
    key: string,
    payload: Record<string, unknown>,
    receivedAt = at,
    queue = true,
  ) {
    const client = await scoped.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO paperdash_history_records VALUES($1,'trades',$2,$3,$4,$5,0,$6) ON CONFLICT(address,kind,record_key) DO UPDATE SET source_at=excluded.source_at,payload=excluded.payload,payload_hash=excluded.payload_hash,received_at=excluded.received_at WHERE paperdash_history_records.received_at<=excluded.received_at",
        [
          wallet,
          key,
          payload.timestampMs,
          JSON.stringify(payload),
          digest(payload),
          receivedAt,
        ],
      );
      if (queue) {
        const mark = enqueuePositionMetrics("paperdash_", wallet, key);
        await client.query(placeholders(mark.sql), mark.params);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async function waiting(queryPart: string) {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const result = await admin.query(
        "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE $2 LIMIT 1",
        [schema, `%${queryPart}%`],
      );
      if (result.rowCount) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Expected database lock wait: ${queryPart}`);
  }
  return { first, second, scoped, retain, waiting };
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
describe.skipIf(!databaseUrl)("PostgreSQL position metrics", () => {
  it("does not lose an A-to-B-to-A correction behind a projecting queue row", async () => {
    const { first, second, scoped, retain, waiting } = await isolated();
    await retain("one", value());
    await first.positionMetrics.tick();
    await retain("one", value(4), at + 1);
    // Block only the aggregate row. The projector will hold the queue lock,
    // read the committed source, then wait here while the producer changes it.
    const blocker = await scoped.connect();
    let projecting: Promise<unknown> | undefined,
      producing: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT * FROM paperdash_position_metrics_rollups WHERE scope='global' FOR UPDATE",
      );
      projecting = first.positionMetrics.tick(1);
      await waiting("position_metrics_rollups WHERE scope=$1 FOR UPDATE");
      // The restored source matches the old projected hash. Queue presence must
      // still force a mark while the projector is applying intermediate B.
      producing = retain("one", value(2), at + 2);
      await waiting("INSERT INTO paperdash_position_metrics_queue");
      await blocker.query("COMMIT");
      await Promise.all([projecting, producing]);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await Promise.allSettled(
        [projecting, producing].filter((p) => p !== undefined),
      );
    }
    expect(await second.positionMetrics.read()).toMatchObject({
      positionCount: 1,
      avgLeverage: 4,
      pending: true,
    });
    expect(
      (await second.positionMetrics.read(wallet)).highlights,
    ).toMatchObject({
      tradeCount: 1,
      complete: false,
      bestTrade: { pnlRaw: "4" },
    });
    await Promise.all([
      first.positionMetrics.tick(1),
      second.positionMetrics.tick(1),
    ]);
    expect(await first.positionMetrics.read()).toMatchObject({
      positionCount: 1,
      avgHoldMs: 100,
      avgLeverage: 2,
      pending: false,
    });
    expect((await first.positionMetrics.read(wallet)).highlights).toMatchObject(
      { tradeCount: 1, complete: true, bestTrade: { pnlRaw: "2" } },
    );
    expect(
      (
        await scoped.query(
          "SELECT count(*) n FROM paperdash_position_metrics_facts",
        )
      ).rows[0].n,
    ).toBe("1");
  }, 20000);
  it("orders exact signed PnL with its wallet index and rolls back both projections on failure", async () => {
    const { first, second, scoped, retain } = await isolated();
    const max = ((1n << 255n) - 1n).toString(),
      min = (-(1n << 255n)).toString();
    await retain("high", { ...value(), adjustedPnlRaw: max, positionId: "2" });
    await retain("low", { ...value(0), adjustedPnlRaw: min, positionId: "3" });
    await retain("zero", { ...value(), adjustedPnlRaw: "0", positionId: "4" });
    await Promise.all([
      first.positionMetrics.tick(10),
      second.positionMetrics.tick(10),
    ]);
    expect((await first.positionMetrics.read(wallet)).highlights).toEqual({
      bestTrade: { pnlRaw: max, symbol: "BTC", positionId: "2" },
      worstTrade: { pnlRaw: min, symbol: "BTC", positionId: "3" },
      tradeCount: 3,
      excludedCount: 0,
      complete: true,
    });
    const client = await scoped.connect();
    try {
      // Tiny fixture cardinality normally favors a sequential scan. This proves
      // the exact indexed read is available without relying on planner heuristics.
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan=off");
      const plan = await client.query(
        "EXPLAIN SELECT pnl_raw FROM paperdash_position_metrics_highlights WHERE address=$1 AND pnl_sort IS NOT NULL ORDER BY pnl_sort DESC,record_key DESC LIMIT 1",
        [wallet],
      );
      expect(JSON.stringify(plan.rows)).toContain(
        "paperdash_position_metrics_highlight_order",
      );
      expect(JSON.stringify(plan.rows)).not.toContain(
        '"QUERY PLAN":"  ->  Sort',
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const prior = await first.positionMetrics.read(wallet);
    await scoped.query(
      "ALTER TABLE paperdash_position_metrics_highlights ADD CONSTRAINT fail_highlight CHECK (pnl_raw<>'7')",
    );
    await retain(
      "high",
      { ...value(8), adjustedPnlRaw: "7", positionId: "2" },
      at + 1,
    );
    await expect(first.positionMetrics.tick()).rejects.toThrow();
    expect(await second.positionMetrics.read(wallet)).toMatchObject({
      avgLeverage: prior.avgLeverage,
      highlights: {
        bestTrade: { pnlRaw: max },
        tradeCount: 3,
        complete: false,
      },
      pending: true,
    });
    await scoped.query(
      "ALTER TABLE paperdash_position_metrics_highlights DROP CONSTRAINT fail_highlight",
    );
    await second.positionMetrics.tick();
    expect((await first.positionMetrics.read(wallet)).highlights).toMatchObject(
      { bestTrade: { pnlRaw: "7" }, tradeCount: 3, complete: true },
    );
    await scoped.query(
      "UPDATE paperdash_history_records SET ambiguous=1 WHERE record_key='high'",
    );
    const mark = enqueuePositionMetrics("paperdash_", wallet, "high");
    await scoped.query(placeholders(mark.sql), mark.params);
    await first.positionMetrics.tick();
    expect(
      (await second.positionMetrics.read(wallet)).highlights,
    ).toMatchObject({
      bestTrade: { pnlRaw: "0" },
      tradeCount: 2,
      excludedCount: 1,
      complete: false,
    });
  }, 20000);
  it("skips 75 unchanged facts and preserves future-clock rechecks", async () => {
    const { first, scoped, retain } = await isolated();
    for (let i = 0; i < 75; i++)
      await retain(String(i), { ...value(), positionId: String(i) });
    expect((await first.positionMetrics.tick()).processed).toBe(75);
    const before = await first.positionMetrics.read();
    for (let i = 0; i < 75; i++)
      await retain(String(i), { ...value(), positionId: String(i) }, at + 1000);
    expect(
      (
        await scoped.query(
          "SELECT count(*) n FROM paperdash_position_metrics_queue",
        )
      ).rows[0].n,
    ).toBe("0");
    expect(await first.positionMetrics.tick()).toMatchObject({
      processed: 0,
      pending: false,
    });
    expect(await first.positionMetrics.read()).toEqual(before);
    expect(
      (
        await scoped.query(
          "SELECT min(received_at) oldest,max(received_at) newest FROM paperdash_position_metrics_facts",
        )
      ).rows[0],
    ).toEqual({ oldest: String(at), newest: String(at) });
    const future = { ...value(), timestampMs: at + 60000 };
    await retain("future", future);
    await first.positionMetrics.tick();
    await retain("future", future, at + 29999);
    expect((await first.positionMetrics.tick()).processed).toBe(0);
    await retain("future", future, at + 30000);
    expect((await first.positionMetrics.tick()).processed).toBe(1);
    expect(await first.positionMetrics.read()).toMatchObject({
      positionCount: 76,
      excludedCount: 0,
      pending: false,
    });
  }, 20000);
  it("resumes bounded legacy work and rolls back failed fact/rollup/queue changes together", async () => {
    const { first, second, scoped, retain } = await isolated();
    for (const key of ["b", "c", "d"]) await retain(key, value(), at, false);
    expect(await first.positionMetrics.tick(1)).toMatchObject({
      backfilled: 1,
      processed: 1,
      projectionBackfillComplete: false,
    });
    expect(await second.positionMetrics.tick(1)).toMatchObject({
      backfilled: 1,
      processed: 1,
      projectionBackfillComplete: false,
    });
    await first.positionMetrics.tick(10);
    expect(await first.positionMetrics.read()).toMatchObject({
      positionCount: 3,
      pending: false,
    });
    await retain("a", value(6), at + 1);
    await scoped.query(
      "ALTER TABLE paperdash_position_metrics_rollups ADD CONSTRAINT fail_projection CHECK (position_count<>'4')",
    );
    await expect(second.positionMetrics.tick(1)).rejects.toThrow();
    expect(await first.positionMetrics.read()).toMatchObject({
      positionCount: 3,
      avgLeverage: 2,
      pending: true,
    });
    expect(
      (
        await scoped.query(
          "SELECT count(*) n FROM paperdash_position_metrics_facts WHERE record_key='a'",
        )
      ).rows[0].n,
    ).toBe("0");
    await scoped.query(
      "ALTER TABLE paperdash_position_metrics_rollups DROP CONSTRAINT fail_projection",
    );
    expect(await second.positionMetrics.tick(1)).toMatchObject({
      backfilled: 0,
      processed: 1,
      projectionBackfillComplete: true,
      pending: false,
    });
    expect(await first.positionMetrics.read()).toMatchObject({
      positionCount: 4,
      avgLeverage: 3,
    });
    expect(await first.positionMetrics.tick()).toMatchObject({
      backfilled: 0,
      processed: 0,
    });
  }, 20000);
});
