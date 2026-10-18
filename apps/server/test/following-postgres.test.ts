import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createStore, type Store } from "../src/store.js";
import { createPgFollowing } from "../src/following-store.js";
import type {
  Account,
  TradeEvent,
} from "../../../packages/shared/src/types.js";

const url = process.env.TEST_DATABASE_URL;
const at = 1800000012345;
const addr = (n = 1) => `0x${n.toString(16).padStart(40, "0")}`;
const account = (n = 1): Account => ({
  address: addr(n),
  leaderboardName: null,
  currentBalance: "100",
  currentQueued: "0",
  currentOpenNotional: "0",
  currentOpenPositionCount: 0,
  currentUnrealizedPnl: "0",
  realizedPnl: "0",
  totalVolume: "0",
  totalWindowedPnl: "0",
  paperTotal: "0",
  lastActiveTs: 1,
});
const trade = (id: string, more: Partial<TradeEvent> = {}): TradeEvent => ({
  id,
  ts: at - 1000,
  wallet: addr(),
  instrument: 0,
  side: "long",
  kind: "open",
  leverage: 1000,
  notionalUsd: 10000,
  pnlUsd: null,
  provenance: "public-stream",
  priceUsd: 80000,
  ...more,
});
describe.skipIf(!url)("PostgreSQL Following", () => {
  it("matches the bounded active profit cohort and uses indexed trades and account lookups amid cold history", async () => {
    const schema = `active_profit_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const connection = new URL(url!);
    connection.searchParams.set("options", `-c search_path=${schema}`);
    const pool = new Pool({ connectionString: connection.toString() });
    let pg: Store | undefined, local: Store | undefined;
    try {
      pg = await createStore({ databaseUrl: connection.toString(), autoMigrate: true });
      local = await createStore({ memory: true, databaseUrl: "" });
      for (const store of [pg, local]) {
        for (let n = 1; n <= 30; n++) await store.recordTrade(trade(`active:${n}`, { wallet: addr(n), instrument: n % 2 }));
        await store.following.retainAccounts([account(1)], at);
        await store.following.retainAccounts([account(2)], at - 240000);
        await store.following.retainAccounts([account(3)], at - 240001);
        await store.following.retainAccounts([account(4)], at + 1);
        await store.put(`account-summary:${addr(5)}`, { ...account(5), realizedPnl: "01" }, at);
        await store.put(`account-summary:${addr(6)}`, account(100), at);
        await store.put(`account-summary:${addr(7)}`, { ...account(7), realizedPnl: 1 }, at);
        await store.recordTrade(trade("old", { wallet: addr(100), ts: at - 3600001 }));
        await store.recordTrade(trade("future", { wallet: addr(101), ts: at + 1 }));
        await store.recordTrade(trade("close", { wallet: addr(102), kind: "close" }));
        await store.recordTrade(trade("boundary", { wallet: addr(103), ts: at - 3600000 }));
      }
      await pool.query(`INSERT INTO paperdash_trade_observations(id,payload,source_at,received_at)
        SELECT 'cold:'||n,jsonb_build_object('instrument',n%2,'wallet',$1::text,'kind','open'),$2::bigint-n,$2::bigint
        FROM generate_series(1,20000) n`, [addr(999), at - 7200000]);
      await pool.query(`INSERT INTO paperdash_snapshots(key,payload,received_at)
        SELECT 'cold:'||n,'{}'::jsonb,$1::bigint FROM generate_series(1,20000) n`, [at]);
      await pool.query("ANALYZE paperdash_trade_observations");
      await pool.query("ANALYZE paperdash_snapshots");
      let plan = "";
      const explained = createPgFollowing({ query: async (sql: string, args: unknown[]) => {
        if (sql.startsWith("WITH recent AS MATERIALIZED")) {
          const result = await pool.query(`EXPLAIN (ANALYZE,BUFFERS) ${sql}`, args);
          plan = result.rows.map((row) => row["QUERY PLAN"]).join("\n");
        }
        return pool.query(sql, args);
      } } as Pool);
      expect(await explained.profitRefreshCandidates("", at)).toEqual(await local.following.profitRefreshCandidates("", at));
      expect(await pg.following.profitRefreshCandidates(addr(25), at)).toEqual(await local.following.profitRefreshCandidates(addr(25), at));
      expect(await pg.following.profitRefreshCandidates("", at)).toHaveLength(25);
      expect(plan).toMatch(/paperdash_trade_(instrument_time|time)/);
      expect(plan).toContain("paperdash_snapshots_pkey");
      expect(plan).not.toMatch(/Seq Scan on paperdash_(snapshots|trade_observations)/);
    } finally {
      await Promise.allSettled([pg?.close(), local?.close(), pool.end()]);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
  it("matches SQLite dense source multiplicity and indexed bounds, and enforces watch admission across instances", async () => {
    const schema = `following_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const connection = new URL(url!);
    connection.searchParams.set("options", `-c search_path=${schema}`);
    const pool = new Pool({ connectionString: connection.toString() });
    let pg: Store | undefined, local: Store | undefined;
    try {
      pg = await createStore({
        databaseUrl: connection.toString(),
        autoMigrate: true,
      });
      local = await createStore({ memory: true });
      const values: TradeEvent[] = [];
      for (let i = 0; i < 55; i++)
        values.push(
          trade(`stream:${i}`),
          trade(`recent:${i}`, { provenance: "recent-api" }),
        );
      values.push(
        trade("left", { wallet: addr(2), ts: at - 86400000 }),
        trade("past", { wallet: addr(2), ts: at - 86400001 }),
        trade("future", { wallet: addr(2), ts: at + 1 }),
      );
      for (const value of values) {
        await pg.recordTrade(value);
        await local.recordTrade(value);
      }
      // Unrelated older history must not enter the per-wallet candidate cohort.
      await pool.query(
        `INSERT INTO paperdash_analytics_wallet_fingerprints(fingerprint,wallet,source_at,notional,effective_count)
        SELECT 'old:'||n,$1,$2::bigint-n,100,1 FROM generate_series(1,20000) n`,
        [addr(99), at - 2 * 86400000],
      );
      await pool.query("ANALYZE paperdash_analytics_wallet_fingerprints");
      const expected = await local.following.activity([addr(), addr(2)], at);
      const actual = await pg.following.activity([addr(), addr(2)], at);
      expect(actual.items).toEqual(expected.items);
      expect(actual.items).toHaveLength(50);
      expect(actual.coverage.truncated).toBe(true);
      expect(new Set(actual.items.map((v) => v.id)).size).toBe(50);
      expect(
        actual.items.every(
          (v) => v.provenance === "recent-api" && v.priceUsd === 80000,
        ),
      ).toBe(true);
      expect((await pg.following.activity([addr(2)], at)).items).toHaveLength(
        1,
      );
      let plan = "";
      const explained = createPgFollowing({
        query: async (sql: string, args: unknown[]) => {
          if (sql.startsWith("WITH candidates")) {
            const result = await pool.query(
              `EXPLAIN (ANALYZE,BUFFERS) ${sql}`,
              args,
            );
            plan = result.rows.map((r) => r["QUERY PLAN"]).join("\n");
          }
          return pool.query(sql, args);
        },
      } as Pool);
      await explained.activity([addr(), addr(2)], at);
      expect(plan).toContain(
        "paperdash_analytics_wallet_fingerprint_wallet_time",
      );
      expect(plan).toContain("paperdash_analytics_members_fingerprint");
      expect(plan).toContain("paperdash_trade_observations_pkey");
      expect(plan).not.toMatch(/Seq Scan on paperdash_trade_observations/);
      for (let first = 1; first <= 1025; first += 25)
        await pg.following.retainAccounts(
          Array.from({ length: 25 }, (_, i) => account(first + i)),
          at,
        );
      const other = createPgFollowing(pool);
      const admitted = await Promise.all(
        Array.from({ length: 41 }, (_, group) =>
          (group % 2 ? other : pg!.following).touch(
            Array.from({ length: 25 }, (_, i) => addr(1 + group * 25 + i)),
            at,
          ),
        ),
      );
      expect(admitted.flat()).toHaveLength(1000);
      expect(
        Number(
          (
            await pool.query(
              "SELECT count(*) AS n FROM paperdash_wallet_watches",
            )
          ).rows[0].n,
        ),
      ).toBe(1000);
      const job = await pg.following.nextWatch(at);
      expect(job).not.toBeNull();
      await pg.following.failWatch(job!.address, 3, at, at + 200000);
      await other.touch([job!.address], at + 30000);
      expect(
        Number(
          (
            await pool.query(
              "SELECT next_run FROM paperdash_wallet_watches WHERE address=$1",
              [job!.address],
            )
          ).rows[0].next_run,
        ),
      ).toBe(at + 200000);
      await other.retainAccounts(
        [account(Number.parseInt(job!.address.slice(2), 16))],
        at,
        true,
      );
      expect(
        Number(
          (
            await pool.query(
              "SELECT failures FROM paperdash_wallet_watches WHERE address=$1",
              [job!.address],
            )
          ).rows[0].failures,
        ),
      ).toBe(4); // identical cached receipt does not clear backoff
      await pg.close();
      pg = undefined;
      const next = await other.nextWatch(at + 30000);
      expect(next?.address).not.toBe(job!.address);
    } finally {
      await pg?.close();
      await local?.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  }, 20000);
});
