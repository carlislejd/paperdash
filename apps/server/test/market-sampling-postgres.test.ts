import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { createStore, type Store } from "../src/store.js";
import { createPgMarket } from "../src/market-store.js";
import {
  sampleFixtures,
  sampleNow as now,
} from "./market-sampling-fixtures.js";
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PostgreSQL windowed trade sampling", () => {
  it("matches SQLite and bounds a synthetic hour with 20,000 executions and 40,000 source observations", async () => {
    const schema = `market_sample_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const connection = new URL(url!);
    connection.searchParams.set("options", `-c search_path=${schema}`);
    const pool = new Pool({
      connectionString: connection.toString(),
      statement_timeout: 10000,
    });
    const stores: Store[] = [];
    try {
      const pg = await createStore({
        databaseUrl: connection.toString(),
        autoMigrate: true,
      });
      stores.push(pg);
      const sqlite = await createStore({ memory: true, databaseUrl: "" });
      stores.push(sqlite);
      for (const trade of sampleFixtures()) {
        await pg.recordTrade(trade);
        await sqlite.recordTrade(trade);
      }
      for (const instrument of [0, 1]) {
        expect((await pg.market.read(instrument, now)).chartSamples).toEqual(
          (await sqlite.market.read(instrument, now)).chartSamples,
        );
      }
      // Bulk synthetic projections only: no external traffic or production data.
      // Each economic execution is observed by both public source transports.
      await pool.query(
        `INSERT INTO paperdash_analytics_fingerprints SELECT 'perf-'||g,0,$1::bigint-3600000+g*180,'long',(g%100+1)*1000000,1,1 FROM generate_series(0,19999) g`,
        [now],
      );
      await pool.query(
        `INSERT INTO paperdash_analytics_members SELECT 'perf-s-'||g,'perf-'||g,'public-stream' FROM generate_series(0,19999) g UNION ALL SELECT 'perf-r-'||g,'perf-'||g,'recent-api' FROM generate_series(0,19999) g`,
      );
      await pool.query(
        `INSERT INTO paperdash_trade_observations SELECT m.id,jsonb_build_object('id',m.id,'ts',f.source_at,'wallet','0x1111111111111111111111111111111111111111','instrument',0,'side','long','leverage',10,'kind','open','notionalUsd',f.notional,'pnlUsd',NULL,'priceUsd',110000.25,'provenance',m.provenance),f.source_at,$1 FROM paperdash_analytics_members m JOIN paperdash_analytics_fingerprints f ON f.fingerprint=m.fingerprint WHERE m.id LIKE 'perf-%'`,
        [now],
      );
      await pool.query(
        `INSERT INTO paperdash_trade_observations SELECT 'outside-'||g,jsonb_build_object('instrument',0,'priceUsd',110000.25),$1::bigint-86400000,$1 FROM generate_series(0,119999) g`,
        [now],
      );
      await pool.query(
        `INSERT INTO paperdash_analytics_members SELECT 'outside-'||g,'outside-'||g,'public-stream' FROM generate_series(0,119999) g`,
      );
      await pool.query(
        `INSERT INTO paperdash_analytics_fingerprints SELECT 'outside-'||g,0,$1::bigint-86400000,'long',100,1,0 FROM generate_series(0,119999) g`,
        [now],
      );
      await pool.query(
        "ANALYZE paperdash_analytics_fingerprints; ANALYZE paperdash_analytics_members; ANALYZE paperdash_trade_observations",
      );
      const query = vi.spyOn(pool, "query");
      const start = performance.now();
      const result = await createPgMarket(pool).read(0, now);
      const elapsed = performance.now() - start;
      for (const sample of Object.values(result.chartSamples)) {
        expect(sample.trades.length).toBeLessThanOrEqual(62);
        expect(sample.trades.length).toBeGreaterThanOrEqual(50);
        const buckets = new Map<number, number>();
        for (const trade of sample.trades) {
          const key = Math.floor(trade.ts / sample.bucketMs);
          buckets.set(key, (buckets.get(key) ?? 0) + 1);
        }
        expect([...buckets.values()].every((n) => n <= 2)).toBe(true);
      }
      expect(result.rawTrades).toHaveLength(400);
      const sampling = query.mock.calls.filter(
        ([sql]) => typeof sql === "string" && sql.startsWith("WITH recent"),
      );
      expect(sampling).toHaveLength(1); // no query per bucket, window or selected trade
      query.mockRestore();
      const plan = await pool.query(
        `EXPLAIN ${sampling[0][0]}`,
        sampling[0][1],
      );
      const planText = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
      expect(planText).toMatch(
        /Bitmap Index Scan on paperdash_trade_(?:instrument_)?time|Index Scan using paperdash_trade_(?:instrument_)?time/,
      );
      expect(planText).toContain(
        "Index Scan using paperdash_analytics_members_pkey",
      );
      expect(planText).toContain(
        "Index Scan using paperdash_analytics_fingerprints_pkey",
      );
      expect(planText).not.toContain("Seq Scan on paperdash_analytics_members");
      expect(planText).not.toContain(
        "Seq Scan on paperdash_analytics_fingerprints",
      );
      if (process.env.MARKET_SAMPLE_PLAN_PATH)
        await writeFile(process.env.MARKET_SAMPLE_PLAN_PATH, planText, "utf8");
      console.info(
        JSON.stringify({
          test: "market-chart-sampling-local",
          syntheticExecutions: 20000,
          sourceObservations: 40000,
          olderObservations: 120000,
          readMs: Math.round(elapsed),
          samples: Object.fromEntries(
            Object.entries(result.chartSamples).map(([window, sample]) => [
              window,
              sample.trades.length,
            ]),
          ),
          externalRequests: 0,
        }),
      );
    } finally {
      for (const store of stores) await store.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  }, 20000);
});
