import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHistoryStore,
  historySchemaSql,
  type HistoryDatabase,
  type SourcePortfolio,
  type Statement,
} from "../src/history-store.js";

const address = `0x${"a".repeat(40)}`;
const start = 1_800_000_000_000;
afterEach(() => vi.restoreAllMocks());

async function verify(db: HistoryDatabase) {
  let now = start;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let statements: Statement[] = [];
  const history = createHistoryStore({
    ...db,
    async batch(batch) {
      statements = batch;
      await db.batch(batch);
    },
  });
  await history.ensureWallet(address);
  const claim = async () => {
    now += 10;
    const job = await history.claimJob(now, 120000, "fair", [
      { address, kind: "cashflows" },
      { address, kind: "trades" },
    ]);
    expect(job?.kind).toBe("portfolio");
    return job!;
  };
  const points = () =>
    db.rows<{ time: number | string; received_at: number | string }>(
      `SELECT time,received_at FROM ${db.prefix}history_points WHERE scope=? ORDER BY time`,
      [address],
    );
  const projectionWrites = () =>
    statements.filter(({ sql }) =>
      sql.includes(`${db.prefix}history_points`),
    );
  const batches = async () =>
    Number(
      (await db.rows<{ count: number | string }>(
        `SELECT count(*) AS count FROM ${db.prefix}history_portfolio_batches WHERE address=?`,
        [address],
      ))[0].count,
    );
  const value: SourcePortfolio = {
    fromMs: 100,
    toMs: 500,
    baseTimeMs: 100,
    intervalMs: 100,
    timeOffsetsMs: [0, 100, 100, 200, 300],
    columns: { equity: [1, 2, 3, 4, 5], pnl: [0, 1, 2, 3, 4] },
    gapIndices: [2],
    coverage: { availableFromMs: 100, availableToMs: 500, complete: true },
    source: { asOfMs: 1000, revision: "1:1", generation: "a" },
  };
  await history.commitPortfolio(await claim(), value, "all", now, 1);
  const initial = await points();
  expect(projectionWrites()).toHaveLength(5); // One replacement plus four timestamps.
  expect(await batches()).toBe(1);

  // Identical batches keep their durable receipt and point rows, but always
  // checkpoint the new successful check and release the current job fence.
  await history.commitPortfolio(await claim(), value, "all", now, 1);
  expect(projectionWrites()).toHaveLength(0);
  expect(statements).toHaveLength(2); // Checkpoint and deduplicated source batch.
  expect(await points()).toEqual(initial);
  expect(await batches()).toBe(1);
  expect((await history.readPortfolio(address))!.receivedAt).toBe(now);
  const checked = (await history.getStatus(address)).find(
    (job) => job.kind === "portfolio",
  )!;
  expect(checked).toMatchObject({ nextRun: now + 1, lockedUntil: 0 });
  expect(checked.state).toMatchObject({
    pages: 2,
    lastSuccessAt: now,
    failures: 0,
  });

  // New source metadata must be retained even when the projection is identical.
  const metadata = {
    ...value,
    source: { ...value.source!, asOfMs: 2000, revision: "2:2" },
  };
  await history.commitPortfolio(await claim(), metadata, "all", now, 1);
  expect(projectionWrites()).toHaveLength(0);
  expect(await points()).toEqual(initial);
  expect(await batches()).toBe(2);
  expect(
    (await history.getStatus(address)).find((job) => job.kind === "portfolio")!
      .state.portfolio!.source,
  ).toEqual(metadata.source);

  // Corrections, duplicate-time sample order, and gaps all affect the digest.
  const correction = {
    ...metadata,
    columns: { ...metadata.columns, equity: [1, 9, 8, 4, 5] },
    gapIndices: [1],
  };
  await history.commitPortfolio(await claim(), correction, "all", now, 1);
  expect(projectionWrites()).toHaveLength(5);
  const corrected = (await history.readPortfolio(address))!.value;
  expect(corrected.columns.equity).toEqual([1, 9, 8, 4, 5]);
  expect(corrected.gapIndices).toEqual([1]);
  // Reapplying an older retained batch after an intervening correction cannot
  // use raw-batch deduplication as evidence that the current projection matches.
  await history.commitPortfolio(await claim(), metadata, "all", now, 1);
  expect(projectionWrites()).toHaveLength(5);
  expect((await history.readPortfolio(address))!.value.columns.equity).toEqual(
    value.columns.equity,
  );

  const narrow: SourcePortfolio = {
    ...metadata,
    toMs: 300,
    timeOffsetsMs: [0, 100],
    columns: { equity: [11, 12], pnl: [0, 1] },
    gapIndices: [],
    coverage: { availableFromMs: 100, availableToMs: 300, complete: true },
  };
  await history.commitPortfolio(await claim(), narrow, "1d", now, 1);
  expect((await points()).map((row) => Number(row.time))).toEqual([
    100, 200, 300, 400,
  ]);
  expect((await history.readPortfolio(address))!.value.columns.equity).toEqual([
    11, 12, 4, 5,
  ]);
  await history.commitPortfolio(await claim(), narrow, "1d", now, 1);
  expect(projectionWrites()).toHaveLength(0);

  // Empty windows can retract samples; [from,to) preserves the boundary row.
  const empty: SourcePortfolio = {
    ...metadata,
    toMs: 400,
    timeOffsetsMs: [],
    columns: { equity: [], pnl: [] },
    gapIndices: [],
    coverage: { availableFromMs: 100, availableToMs: 400, complete: true },
  };
  await history.commitPortfolio(await claim(), empty, "1d", now, 1);
  expect(projectionWrites()).toHaveLength(1);
  expect((await points()).map((row) => Number(row.time))).toEqual([400]);
  await history.commitPortfolio(await claim(), empty, "1d", now, 1);
  expect(projectionWrites()).toHaveLength(0);
  const inclusive = { ...empty, toMs: undefined };
  await history.commitPortfolio(await claim(), inclusive, "1d", now, 1);
  expect(projectionWrites()).toHaveLength(1);
  expect(await points()).toEqual([]);

  // A changed generation invalidates the whole prior projection, including
  // points outside the new partial window; its repair scheduling is unchanged.
  await history.commitPortfolio(await claim(), metadata, "all", now, 1);
  const rebuilt = {
    ...narrow,
    source: { ...narrow.source!, generation: "b", revision: "0:0" },
  };
  await history.commitPortfolio(await claim(), rebuilt, "1d", now, 1);
  expect((await points()).map((row) => Number(row.time))).toEqual([100, 200]);
  const rebuiltStatus = (await history.getStatus(address)).find(
    (job) => job.kind === "portfolio",
  )!;
  expect(rebuiltStatus.nextRun).toBe(now + 1000);
  expect(rebuiltStatus.state.complete).toBe(false);

  now += 1000;
  const fenced = await claim();
  await history.commitPortfolio(fenced, rebuilt, "1d", now, 1);
  const before = await points();
  const batchCount = await batches();
  const beforeStatus = await history.getStatus(address);
  await expect(
    history.commitPortfolio(fenced, rebuilt, "1d", now + 1, 1),
  ).rejects.toThrow("lease changed");
  await expect(
    history.commitPortfolio(
      fenced,
      { ...rebuilt, gapIndices: [0] },
      "1d",
      now + 1,
      1,
    ),
  ).rejects.toThrow("lease changed");
  expect(await points()).toEqual(before);
  expect(await batches()).toBe(batchCount);
  expect(await history.getStatus(address)).toEqual(beforeStatus);
}

