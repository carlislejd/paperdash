import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { historySchemaSql } from "../src/history-store.js";
import {
  createPgDepositMetrics,
  depositMetricsSchemaSql,
  enqueueDepositMetrics,
  migratePgDepositMetricsIndexes,
  depositMetricsIndexStatusSql,
} from "../src/deposit-metrics-store.js";
import { digest } from "../src/schemas.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const wallet = `0x${"9".repeat(40)}`,
  DAY = 86400000;
const start = 1800000000000 - (1800000000000 % DAY),
  at = start + 4 * DAY;
const value = (amount = "10", time = start + 1000) => ({
  kind: "Deposit",
  amountRaw: amount,
  timestampMs: time,
});
const cleanups: (() => Promise<void>)[] = [];
const placeholders = (sql: string) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};
async function isolated() {
  const schema = `deposit_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  url.searchParams.set("application_name", schema);
  const scoped = new Pool({ connectionString: url.toString() });
  cleanups.push(async () => {
    await scoped.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  await scoped.query(historySchemaSql("paperdash_", true));
  await scoped.query(depositMetricsSchemaSql("paperdash_", true));
  await migratePgDepositMetricsIndexes(scoped);
  expect(
    (await scoped.query(depositMetricsIndexStatusSql)).rows[0],
  ).toMatchObject({ valid: true, expected: true });
  // Re-running the owner migration preserves a valid concurrent index.
  await migratePgDepositMetricsIndexes(scoped);
  const first = createPgDepositMetrics(scoped),
    second = createPgDepositMetrics(scoped);
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
        "INSERT INTO paperdash_history_records VALUES($1,'cashflows',$2,$3,$4,$5,1,$6) ON CONFLICT(address,kind,record_key) DO UPDATE SET source_at=excluded.source_at,payload=excluded.payload,payload_hash=excluded.payload_hash,received_at=excluded.received_at WHERE paperdash_history_records.received_at<=excluded.received_at",
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
        const mark = enqueueDepositMetrics("paperdash_", wallet, key);
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
describe.skipIf(!databaseUrl)("PostgreSQL credited deposit projection", () => {
  it("retains a deletion mark while the first projection has a queue lock but no fact yet", async () => {
    const { first, second, scoped, retain, waiting } = await isolated();
    await first.tick(); // Complete the empty legacy scan before the race.
    await retain("first", value());
    const blocker = await scoped.connect();
    let projecting: Promise<unknown> | undefined,
      deleting: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT * FROM paperdash_deposit_metrics_totals WHERE id=1 FOR UPDATE",
      );
      projecting = first.tick(1);
      await waiting(
        "SELECT excluded_count FROM paperdash_deposit_metrics_totals",
      );
      deleting = (async () => {
        const client = await scoped.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "DELETE FROM paperdash_history_records WHERE address=$1 AND kind='cashflows' AND record_key='first'",
            [wallet],
          );
          const mark = enqueueDepositMetrics("paperdash_", wallet, "first");
          await client.query(placeholders(mark.sql), mark.params);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      })();
      await waiting("INSERT INTO paperdash_deposit_metrics_queue");
      await blocker.query("COMMIT");
      await Promise.all([projecting, deleting]);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await Promise.allSettled(
        [projecting, deleting].filter((p) => p !== undefined),
      );
    }
    expect(await first.read(start, start + DAY)).toMatchObject({
      pending: true,
      days: [{ depositVolumeRaw: "10", firstDepositors: 1 }],
    });
    await second.tick();
    expect(await first.read(start, start + DAY)).toMatchObject({
      pending: false,
      observedFrom: null,
      days: [{ depositVolumeRaw: "0", depositCount: 0, firstDepositors: 0 }],
    });
    expect(
      (
        await scoped.query(
          "SELECT count(*) n FROM paperdash_deposit_metrics_facts",
        )
      ).rows[0].n,
    ).toBe("0");
  }, 20000);

  it("keeps a correction queued behind a projector and serializes same-wallet first-deposit changes", async () => {
    const { first, second, scoped, retain, waiting } = await isolated();
    await retain("one", value("30", start + DAY));
    await first.tick();
    await retain("one", value("20"), at + 1);
    const blocker = await scoped.connect();
    let projecting: Promise<unknown> | undefined,
      producing: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT * FROM paperdash_deposit_metrics_totals WHERE id=1 FOR UPDATE",
      );
      projecting = first.tick(1);
      await waiting(
        "SELECT excluded_count FROM paperdash_deposit_metrics_totals",
      );
      // This returns to the already-projected hash. Queue presence must still
      // force a mark, otherwise the intermediate 20 would incorrectly win.
      producing = retain("one", value("30", start + DAY), at + 2);
      await waiting("INSERT INTO paperdash_deposit_metrics_queue");
      await blocker.query("COMMIT");
      await Promise.all([projecting, producing]);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await Promise.allSettled(
        [projecting, producing].filter((p) => p !== undefined),
      );
    }
    const intermediate = await second.read(start, start + 3 * DAY);
    expect(intermediate.pending).toBe(true);
    expect(intermediate.days.find((day) => day.time === start)).toMatchObject({
      depositVolumeRaw: "20",
      firstDepositors: 1,
    });
    await retain("two", value("7", start - DAY), at + 3);
    await Promise.all([first.tick(1), second.tick(1)]);
    const result = await first.read(start - DAY, start + 3 * DAY);
    expect(result.pending).toBe(false);
    expect(result.days).toEqual([
      {
        time: start - DAY,
        depositVolumeRaw: "7",
        depositCount: 1,
        firstDepositors: 1,
      },
      {
        time: start,
        depositVolumeRaw: "0",
        depositCount: 0,
        firstDepositors: 0,
      },
      {
        time: start + DAY,
        depositVolumeRaw: "30",
        depositCount: 1,
        firstDepositors: 0,
      },
    ]);
    const changedAt = result.updatedAt;
    await retain("one", value("30", start + DAY), at + 4);
    expect(await first.tick()).toMatchObject({ processed: 0 });
    expect((await first.read(start, start + 3 * DAY)).updatedAt).toBe(
      changedAt,
    );
  }, 20000);

  it("resumes bounded legacy progress and rolls back failed facts, first deposits and daily totals atomically", async () => {
    const { first, second, scoped, retain } = await isolated();
    for (const key of ["b", "c", "d"]) await retain(key, value(), at, false);
    expect(await first.tick(1)).toMatchObject({
      backfilled: 1,
      processed: 1,
      projectionBackfillComplete: false,
    });
    expect(await second.tick(1)).toMatchObject({
      backfilled: 1,
      processed: 1,
      projectionBackfillComplete: false,
    });
    await first.tick(10);
    await retain("a", value("5", start - DAY), at + 1);
    await scoped.query(
      `ALTER TABLE paperdash_deposit_metrics_days ADD CONSTRAINT fail_projection CHECK (time<>${start - DAY})`,
    );
    await expect(second.tick(1)).rejects.toThrow();
    expect(
      (
        await scoped.query(
          "SELECT count(*) n FROM paperdash_deposit_metrics_facts WHERE record_key='a'",
        )
      ).rows[0].n,
    ).toBe("0");
    expect(await first.read(start - DAY, start + DAY)).toMatchObject({
      pending: true,
      days: [
        {
          time: start,
          depositVolumeRaw: "30",
          depositCount: 3,
          firstDepositors: 1,
        },
      ],
    });
    await scoped.query(
      "ALTER TABLE paperdash_deposit_metrics_days DROP CONSTRAINT fail_projection",
    );
    expect(await second.tick(1)).toMatchObject({
      backfilled: 0,
      processed: 1,
      pending: false,
    });
    expect((await first.read(start - DAY, start + DAY)).days).toEqual([
      {
        time: start - DAY,
        depositVolumeRaw: "5",
        depositCount: 1,
        firstDepositors: 1,
      },
      {
        time: start,
        depositVolumeRaw: "30",
        depositCount: 3,
        firstDepositors: 0,
      },
    ]);
    const deleting = await scoped.connect();
    await deleting.query("BEGIN");
    try {
      await deleting.query(
        "DELETE FROM paperdash_history_records WHERE address=$1 AND kind='cashflows' AND record_key='a'",
        [wallet],
      );
      const mark = enqueueDepositMetrics("paperdash_", wallet, "a");
      await deleting.query(placeholders(mark.sql), mark.params);
      await deleting.query("COMMIT");
    } catch (error) {
      await deleting.query("ROLLBACK");
      throw error;
    } finally {
      deleting.release();
    }
    await first.tick();
    expect((await first.read(start, start + DAY)).days[0].firstDepositors).toBe(
      1,
    );
  }, 20000);
});
