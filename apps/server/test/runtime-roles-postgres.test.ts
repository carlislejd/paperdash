import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createStore, type Store } from "../src/store.js";
import { normalizeHouse, readHouse, refreshHouse } from "../src/house.js";
import { readLiquidations, refreshLiquidations } from "../src/liquidations.js";
import { refreshMarkets, readMarket } from "../src/market.js";
import { accountKey } from "../src/following-store.js";
import type { HistoryJob } from "../src/history-store.js";
import type {
  Account,
  TradeEvent,
} from "../../../packages/shared/src/types.js";

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
    let at = Date.now();
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
      await owner.query(`GRANT SELECT ON paperdash_trade_inbox TO ${apiRole}`);
      await owner.query(
        `GRANT UPDATE(next_run,failures) ON paperdash_wallet_watches TO ${apiRole}`,
      );
      await owner.query(
        `GRANT UPDATE(watch_until) ON paperdash_wallet_watches TO ${workerRole}`,
      );
      await owner.query(
        `GRANT UPDATE(payload) ON paperdash_trade_inbox TO ${workerRole}`,
      );
      await owner.query(
        `GRANT DELETE ON paperdash_trade_ingestion_gaps TO ${workerRole}`,
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
      // Owner migrations may wait on other test schemas. Start the simulated
      // claim clock after discovery, not before that unrelated setup delay.
      at = Date.now();
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
              instrumentId: 0,
              isLong: true,
              symbol: "BTC",
              adjustedPnlRaw: "19",
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
      await worker.store.depositMetrics.tick(10);
      const depositDay = Math.floor(at / 86400000) * 86400000;
      expect(
        await worker.store.depositMetrics.read(
          depositDay,
          depositDay + 86400000,
        ),
      ).toMatchObject({ projectionBackfillComplete: true, pending: false });
      // API serves the saved protocol chart snapshot; it does not read or alter
      // collector-owned deposit facts and rollups.
      await expect(
        api.pool.query("UPDATE paperdash_deposit_metrics_state SET complete=0"),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        api.pool.query("SELECT * FROM paperdash_deposit_metrics_facts"),
      ).rejects.toThrow(/permission denied/i);
      expect((await api.store.positionMetrics.read(wallet)).positionCount).toBe(
        1,
      );
      expect(
        (await api.store.positionMetrics.read(wallet)).highlights,
      ).toMatchObject({
        bestTrade: { positionId: "1", pnlRaw: "19" },
        tradeCount: 1,
        complete: true,
      });
      await expect(
        api.pool.query(
          "UPDATE paperdash_position_metrics_highlights SET pnl_raw='0'",
        ),
      ).rejects.toThrow(/permission denied/i);
      expect(
        (await api.store.positionMetrics.readMany([wallet], at + 302002))[
          wallet
        ],
      ).toMatchObject({
        recordedCount: 1,
        indexedAt: at + 1001,
        backfillComplete: true,
        projectionPending: false,
        excludedCount: 0,
      });
      await worker.store.history.retainProtocol([{ time: at, value: 5 }]);
      const chartHour = Math.floor(at / 3600000) * 3600000;
      const chartRow = {
        time: chartHour,
        endpointAt: chartHour + 1000,
        sourceAt: chartHour + 1000,
        generation: "roles",
        complete: false,
        values: { openPositions: 7 },
      };
      await worker.store.history.retainProtocolCharts("summary", [chartRow]);
      await worker.store.history.retainProtocolCharts("summary", [
        {
          ...chartRow,
          endpointAt: chartHour + 2000,
          sourceAt: chartHour + 2000,
          values: { openPositions: 42 },
        },
      ]);
      await worker.store.history.retainProtocolCharts("summary", [
        {
          ...chartRow,
          endpointAt: chartHour + 1500,
          sourceAt: chartHour + 1500,
          values: { openPositions: 8 },
        },
      ]);
      expect(await api.store.history.protocolChartRows("summary")).toEqual([
        {
          ...chartRow,
          endpointAt: chartHour + 2000,
          sourceAt: chartHour + 2000,
          values: { openPositions: 42 },
        },
      ]);
      await expect(
        api.store.history.retainProtocolCharts("summary", [chartRow]),
      ).rejects.toMatchObject({ code: "42501" });
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
      expect(
        await api.store.analytics.walletCounts([wallet], at),
      ).toMatchObject({
        counts: { [wallet]: 1 },
        observedFrom: at - 1000,
        projectionBackfillComplete: true,
      });
      // The restricted API role can join the wallet/asset projections in one
      // snapshot; overlapping source observations count once.
      expect(await api.store.analytics.walletMetrics([wallet], at)).toEqual({
        counts: { [wallet]: 1 },
        volumesUsd: { [wallet]: 100 },
        assetsTraded: { [wallet]: [0] },
        windowFrom: at - 86400000,
        windowTo: at,
        observedFrom: at - 1000,
        projectionBackfillComplete: true,
      });
      // Batch Following reads the retained public activity with the API role;
      // stream/recent overlap still represents one economic observation.
      const followingActivity = await api.store.following.activity(
        [wallet],
        at,
      );
      expect(followingActivity.items).toHaveLength(1);
      expect(followingActivity.items[0]).toMatchObject({
        wallet,
        kind: "liq",
        notionalUsd: 100,
      });
      expect(followingActivity.coverage.projectionBackfillComplete).toBe(true);

      const unknownWallet = `0x${"7".repeat(40)}`;
      expect(
        await api.store.following.touch([wallet, unknownWallet], at),
      ).toEqual([wallet]);
      expect(await worker.store.following.nextWatch(at)).toEqual({
        address: wallet,
        failures: 0,
      });
      await worker.store.following.failWatch(wallet, 0, at + 1, at + 90000);
      // Another viewer may extend interest, but cannot rewind worker backoff.
      expect(await api.store.following.touch([wallet], at + 40000)).toEqual([
        wallet,
      ]);
      expect(
        (
          await api.pool.query(
            "SELECT watch_until,next_run,failures FROM paperdash_wallet_watches WHERE address=$1",
            [wallet],
          )
        ).rows[0],
      ).toEqual({
        watch_until: String(at + 160000),
        next_run: String(at + 90000),
        failures: 1,
      });
      const account: Account = {
        address: wallet,
        leaderboardName: null,
        currentBalance: "1000000000000000000",
        currentQueued: "0",
        currentOpenNotional: "0",
        currentOpenPositionCount: 0,
        currentUnrealizedPnl: "0",
        realizedPnl: "0",
        totalVolume: "100000000000000000000",
        totalWindowedPnl: "0",
        paperTotal: "0",
        lastActiveTs: Math.floor(at / 1000),
      };
      // Existing API directory responses may seed the shared account cache,
      // but this default retention path must not require scheduling privileges.
      await api.store.following.retainAccounts([account], at + 45000);
      expect(
        (
          await api.pool.query(
            "SELECT next_run,failures FROM paperdash_wallet_watches WHERE address=$1",
            [wallet],
          )
        ).rows[0],
      ).toEqual({ next_run: String(at + 90000), failures: 1 });
      await worker.store.following.retainAccounts([account], at + 50000, true);
      await worker.store.following.retainAccounts(
        [{ ...account, currentBalance: "0" }],
        at + 20000,
        true,
      );
      expect(
        await api.store.getMany<Account>([
          accountKey(wallet),
          accountKey(unknownWallet),
        ]),
      ).toEqual({
        [accountKey(wallet)]: {
          value: account,
          receivedAt: at + 50000,
        },
      });
      expect(await worker.store.following.nextWatch(at + 109999)).toBeNull();
      expect(await worker.store.following.nextWatch(at + 110000)).toEqual({
        address: wallet,
        failures: 0,
      });
      expect(await worker.store.following.nextWatch(at + 160000)).toBeNull();
      expect(
        (await api.pool.query("SELECT address FROM paperdash_wallet_watches"))
          .rows,
      ).toEqual([]);
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

      // Pending intake survives connection/process replacement. A committed
      // trade whose acknowledgement was lost is replayed with its original ID.
      const pendingTrades: TradeEvent[] = [
        { ...trade, id: "roles:inbox:first", kind: "open", ts: at - 400 },
        { ...trade, id: "roles:inbox:second", kind: "open", ts: at - 300 },
      ];
      async function closeRuntimeStore(value: Store) {
        await value.close();
        stores.splice(stores.indexOf(value), 1);
      }
      const intakeWriter = await runtime(workerRole);
      await intakeWriter.store.tradeInbox.append(pendingTrades, at);
      await intakeWriter.store.tradeInbox.append(pendingTrades, at + 1);
      expect((await intakeWriter.store.tradeInbox.status()).pending).toBe(2);
      await closeRuntimeStore(intakeWriter.store);
      const firstReader = await runtime(workerRole);
      expect(await firstReader.store.tradeInbox.head()).toEqual(pendingTrades);
      expect(await firstReader.store.recordTrade(pendingTrades[0])).toBe(true);
      await closeRuntimeStore(firstReader.store);
      const restarted = await runtime(workerRole);
      const replayed = await restarted.store.tradeInbox.head();
      const inserted: boolean[] = [];
      for (const observation of replayed) {
        inserted.push(await restarted.store.recordTrade(observation));
        await restarted.store.history.ensureWallet(observation.wallet, 20);
        await restarted.store.tradeInbox.acknowledge(observation.id);
      }
      expect(inserted).toEqual([false, true]);
      expect(await restarted.store.tradeInbox.head()).toEqual([]);
      expect((await restarted.store.tradeInbox.status()).pending).toBe(0);
      expect(
        (
          await owner.query(
            "SELECT id FROM paperdash_trade_observations WHERE id LIKE 'roles:inbox:%'",
          )
        ).rowCount,
      ).toBe(2);
      expect(
        (
          await owner.query(
            "SELECT id FROM paperdash_stream_events WHERE payload->'data'->>'id' LIKE 'roles:inbox:%'",
          )
        ).rowCount,
      ).toBe(2);
      const gap = {
        firstAt: at,
        at: at + 10,
        kind: "overflow" as const,
        count: 1,
        reason: "Fixture intake interrupted.",
      };
      await restarted.store.tradeInbox.recordGap(gap);
      await restarted.store.tradeInbox.recordGap({
        ...gap,
        firstAt: at - 10,
        at: at + 5,
        count: 3,
      });
      expect((await restarted.store.tradeInbox.status()).gap).toEqual({
        ...gap,
        firstAt: at - 10,
      });
      await closeRuntimeStore(restarted.store);

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
      for (const query of [
        "INSERT INTO paperdash_analytics_fingerprints SELECT * FROM paperdash_analytics_fingerprints WHERE false",
        "UPDATE paperdash_analytics_fingerprints SET instrument=instrument WHERE false",
        "DELETE FROM paperdash_analytics_fingerprints WHERE false",
      ]) {
        await expect(api.pool.query(query)).rejects.toMatchObject({
          code: "42501",
        });
      }
      await expect(
        api.pool.query("UPDATE paperdash_history_jobs SET state='{}'"),
      ).rejects.toMatchObject({ code: "42501" });
      // A watch request cannot control the worker's retry schedule, and the
      // worker cannot manufacture or extend viewer interest. Reapplying the
      // checked-in policy above removes independently granted column rights.
      for (const query of [
        "UPDATE paperdash_wallet_watches SET next_run=0 WHERE false",
        "UPDATE paperdash_wallet_watches SET failures=0 WHERE false",
        "UPDATE paperdash_wallet_watches SET address=address WHERE false",
        "DELETE FROM paperdash_wallet_watches WHERE false",
        `INSERT INTO paperdash_wallet_watches(address,watch_until,next_run) VALUES('forbidden',1,0)`,
        `INSERT INTO paperdash_wallet_watches(address,watch_until,failures) VALUES('forbidden',1,0)`,
      ]) {
        await expect(api.pool.query(query)).rejects.toMatchObject({
          code: "42501",
        });
      }
      for (const query of [
        "UPDATE paperdash_wallet_watches SET watch_until=0 WHERE false",
        "UPDATE paperdash_wallet_watches SET address=address WHERE false",
        `INSERT INTO paperdash_wallet_watches(address,watch_until) VALUES('forbidden',1)`,
      ]) {
        await expect(worker.pool.query(query)).rejects.toMatchObject({
          code: "42501",
        });
      }
      for (const table of [
        "paperdash_analytics_members",
        "paperdash_trade_observations",
      ]) {
        await expect(
          api.pool.query(`SELECT * FROM ${table} LIMIT 1`),
        ).resolves.toBeDefined();
        for (const query of [
          `INSERT INTO ${table} SELECT * FROM ${table} WHERE false`,
          `UPDATE ${table} SET id=id WHERE false`,
          `DELETE FROM ${table} WHERE false`,
        ]) {
          await expect(api.pool.query(query)).rejects.toMatchObject({
            code: "42501",
          });
        }
      }
      await expect(
        api.store.recordTrade({ ...trade, id: "forbidden-api" }),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        api.pool.query("SELECT nextval('paperdash_stream_events_id_seq')"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        api.pool.query("SELECT * FROM paperdash_history_pages"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        api.store.tradeInbox.append(pendingTrades, at),
      ).rejects.toMatchObject({ code: "42501" });
      // Direct writes must fail independently of helper SELECT/sequence checks.
      await expect(
        api.pool.query(
          "INSERT INTO paperdash_trade_inbox(seq,id,payload,received_at,byte_size) VALUES(999999,'forbidden','{}',1,2)",
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        api.pool.query("DELETE FROM paperdash_trade_inbox"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        api.pool.query(
          "INSERT INTO paperdash_trade_ingestion_gaps(id,first_at,last_at,kind,item_count,reason) VALUES(2,1,1,'malformed',1,'forbidden')",
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        api.pool.query(
          "UPDATE paperdash_trade_ingestion_gaps SET reason='forbidden'",
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(api.store.tradeInbox.head()).rejects.toMatchObject({
        code: "42501",
      });
      await expect(
        api.store.tradeInbox.acknowledge(pendingTrades[0].id),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(api.store.tradeInbox.recordGap(gap)).rejects.toMatchObject({
        code: "42501",
      });
      for (const table of [
        "paperdash_trade_ingestion_gaps",
        "paperdash_trade_inbox_totals",
      ]) {
        await expect(
          api.pool.query(`SELECT * FROM ${table}`),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          worker.pool.query(`DELETE FROM ${table} WHERE false`),
        ).rejects.toMatchObject({ code: "42501" });
      }
      await expect(
        api.pool.query("SELECT nextval('paperdash_trade_inbox_seq_seq')"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        worker.pool.query(
          "UPDATE paperdash_trade_inbox SET payload='{}' WHERE false",
        ),
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
