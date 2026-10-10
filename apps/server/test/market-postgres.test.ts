import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createStore, type Store } from "../src/store.js";
import { normalizeTrade } from "../src/schemas.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("PostgreSQL market observations", () => {
  it("serializes concurrent source corrections, preserves reconnect gaps, and atomically retains replay events", async () => {
    const schema = `market_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: url });
    const stores: Store[] = [];
    await admin.query(`CREATE SCHEMA ${schema}`);
    const connection = new URL(url!);
    connection.searchParams.set("options", `-c search_path=${schema}`);
    const scoped = new Pool({ connectionString: connection.toString() });
    const now = 1800000000000;
    const quote = (time: number, priceUsd: number, gapBefore = false) => ({
      instrument: 0,
      sourceAt: time,
      receivedAt: now + 10000,
      priceUsd,
      gapBefore,
    });
    try {
      const first = await createStore({
        databaseUrl: connection.toString(),
        autoMigrate: true,
      });
      stores.push(first);
      const second = await createStore({
        databaseUrl: connection.toString(),
        autoMigrate: false,
      });
      stores.push(second);
      await first.market.quote(quote(now + 1, 100, true));
      await Promise.all([
        first.market.quote(quote(now + 900, 102)),
        second.market.quote(quote(now + 500, 999)),
      ]);
      expect((await first.market.read(0, now + 1000)).points).toEqual([
        { time: now + 900, priceUsd: 102, gapBefore: true },
      ]);
      const events = await first.events();
      expect(events.at(-1)?.message).toMatchObject({
        type: "asset-price",
        data: { point: { time: now + 900, priceUsd: 102, gapBefore: true } },
      });
      await scoped.query(
        "ALTER TABLE paperdash_stream_events ADD CONSTRAINT reject_fixture_market CHECK ((payload->'data'->'point'->>'priceUsd')::numeric<>777)",
      );
      await expect(
        first.market.quote(quote(now + 5000, 777)),
      ).rejects.toThrow();
      expect((await second.market.read(0, now + 6000)).points).toHaveLength(1);
      expect(await second.events()).toHaveLength(events.length);
      await scoped.query(
        "ALTER TABLE paperdash_stream_events DROP CONSTRAINT reject_fixture_market",
      );
      const execution = normalizeTrade(
        {
          seq: "1",
          ts: now - 1000,
          wallet: `0x${"1".repeat(40)}`,
          instrument: "BTC",
          side: "long",
          kind: "open",
          leverage: 2,
          notionalUsd: 100,
          pnlUsd: null,
          entry: 100,
        },
        "recent-api",
      );
      await first.recordTrade(execution);
      expect((await second.market.read(0, now)).rawTrades).toEqual([execution]);
      expect((await second.market.read(1, now)).rawTrades).toEqual([]);
      const c = await scoped.connect();
      try {
        await c.query("SET enable_seqscan=off");
        const plan = await c.query(
          "EXPLAIN SELECT payload FROM paperdash_trade_observations WHERE (payload->>'instrument')=$1 AND source_at>=$2 AND source_at<=$3 ORDER BY source_at DESC,id DESC LIMIT 400",
          ["0", now - 3600000, now],
        );
        expect(plan.rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain(
          "paperdash_trade_instrument_time",
        );
      } finally {
        c.release();
      }
    } finally {
      for (const store of stores) await store.close();
      await scoped.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  }, 20000);
});
