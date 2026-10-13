import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHistoryStore, historySchemaSql, type HistoryDatabase } from "../src/history-store.js";

const now = 1_800_000_000_000;
afterEach(() => vi.restoreAllMocks());

async function verify(db: HistoryDatabase) {
  vi.spyOn(Date, "now").mockReturnValue(now);
  const history = createHistoryStore(db);
  expect((await history.stats()).activeFreshness).toEqual({ asOf: now, byKind: [] });
  const ages = [null, 0, 59_999, 60_000, 299_999, 300_000, 899_999, 900_000, 3_599_999, 3_600_000, 3_600_001, -1, "invalid", "fractional"];
  const addresses = ages.map((_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
  await history.discoverWallets(addresses, 10);
  const table = `${db.prefix}history_jobs`;
  await db.batch(ages.map((age, i) => ({
    sql: `UPDATE ${table} SET state=?,next_run=? WHERE address=? AND kind='trades'`,
    params: [JSON.stringify({ failures: 0, complete: true, cursor: null,
      lastSuccessAt: age === null ? null : age === "invalid" ? "not a time" : age === "fractional" ? now - 0.5 : now - age }),
      now - 86_400_000, addresses[i]],
  })));
  // Recently activated jobs may have inherited yesterday's due date. This
  // must not replace their actual successful check clocks.
  const result = await history.stats();
  expect(result.oldestActiveDueAt).toBe(now - 86_400_000);
  const trades = result.activeFreshness.byKind.find(row => row.kind === "trades")!;
  expect(trades).toEqual({ kind: "trades", jobs: 14, never: 1, invalidClock: 2, futureClock: 1,
    within1m: 2, oneTo5m: 2, fiveTo15m: 2, fifteenTo60m: 2, over60m: 2,
    oldestSuccessAt: now - 3_600_001 });
  for (const row of result.activeFreshness.byKind) {
    expect(row.jobs).toBe(row.never + row.invalidClock + row.futureClock + row.within1m + row.oneTo5m + row.fiveTo15m + row.fifteenTo60m + row.over60m);
  }
  expect(result.activeFreshness.byKind.find(row => row.kind === "cashflows")).toMatchObject({ jobs: 14, never: 14, oldestSuccessAt: null });
  // Inactive wallets and correction jobs do not enter the primary check ages.
  await history.ensureWallet(`0x${"f".repeat(40)}`);
  expect((await history.stats()).activeFreshness).toEqual(result.activeFreshness);
  vi.mocked(Date.now).mockReturnValue(now + 600_001);
  expect((await history.stats()).activeFreshness.byKind).toEqual([]);
}

it("reports disjoint successful-check ages for active wallets using SQLite", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(historySchemaSql("", false));
  try {
    await verify({ prefix: "",
      async rows<T>(sql: string, params: unknown[] = []) {
        return sqlite.prepare(sql).all(...params as (string | number | null)[]) as T[];
      },
      async batch(statements) {
        sqlite.exec("BEGIN");
        try {
          for (const statement of statements) sqlite.prepare(statement.sql).run(...statement.params as (string | number | null)[]);
          sqlite.exec("COMMIT");
        } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
      },
    });
  } finally { sqlite.close(); }
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("PostgreSQL freshness parity", () => {
  it("uses the same clock boundaries and exclusions in PostgreSQL", async () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const client = await pool.connect();
    const prefix = "freshness_test_";
    const parameters = (sql: string) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
    try {
      await client.query("BEGIN");
      await client.query(historySchemaSql(prefix, true));
      await verify({ prefix,
        async rows<T>(sql: string, params: unknown[] = []) { return (await client.query(parameters(sql), params)).rows as T[]; },
        async batch(statements) {
          for (const statement of statements) await client.query(parameters(statement.sql), statement.params);
        },
      });
    } finally { await client.query("ROLLBACK"); client.release(); await pool.end(); }
  });
});
