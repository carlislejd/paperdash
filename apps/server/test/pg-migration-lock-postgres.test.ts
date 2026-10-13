import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import {
  migratePgAnalyticsIndexes,
  walletAssetIndexStatusSql,
} from "../src/analytics-indexes.js";
import {
  depositMetricsIndexStatusSql,
  migratePgDepositMetricsIndexes,
} from "../src/deposit-metrics-store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

async function until(check: () => Promise<boolean>, description: string) {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

describe.skipIf(!databaseUrl)("PostgreSQL concurrent index admission", () => {
  it("leaves no waiting transaction while two schemas contend for the index lock", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const schemas = [`index_a_${suffix}`, `index_b_${suffix}`];
    const admin = new Pool({ connectionString: databaseUrl });
    const pools = schemas.map((schema) => {
      const url = new URL(databaseUrl!);
      url.searchParams.set("options", `-c search_path=${schema}`);
      url.searchParams.set("application_name", schema);
      return new Pool({ connectionString: url.toString() });
    });
    let writer: PoolClient | undefined;
    const outcomes: Promise<unknown>[] = [];
    let firstDone = false,
      secondDone = false;
    try {
      for (const schema of schemas)
        await admin.query(`CREATE SCHEMA ${schema}`);
      await pools[0].query(
        "CREATE TABLE paperdash_analytics_wallet_fingerprints(wallet TEXT,source_at BIGINT,fingerprint TEXT)",
      );
      await pools[1].query(
        "CREATE TABLE paperdash_history_records(address TEXT,kind TEXT,record_key TEXT)",
      );
      writer = await pools[0].connect();
      await writer.query("BEGIN");
      await writer.query(
        "INSERT INTO paperdash_analytics_wallet_fingerprints VALUES('held',1,'record')",
      );
      // The writer stops the first concurrent build after its catalog commit.
      // The second owner migration must finish each failed try before sleeping;
      // a blocking advisory SELECT would keep a virtual transaction alive here.
      outcomes.push(
        migratePgAnalyticsIndexes(pools[0]).then(
          () => {
            firstDone = true;
            return null;
          },
          (error: unknown) => {
            firstDone = true;
            return error;
          },
        ),
      );
      await until(
        async () =>
          !!(
            await admin.query(
              "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND state='active' AND wait_event_type='Lock' AND query LIKE 'CREATE INDEX CONCURRENTLY%'",
              [schemas[0]],
            )
          ).rowCount,
        "the first concurrent index build to wait on its writer",
      );
      outcomes.push(
        migratePgDepositMetricsIndexes(pools[1]).then(
          () => {
            secondDone = true;
            return null;
          },
          (error: unknown) => {
            secondDone = true;
            return error;
          },
        ),
      );
      await until(
        async () =>
          !!(
            await admin.query(
              "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND state='idle' AND xact_start IS NULL AND query LIKE 'SELECT pg_try_advisory_lock%'",
              [schemas[1]],
            )
          ).rowCount,
        "the contender to wait in JavaScript with no open transaction",
      );
      expect(firstDone).toBe(false);
      expect(secondDone).toBe(false);
      await writer.query("COMMIT");
      writer.release();
      writer = undefined;
      await until(
        async () => firstDone && secondDone,
        "both migrations to converge",
      );
      expect(await Promise.all(outcomes)).toEqual([null, null]);
      expect((await pools[0].query(walletAssetIndexStatusSql)).rows[0]).toEqual(
        { valid: true, expected: true },
      );
      expect(
        (await pools[1].query(depositMetricsIndexStatusSql)).rows[0],
      ).toEqual({ valid: true, expected: true });
      // Dedicated owner sessions close on completion, releasing advisory locks.
      expect(
        (
          await admin.query(
            "SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name=ANY($1) AND l.locktype='advisory'",
            [schemas],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      if (writer) {
        await writer.query("ROLLBACK");
        writer.release();
      }
      // A regression must not leave a 120-second owner query running, or keep
      // another concurrently executing test blocked on the global migration key.
      if (
        outcomes.length &&
        (!firstDone || (outcomes.length > 1 && !secondDone))
      )
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=ANY($1) AND (query LIKE '%advisory_lock%' OR query LIKE 'CREATE INDEX CONCURRENTLY%')",
          [schemas],
        );
      await Promise.all(outcomes);
      await Promise.all(pools.map((pool) => pool.end()));
      for (const schema of schemas)
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  }, 35000);
});
