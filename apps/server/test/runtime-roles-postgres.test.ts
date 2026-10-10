import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createStore, type Store } from "../src/store.js";
import { normalizeHouse, readHouse, refreshHouse } from "../src/house.js";
import { readLiquidations, refreshLiquidations } from "../src/liquidations.js";
import { refreshMarkets, readMarket } from "../src/market.js";
import type { HistoryJob } from "../src/history-store.js";
import type { TradeEvent } from "../../../packages/shared/src/types.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const wallet = `0x${"6".repeat(40)}`;

// Apply the production SQL, substituting only its psql-quoted variables. The
// test must not carry a second, potentially divergent copy of the grant policy.
async function policy(schema: string, apiRole: string, workerRole: string) {
  const source = await readFile(
    new URL("../../../infra/runtime-grants.sql", import.meta.url),
    "utf8",
  );
  const variables: Record<string, string> = {
    app_schema: schema,
    api_role: apiRole,
    ingest_role: workerRole,
  };
  return source.replace(
    /:(["'])(app_schema|api_role|ingest_role)\1/g,
    (_, quote: string, name: string) =>
      quote + variables[name].replaceAll(quote, quote + quote) + quote,
  );
}

describe.skipIf(!databaseUrl)("PostgreSQL runtime role separation", () => {
  it("runs API caches/priorities and worker projections without ownership, while denying unrelated writes and DDL", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const schema = `roles_test_${suffix}`;
    const apiRole = `api_${suffix}`;
    const workerRole = `worker_${suffix}`;
    const admin = new Pool({ connectionString: databaseUrl });
    const scopedUrl = new URL(databaseUrl!);
    scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
    const owner = new Pool({ connectionString: scopedUrl.toString() });
    const stores: Store[] = [];
    const pools: Pool[] = [];
    const at = Date.now();
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(
        `CREATE ROLE ${apiRole} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
      );
      await admin.query(
        `CREATE ROLE ${workerRole} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
      );
      const migration = await createStore({
        databaseUrl: scopedUrl.toString(),
        autoMigrate: true,
      });
      await migration.close();
      async function applyPolicy(apiName = apiRole) {
        const client = await owner.connect();
        try {
          await client.query(await policy(schema, apiName, workerRole));
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      }
      await expect(applyPolicy(`missing_${suffix}`)).rejects.toThrow(
        "Required runtime roles must already exist",
      );
      await owner.query(`GRANT CREATE ON SCHEMA ${schema} TO ${apiRole}`);
      await expect(applyPolicy()).rejects.toThrow(
        "must not have schema CREATE",
      );
      await owner.query(`REVOKE CREATE ON SCHEMA ${schema} FROM ${apiRole}`);
      await owner.query(`GRANT CREATE ON SCHEMA ${schema} TO PUBLIC`);
      await expect(applyPolicy()).rejects.toThrow("including through PUBLIC");
      await owner.query(`REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC`);
      await applyPolicy();
      await owner.query(
        `GRANT UPDATE(state) ON paperdash_history_jobs TO ${apiRole}`,
      );
      await applyPolicy();

      async function runtime(role: string) {
        const url = new URL(scopedUrl);
        // This is SET ROLE under the disposable local administrator connection,
        // not a new password or a production login credential.
        url.searchParams.set(
          "options",
          `-c search_path=${schema} -c role=${role}`,
        );
        const pool = new Pool({ connectionString: url.toString() });
        pools.push(pool);
        expect(
          (await pool.query("SELECT current_user")).rows[0].current_user,
        ).toBe(role);
        const store = await createStore({
          databaseUrl: url.toString(),
          autoMigrate: false,
        });
        stores.push(store);
        return { pool, store };
      }
      const api = await runtime(apiRole);
      const worker = await runtime(workerRole);
      const release = await worker.store.lease();
      expect(release).not.toBeNull();
      await release!();

      await api.store.put("cache:role-fixture", { value: 1 }, at);
      await api.store.put("cache:role-fixture", { value: 2 }, at + 1);
      expect(
        (await api.store.get<{ value: number }>("cache:role-fixture"))?.value
          .value,
      ).toBe(2);
      await api.store.history.ensureWallet(wallet, 10);
      await api.store.history.ensureWallet(wallet, 10);
      const jobs = new Map<string, HistoryJob>();
      for (let i = 0; i < 3; i++) {
        const job = await worker.store.history.claimJob(at + 1000);
        expect(job).not.toBeNull();
        jobs.set(job!.kind, job!);
      }
      const pending = {
        timestampMs: at - 1000,
        txHash: `0x${"1".repeat(64)}`,
        kind: "Withdrawal",
        amountRaw: "1000000000000000000",
        withdrawalStatus: "pending",
      };
      await worker.store.history.commitPage(
        jobs.get("cashflows")!,
        { items: [pending], nextCursor: "older" },
        at + 1001,
        3600000,
      );
      await worker.store.history.commitPage(
        jobs.get("trades")!,
        {
          items: [
            {
              timestampMs: at - 500,
              openedAtMs: at - 1500,
              kind: "PositionClosed",
              positionId: "1",
              leverage: 2,
            },
          ],
          nextCursor: null,
        },
        at + 1001,
        3600000,
      );
      await worker.store.history.commitPortfolio(
        jobs.get("portfolio")!,
        {
          baseTimeMs: at - 1000,
          intervalMs: 1000,
          timeOffsetsMs: [0],
          columns: { equity: [2], pnl: [1] },
          gapIndices: [],
          coverage: {
            availableFromMs: at - 1000,
            availableToMs: at - 1000,
            complete: false,
          },
          source: { asOfMs: at, generation: "roles", revision: "1" },
        },
        "all",
        at + 1001,
        3600000,
      );
      const tail = await worker.store.history.claimJob(at + 3000);
      expect(tail?.kind).toBe("cashflows");
      await worker.store.history.commitPage(
        tail!,
        { items: [], nextCursor: null },
        at + 3001,
        3600000,
      );
      const correction = await worker.store.history.claimJob(at + 302000);
      expect(correction?.correctionId).toBeTruthy();
      await worker.store.history.commitPage(
        correction!,
        {
          items: [{ ...pending, withdrawalStatus: "settled" }],
          nextCursor: "older",
        },
        at + 302001,
        3600000,
      );
      await api.store.history.ensureWallet(wallet, 10);
      expect(
        (await api.store.history.readPage(wallet, "cashflows")).items,
      ).toHaveLength(1);
      expect(
        (await api.store.history.readPage(wallet, "trades")).items,
      ).toHaveLength(1);
      expect(
        (await api.store.history.readPortfolio(wallet))?.value.columns.equity,
      ).toEqual([2]);
      await worker.store.positionMetrics.tick(10);
      expect((await api.store.positionMetrics.read(wallet)).positionCount).toBe(
        1,
      );
      await worker.store.history.retainProtocol([{ time: at, value: 5 }]);
      await worker.store.sample(at, 5);
      await worker.store.sample(at, 6);

      const trade: TradeEvent = {
        id: "roles:stream",
        ts: at - 1000,
        wallet,
        instrument: 0,
        side: "long",
        leverage: 10,
        notionalUsd: 100,
        kind: "liq",
        pnlUsd: -10,
        provenance: "public-stream",
      };
      expect(await worker.store.recordTrade(trade)).toBe(true);
      expect(
        await worker.store.trade({
          ...trade,
          id: "roles:recent",
          priceUsd: 80000,
          provenance: "recent-api",
        }),
      ).toBe(true);
      await worker.store.analytics.backfill(10);
      await worker.store.liquidations.backfill(10);
      await worker.store.analytics.sample({
        instrument: 0,
        time: at,
        longRaw: "100000000000000000000",
        shortRaw: "0",
        sourceBlock: null,
        sourceAt: at,
      });
      expect(
        (await api.store.analytics.walletActivity("trades", 0, "", at)).rows[0]
          .count,
      ).toBe(1);
      await worker.store.market.quote({
        instrument: 0,
        sourceAt: at,
        receivedAt: at,
        priceUsd: 80000,
        gapBefore: true,
      });
      await refreshMarkets(worker.store, at);
      await worker.store.house.sample(
        normalizeHouse(
          {
            ok: true,
            historyGeneration: "roles",
            historyRevision: "1",
            sourceAsOfMs: at,
            head: [at, 100, 5, 2, 0, 0, 0, 0],
          },
          at,
        ),
      );
      await refreshHouse(worker.store, at);
      await refreshLiquidations(worker.store, at);
      expect((await readHouse(api.store, at)).house?.fundsRaw).toBe(
        "93000000000000000000",
      );
      expect((await readMarket(api.store, 0, at)).price?.priceUsd).toBe(80000);
      expect(
        (await readLiquidations(api.store, undefined, undefined, at)).stats.day
          .count,
      ).toBe(1);
      expect(
        (await api.store.liquidations.page(undefined, undefined, at)).items[0]
          .priceUsd,
      ).toBe(80000);
      await worker.store.event({ type: "trade", data: trade });
      expect((await api.store.eventBounds()).latest).not.toBeNull();
      expect((await api.store.events()).length).toBeGreaterThan(0);

      for (const { pool } of [api, worker]) {
        await expect(
          pool.query("CREATE TABLE forbidden(id integer)"),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          pool.query(
            "ALTER TABLE paperdash_snapshots ADD COLUMN forbidden integer",
          ),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          pool.query("DROP TABLE paperdash_snapshots"),
        ).rejects.toMatchObject({ code: "42501" });
      }
      await expect(
        api.pool.query("DELETE FROM paperdash_snapshots"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        api.pool.query("UPDATE paperdash_history_jobs SET state='{}'"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        api.store.recordTrade({ ...trade, id: "forbidden-api" }),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        api.pool.query("SELECT nextval('paperdash_stream_events_id_seq')"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        api.pool.query("SELECT * FROM paperdash_history_pages"),
      ).rejects.toMatchObject({ code: "42501" });
      for (const table of [
        "paperdash_trade_observations",
        "paperdash_history_pages",
        "paperdash_history_portfolio_batches",
      ]) {
        await expect(
          worker.pool.query(`UPDATE ${table} SET payload='{}' WHERE false`),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          worker.pool.query(`DELETE FROM ${table} WHERE false`),
        ).rejects.toMatchObject({ code: "42501" });
      }
      // Grants never silently extend to another service's current/future tables.
      await owner.query("CREATE TABLE unrelated_fixture(secret text)");
      for (const { pool } of [api, worker])
        await expect(
          pool.query("SELECT * FROM unrelated_fixture"),
        ).rejects.toMatchObject({ code: "42501" });
    } finally {
      for (const store of stores) await store.close();
      for (const pool of pools) await pool.end();
      await owner.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.query(`DROP OWNED BY ${apiRole},${workerRole}`);
      await admin.query(`DROP ROLE IF EXISTS ${apiRole}`);
      await admin.query(`DROP ROLE IF EXISTS ${workerRole}`);
      await admin.end();
    }
  }, 30000);
});
