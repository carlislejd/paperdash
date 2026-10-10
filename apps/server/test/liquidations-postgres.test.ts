import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createStore, type Store } from "../src/store.js";
import type { TradeEvent } from "../../../packages/shared/src/types.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("PostgreSQL durable liquidation projection", () => {
  it("projects both raw-write paths atomically, matches source multiplicity under concurrency and resumes legacy backfill", async () => {
    const schema = `liq_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const connection = new URL(url!);
    connection.searchParams.set("options", `-c search_path=${schema}`);
    const scoped = new Pool({ connectionString: connection.toString() });
    const stores: Store[] = [];
    const at = 1800000012345;
    const value = (
      id: string,
      fields: Partial<TradeEvent> = {},
    ): TradeEvent => ({
      id,
      ts: at - 1000,
      wallet: `0x${"a".repeat(40)}`,
      instrument: 0,
      side: "long",
      leverage: 1000,
      notionalUsd: 10000000000,
      kind: "liq",
      pnlUsd: -10000000,
      provenance: "public-stream",
      ...fields,
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
      await Promise.all([
        first.recordTrade(value("stream:1")),
        second.trade(
          value("recent:1", { provenance: "recent-api", priceUsd: 81234.5 }),
        ),
      ]);
      expect((await first.liquidations.stats(undefined, at)).day).toMatchObject(
        { count: 1, notionalUsd: 10000000000 },
      );
      const original = (await first.liquidations.page(undefined, undefined, at))
        .items[0];
      expect(original.priceUsd).toBe(81234.5);
      await Promise.all([
        first.trade(value("stream:2")),
        second.recordTrade(value("recent:2", { provenance: "recent-api" })),
        first.recordTrade(value("recent:3", { provenance: "recent-api" })),
      ]);
      expect((await second.liquidations.stats(undefined, at)).day.count).toBe(
        3,
      );
      expect(
        (await second.liquidations.page(undefined, undefined, at)).items,
      ).toHaveLength(3);
      await scoped.query(
        "ALTER TABLE paperdash_liquidation_events ADD CONSTRAINT reject_fixture CHECK ((payload->>'notionalUsd')::numeric<>777)",
      );
      await expect(
        first.recordTrade(value("rollback", { notionalUsd: 777 })),
      ).rejects.toThrow();
      expect(
        Number(
          (
            await scoped.query(
              "SELECT count(*) AS n FROM paperdash_trade_observations WHERE id='rollback'",
            )
          ).rows[0].n,
        ),
      ).toBe(0);
      expect(
        Number(
          (
            await scoped.query(
              "SELECT count(*) AS n FROM paperdash_liquidation_members WHERE id='rollback'",
            )
          ).rows[0].n,
        ),
      ).toBe(0);
      expect((await first.liquidations.stats(undefined, at)).day.count).toBe(3);
      await scoped.query(
        "ALTER TABLE paperdash_liquidation_events DROP CONSTRAINT reject_fixture",
      );
      for (let i = 0; i < 3; i++) {
        const old = value(`legacy:${i}`, {
          ts: at - 10000 - i,
          notionalUsd: 100 + i,
        });
        await scoped.query(
          "INSERT INTO paperdash_trade_observations(id,payload,source_at,received_at) VALUES($1,$2,$3,$4)",
          [old.id, JSON.stringify(old), old.ts, at],
        );
      }
      expect(await first.liquidations.backfill(2)).toEqual({
        processed: 2,
        complete: false,
      });
      await first.close();
      stores.splice(stores.indexOf(first), 1);
      const restarted = await createStore({
        databaseUrl: connection.toString(),
        autoMigrate: false,
      });
      stores.push(restarted);
      for (let i = 0; i < 10; i++)
        if ((await restarted.liquidations.backfill(2)).complete) break;
      expect(
        (await restarted.liquidations.stats(undefined, at)).day.count,
      ).toBe(6);
      expect(
        (await restarted.liquidations.stats(undefined, at)).coverage
          .projectionBackfillComplete,
      ).toBe(true);
      await restarted.recordTrade(
        value("a-before-cursor", { notionalUsd: 99 }),
      );
      expect(await restarted.liquidations.backfill(2)).toEqual({
        processed: 0,
        complete: true,
      });
      expect(
        (await restarted.liquidations.stats(undefined, at)).day.count,
      ).toBe(7);
      const beforeHourly = await restarted.liquidations.stats(undefined, at);
      for (const observation of [
        value("hourly:outside", { ts: at - 86400001, instrument: 1 }),
        value("hourly:left", {
          ts: at - 86400000,
          instrument: 1,
          notionalUsd: 7,
        }),
        value("hourly:interior", { ts: at - 7200000, notionalUsd: 0.125 }),
        value("hourly:right", { ts: at, instrument: 1, notionalUsd: 11 }),
        value("hourly:right-recent", {
          ts: at,
          instrument: 1,
          notionalUsd: 11,
          provenance: "recent-api",
        }),
        value("hourly:future", { ts: at + 1, instrument: 1 }),
      ])
        await restarted.recordTrade(observation);
      const hourly = await restarted.liquidations.stats(undefined, at);
      expect(hourly.day.count).toBe(beforeHourly.day.count + 3);
      expect(hourly.day.notionalUsd).toBe(
        beforeHourly.day.notionalUsd + 18.125,
      );
      expect(hourly.hourly.buckets).toHaveLength(25);
      expect(hourly.hourly).toMatchObject({
        intervalMs: 3600000,
        from: at - 86400000,
        to: at,
      });
      expect(hourly.hourly.buckets[0]).toMatchObject({
        partial: true,
        assets: [
          { instrument: 0, count: 0, notionalUsd: 0 },
          { instrument: 1, count: 1, notionalUsd: 7 },
        ],
      });
      expect(hourly.hourly.buckets.at(-1)?.assets[1]).toEqual({
        instrument: 1,
        count: 1,
        notionalUsd: 11,
      });
      expect(
        hourly.hourly.buckets
          .flatMap((b) => b.assets)
          .reduce((n, a) => n + a.count, 0),
      ).toBe(hourly.day.count);
      expect(
        hourly.hourly.buckets
          .flatMap((b) => b.assets)
          .reduce((n, a) => n + a.notionalUsd, 0),
      ).toBe(hourly.day.notionalUsd);
      const ethHourly = await restarted.liquidations.stats(1, at);
      expect(ethHourly.day).toMatchObject({ count: 2, notionalUsd: 18 });
      expect(
        ethHourly.hourly.buckets.every(
          (b) => b.assets.length === 1 && b.assets[0].instrument === 1,
        ),
      ).toBe(true);
      const client = await scoped.connect();
      try {
        await client.query("SET enable_seqscan=off");
        const plans = [
          await client.query(
            "EXPLAIN SELECT id,payload FROM paperdash_liquidation_events WHERE instrument=$1 AND source_at<=$2 ORDER BY source_at DESC,id DESC LIMIT 51",
            [0, at],
          ),
          await client.query(
            "EXPLAIN SELECT id,payload FROM paperdash_trade_observations WHERE id>$1 AND payload->>'kind'='liq' ORDER BY id LIMIT 1",
            [""],
          ),
          await client.query(
            "EXPLAIN SELECT id,payload FROM paperdash_liquidation_events WHERE instrument=$1 AND source_at<=$2 AND (source_at,id)<($3,$4) ORDER BY source_at DESC,id DESC LIMIT 51",
            [0, at, at - 1, original.id],
          ),
        ];
        expect(JSON.stringify(plans[0].rows)).toContain(
          "paperdash_liquidation_event_instrument",
        );
        expect(JSON.stringify(plans[1].rows)).toContain(
          "paperdash_liquidation_raw_ids",
        );
        const deep = plans[2].rows.map((row) => row["QUERY PLAN"]).join("\n");
        expect(deep).toContain("paperdash_liquidation_event_instrument");
        expect(deep).toMatch(/Index Cond:.*ROW\(source_at, id\)/);
      } finally {
        client.release();
      }
    } finally {
      for (const store of stores) await store.close();
      await scoped.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  }, 20000);
});
