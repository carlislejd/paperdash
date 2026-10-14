import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "../src/store.js";
import * as analyticsIndexes from "../src/analytics-indexes.js";
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
  it.each([false, true])(
    "serializes owner migrations through index builds (owner disconnect: %s)",
    async (disconnect) => {
      const schema = `owner_${randomUUID().replaceAll("-", "")}`;
      const applications = [`${schema}_first`, `${schema}_second`];
      const admin = new Pool({ connectionString: databaseUrl });
      const url = new URL(databaseUrl!);
      url.searchParams.set("options", `-c search_path=${schema}`);
      const scoped = new Pool({ connectionString: url.toString() });
      const stores: Store[] = [];
      const outcomes: Promise<unknown>[] = [];
      let writer: PoolClient | undefined;
      let completed = 0;
      let phaseReached = false,
        resumePhase = () => {};
      const phaseGate = new Promise<void>((resolve) => {
        resumePhase = resolve;
      });
      let phaseSpy: { mockRestore(): void } | undefined;
      const start = (application: string) => {
        const connection = new URL(url);
        connection.searchParams.set("application_name", application);
        outcomes.push(
          createStore({
            databaseUrl: connection.toString(),
            autoMigrate: true,
          }).then(
            (store) => {
              stores.push(store);
              completed++;
              return null;
            },
            (error: unknown) => {
              completed++;
              return error;
            },
          ),
        );
      };
      const idleOn = async (application: string, key: 0 | 2) =>
        !!(
          await admin.query(
            "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND state='idle' AND xact_start IS NULL AND query=$2",
            [
              application,
              `SELECT pg_try_advisory_lock(74481231, ${key}) AS acquired`,
            ],
          )
        ).rowCount;
      try {
        await admin.query(`CREATE SCHEMA ${schema}`);
        const initial = await createStore({
          databaseUrl: url.toString(),
          autoMigrate: true,
        });
        await initial.close();
        await scoped.query(
          "DROP INDEX paperdash_analytics_wallet_fingerprint_wallet_time",
        );
        // A JS barrier pauses after this owner has acquired both locks and
        // committed schema DDL. Unlike a manually held global lock, it cannot
        // deadlock with owners from other test files competing for admission.
        const runPhase = analyticsIndexes.runPgAnalyticsIndexPhase;
        phaseSpy = vi
          .spyOn(analyticsIndexes, "runPgAnalyticsIndexPhase")
          .mockImplementation(async (client) => {
            if (!phaseReached) {
              phaseReached = true;
              await phaseGate;
            }
            await runPhase(client);
          });
        start(applications[0]);
        await until(async () => phaseReached, "the first owner's index phase");
        writer = await scoped.connect();
        await writer.query("BEGIN");
        await writer.query(
          "INSERT INTO paperdash_analytics_wallet_fingerprints VALUES('retained','0x0000000000000000000000000000000000000000',0,0,0)",
        );
        resumePhase();
        await until(
          async () =>
            !!(
              await admin.query(
                "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND state='active' AND wait_event_type='Lock' AND query LIKE 'CREATE INDEX CONCURRENTLY%'",
                [applications[0]],
              )
            ).rowCount,
          "the concurrent build to wait on the retained writer",
        );
        start(applications[1]);
        await until(
          () => idleOn(applications[1], 0),
          "the second owner to wait before BEGIN",
        );
        expect(completed).toBe(0);
        if (disconnect) {
          // Owner admission and its concurrent build share this PID. Terminating
          // it cannot leave an unowned index child running in another session.
          const owner = await admin.query(
            "SELECT a.pid,a.query FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name=$1 AND l.locktype='advisory' AND l.classid=74481231 AND l.objid=0",
            [applications[0]],
          );
          expect(owner.rows).toHaveLength(1);
          expect(owner.rows[0].query).toMatch(/^CREATE INDEX CONCURRENTLY/);
          await admin.query("SELECT pg_terminate_backend($1)", [
            owner.rows[0].pid,
          ]);
          await until(
            async () => completed >= 1,
            "the terminated owner to reject",
          );
          expect(
            (
              await admin.query(
                "SELECT 1 FROM pg_stat_activity WHERE application_name=$1",
                [applications[0]],
              )
            ).rowCount,
          ).toBe(0);
        }
        await writer.query("COMMIT");
        writer.release();
        writer = undefined;
        await until(
          async () => completed === 2,
          "both automatic migrations to finish",
        );
        const results = await Promise.all(outcomes);
        if (disconnect) {
          expect(results[0]).toBeInstanceOf(Error);
          expect(results[1]).toBeNull();
        } else expect(results).toEqual([null, null]);
        expect((await scoped.query(walletAssetIndexStatusSql)).rows[0]).toEqual(
          {
            valid: true,
            expected: true,
          },
        );
        expect(
          (await scoped.query(depositMetricsIndexStatusSql)).rows[0],
        ).toEqual({ valid: true, expected: true });
        expect(
          (
            await scoped.query(
              "SELECT count(*) n FROM paperdash_analytics_wallet_fingerprints WHERE fingerprint='retained'",
            )
          ).rows[0].n,
        ).toBe("1");
        expect(
          (
            await admin.query(
              "SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name=ANY($1) AND l.locktype='advisory'",
              [applications],
            )
          ).rowCount,
        ).toBe(0);
      } finally {
        resumePhase();
        if (writer) {
          await writer.query("ROLLBACK");
          writer.release();
        }
        if (completed < outcomes.length)
          await admin.query(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=ANY($1)",
            [applications],
          );
        await Promise.all(outcomes);
        phaseSpy?.mockRestore();
        await Promise.all(stores.map((store) => store.close()));
        await scoped.end();
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      }
    },
    45000,
  );

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
