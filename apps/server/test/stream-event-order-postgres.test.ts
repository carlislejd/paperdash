import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createStore, type Store } from "../src/store.js";
import { emptyOverview } from "../src/collector.js";
import type { TradeEvent } from "../../../packages/shared/src/types.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("PostgreSQL stream commit ordering", () => {
  it("prevents quotes and trades committing past an allocated but uncommitted status ID, and releases ownership after rollback", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const schema = `stream_order_${suffix}`;
    const barrierKey = parseInt(suffix.slice(0, 7), 16);
    const admin = new Pool({ connectionString: databaseUrl });
    const connection = new URL(databaseUrl!);
    connection.searchParams.set("options", `-c search_path=${schema}`);
    connection.searchParams.set("application_name", schema);
    const scoped = new Pool({ connectionString: connection.toString() });
    let store: Store | undefined;
    let releaseBarrier: (() => Promise<void>) | undefined;
    const pending: Promise<unknown>[] = [];
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      store = await createStore({ databaseUrl: connection.toString(), autoMigrate: true });
      await scoped.query(`
        CREATE FUNCTION block_event_fixture() RETURNS trigger LANGUAGE plpgsql AS $fixture$
        BEGIN
          IF NEW.payload->'data'->>'message'='blocked-first' THEN
            PERFORM pg_advisory_xact_lock(74481235,${barrierKey});
          ELSIF NEW.payload->'data'->>'message'='abort-fixture' THEN
            RAISE EXCEPTION 'Deliberate stream fixture rollback';
          END IF;
          RETURN NEW;
        END
        $fixture$;
        CREATE TRIGGER stream_fixture AFTER INSERT ON paperdash_stream_events
          FOR EACH ROW EXECUTE FUNCTION block_event_fixture();
      `);
      const blocker = await scoped.connect();
      await blocker.query("SELECT pg_advisory_lock(74481235,$1)", [barrierKey]);
      releaseBarrier = async () => {
        await blocker.query("SELECT pg_advisory_unlock(74481235,$1)", [barrierKey]);
        blocker.release();
        releaseBarrier = undefined;
      };
      async function waitForBlocked(queryPart: string, count: number) {
        const until = Date.now() + 5000;
        while (Date.now() < until) {
          const result = await admin.query(
            "SELECT count(*) AS n FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE $2",
            [schema, `%${queryPart}%`],
          );
          if (Number(result.rows[0].n) >= count) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`Expected ${count} blocked stream writers at ${queryPart}`);
      }
      const status = emptyOverview("postgres").status;
      const first = store.event({ type: "status", data: { ...status, message: "blocked-first" } });
      pending.push(first);
      await waitForBlocked("INSERT INTO paperdash_stream_events", 1);
      const now = Date.now();
      const trade: TradeEvent = {
        id: "order:trade", ts: now, wallet: `0x${"8".repeat(40)}`,
        instrument: 1, side: "long", leverage: 10, notionalUsd: 100,
        kind: "liq", pnlUsd: -10, provenance: "public-stream",
      };
      const quoteWrite = store.market.quote({ instrument: 0, priceUsd: 80000, sourceAt: now, receivedAt: now });
      const tradeWrite = store.recordTrade(trade);
      pending.push(quoteWrite, tradeWrite);
      await waitForBlocked("pg_advisory_xact_lock(74481234,0)", 2);
      // Neither a later stream ID nor its transaction's financial data may
      // become visible while the earlier allocated notification is held open.
      expect(await store.events("0")).toEqual([]);
      expect((await scoped.query("SELECT count(*) AS n FROM paperdash_trade_observations")).rows[0].n).toBe("0");
      expect((await scoped.query("SELECT count(*) AS n FROM paperdash_market_prices")).rows[0].n).toBe("0");
      await releaseBarrier();
      await Promise.all(pending);
      const rows = await store.events("0");
      expect(rows).toHaveLength(3);
      expect(rows[0].id).toBe(await first);
      expect(rows[0].message.type).toBe("status");
      expect(new Set(rows.map((row) => row.message.type))).toEqual(new Set(["status", "trade", "asset-price"]));
      expect(rows.every((row, index) => index === 0 || BigInt(row.id) > BigInt(rows[index - 1].id))).toBe(true);
      expect((await store.liquidations.stats(undefined, now)).day.count).toBe(1);
      expect((await store.market.read(0, now)).price?.priceUsd).toBe(80000);

      await expect(store.event({ type: "status", data: { ...status, message: "abort-fixture" } })).rejects.toThrow("Deliberate stream fixture rollback");
      const afterFailure = await store.event({ type: "status", data: { ...status, message: "after-rollback" } });
      const tail = await store.events(rows.at(-1)!.id);
      expect(tail.map((row) => row.id)).toEqual([afterFailure]);
      expect(BigInt(afterFailure)).toBeGreaterThan(BigInt(rows.at(-1)!.id));
    } finally {
      await releaseBarrier?.();
      await Promise.allSettled(pending);
      await store?.close();
      await scoped.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  }, 20000);
});
