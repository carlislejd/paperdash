import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createPgHouse, houseSchemaSql } from "../src/house-store.js";
import { normalizeHouse } from "../src/house.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("PostgreSQL coherent house history", () => {
  it("serializes concurrent cross-minute writes, stores exact raw amounts and uses the source index", async () => {
    const schema = `house_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const connection = new URL(url!);
    connection.searchParams.set("options", `-c search_path=${schema}`);
    const pool = new Pool({ connectionString: connection.toString() });
    const store = createPgHouse(pool);
    const at = 1800000000000;
    const value = (time: number, lp: number) =>
      normalizeHouse(
        {
          ok: true,
          historyGeneration: "epoch",
          historyRevision: "revision",
          sourceAsOfMs: time,
          head: [time, lp, 0, 0, 0, 0, 0, 0],
        },
        at + 120000,
      );
    try {
      await pool.query(houseSchemaSql("paperdash_", true));
      await pool.query(houseSchemaSql("paperdash_", true));
      await store.sample(value(at, 1));
      await Promise.all([
        store.sample(value(at + 60000, 10000000000.125)),
        store.sample(value(at + 1000, 999)),
      ]);
      expect((await store.read(at + 60000)).latest?.house.fundsRaw).toBe(
        "10000000000125000000000000000",
      );
      expect(await store.sample(value(at + 500, 99999))).toBe(false);
      await pool.query(
        "ALTER TABLE paperdash_house_samples ADD CONSTRAINT reject_fixture CHECK (lp_raw <> '777000000000000000000')",
      );
      await expect(store.sample(value(at + 120000, 777))).rejects.toThrow();
      expect((await store.read(at + 120000)).latest?.sourceAt).toBe(at + 60000);
      const client = await pool.connect();
      try {
        await client.query("SET enable_seqscan=off");
        const plan = await client.query(
          "EXPLAIN SELECT * FROM paperdash_house_samples WHERE source_at >= $1 AND source_at <= $2 ORDER BY source_at DESC LIMIT 1441",
          [at - 86400000, at],
        );
        expect(JSON.stringify(plan.rows)).toContain(
          "paperdash_house_source_time",
        );
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  }, 20000);
});