it("skips unchanged portfolio projection writes while retaining checks, corrections and fences in SQLite", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(historySchemaSql("", false));
  try {
    await verify({
      prefix: "",
      async rows<T>(sql: string, params: unknown[] = []) {
        return sqlite
          .prepare(sql)
          .all(...params as (string | number | null)[]) as T[];
      },
      async batch(statements) {
        sqlite.exec("BEGIN");
        try {
          for (const statement of statements) {
            const result = sqlite
              .prepare(statement.sql)
              .run(...statement.params as (string | number | null)[]);
            if (
              statement.requireChanges !== undefined &&
              result.changes !== statement.requireChanges
            )
              throw new Error("History job lease changed");
          }
          sqlite.exec("COMMIT");
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    });
  } finally {
    sqlite.close();
  }
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("PostgreSQL portfolio projection parity", () => {
  it("preserves identical no-op and replacement semantics under PostgreSQL transactions", async () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const client = await pool.connect();
    const prefix = "projection_optimization_test_";
    const parameters = (sql: string) => {
      let i = 0;
      return sql.replace(/\?/g, () => `$${++i}`);
    };
    try {
      await client.query("BEGIN");
      await client.query(historySchemaSql(prefix, true));
      await verify({
        prefix,
        async rows<T>(sql: string, params: unknown[] = []) {
          return (await client.query(parameters(sql), params)).rows as T[];
        },
        async batch(statements) {
          await client.query("SAVEPOINT projection_batch");
          try {
            for (const statement of statements) {
              const result = await client.query(
                parameters(statement.sql),
                statement.params,
              );
              if (
                statement.requireChanges !== undefined &&
                result.rowCount !== statement.requireChanges
              )
                throw new Error("History job lease changed");
            }
            await client.query("RELEASE SAVEPOINT projection_batch");
          } catch (error) {
            await client.query("ROLLBACK TO SAVEPOINT projection_batch");
            throw error;
          }
        },
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  });
});
