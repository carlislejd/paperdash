import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createStore, migrate, type Store } from "../src/store.js";
import {
  migratePgAnalyticsIndexes,
  walletAssetIndexStatusSql,
} from "../src/analytics-indexes.js";
import type { TradeEvent } from "../../../packages/shared/src/types.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const index = "paperdash_analytics_wallet_fingerprint_wallet_time";
describe.skipIf(!databaseUrl)(
  "PostgreSQL leaderboard activity and concurrent index migration",
  () => {
    it("builds outside transactions, keeps a valid index, repairs an interrupted build, and reads exact batch metrics", async () => {
      const schema = `leaderboard_${randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`CREATE SCHEMA ${schema}`);
      const url = new URL(databaseUrl!);
      url.searchParams.set("options", `-c search_path=${schema}`);
      const pool = new Pool({ connectionString: url.toString(), max: 4 });
      let store: Store | undefined;
      try {
        await migrate(pool); // CREATE INDEX CONCURRENTLY would fail inside BEGIN.
        expect((await pool.query(walletAssetIndexStatusSql)).rows[0]).toEqual({
          valid: true,
          expected: true,
        });
        const original = (
          await pool.query(`SELECT '${index}'::regclass::oid AS oid`)
        ).rows[0].oid;
        await Promise.all([
          migratePgAnalyticsIndexes(pool),
          migratePgAnalyticsIndexes(pool),
        ]);
        expect(
          (await pool.query(`SELECT '${index}'::regclass::oid AS oid`)).rows[0]
            .oid,
        ).toBe(original);
        const timeout = (await pool.query("SHOW statement_timeout")).rows[0]
          .statement_timeout;
        expect(timeout).not.toBe("2min"); // owner session budget never mutates the normal pool

        // Exercise the real collector lease, not a mirrored lock-key fixture.
        // Even an actual index build must finish while that lease stays held.
        const collector = await createStore({
          databaseUrl: url.toString(),
          autoMigrate: false,
        });
        let releaseLease: (() => Promise<void>) | null = null;
        let migration: Promise<void> | undefined;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          releaseLease = await collector.lease();
          expect(releaseLease).not.toBeNull();
          await pool.query(`DROP INDEX ${index}`);
          migration = migratePgAnalyticsIndexes(pool);
          await Promise.race([
            migration,
            new Promise<never>((_, reject) => {
              deadline = setTimeout(
                () =>
                  reject(
                    new Error("Index migration waited for the collector lease"),
                  ),
                3000,
              );
            }),
          ]);
          expect((await pool.query(walletAssetIndexStatusSql)).rows[0]).toEqual(
            {
              valid: true,
              expected: true,
            },
          );
        } finally {
          clearTimeout(deadline);
          // On regression the timeout releases ownership first, unblocking the
          // pending build immediately instead of waiting its 120-second budget.
          await releaseLease?.();
          await migration?.catch(() => {});
          await collector.close();
        }

        await pool.query(`DROP INDEX ${index}`);
        const writer = await pool.connect(),
          builder = await pool.connect();
        try {
          await writer.query("BEGIN");
          await writer.query(
            "INSERT INTO paperdash_analytics_wallet_fingerprints VALUES('held','0x0000000000000000000000000000000000000000',0,0,0)",
          );
          await builder.query("SET statement_timeout='100ms'");
          // The uncommitted writer blocks phase two after CREATE committed the
          // catalog entry. Cancellation leaves a real invalid concurrent index.
          await expect(
            builder.query(
              `CREATE INDEX CONCURRENTLY ${index} ON paperdash_analytics_wallet_fingerprints(wallet,source_at,fingerprint)`,
            ),
          ).rejects.toMatchObject({ code: "57014" });
          const interrupted = (await pool.query(walletAssetIndexStatusSql))
            .rows[0];
          expect(interrupted).toEqual({ valid: false, expected: true });
        } finally {
          await writer.query("ROLLBACK");
          await builder.query("RESET statement_timeout");
          writer.release();
          builder.release();
        }
        await expect(
          createStore({ databaseUrl: url.toString(), autoMigrate: false }),
        ).rejects.toThrow("Wallet asset index is unavailable");
        await migratePgAnalyticsIndexes(pool);
        expect((await pool.query(walletAssetIndexStatusSql)).rows[0]).toEqual({
          valid: true,
          expected: true,
        });
        store = await createStore({
          databaseUrl: url.toString(),
          autoMigrate: false,
        });
        const now = 1_800_000_030_000,
          wallet = `0x${"1".repeat(40)}`,
          empty = `0x${"2".repeat(40)}`;
        const event = (
          id: string,
          fields: Partial<TradeEvent> = {},
        ): TradeEvent => ({
          id,
          ts: now,
          wallet,
          instrument: 1,
          side: "long",
          kind: "open",
          leverage: 1,
          notionalUsd: 10_000_000_000.125,
          pnlUsd: null,
          provenance: "public-stream",
          ...fields,
        });
        for (const value of [
          event("start", { ts: now - 86400000, instrument: 0 }),
          event("end"),
          event("repeat", { provenance: "recent-api" }),
          event("old", { ts: now - 86400001, instrument: 7 }),
          event("future", { ts: now + 1, instrument: 9 }),
        ])
          await store.recordTrade(value);
        await store.analytics.backfill();
        const result = await store.analytics.walletMetrics(
          [wallet, empty],
          now,
        );
        expect(result).toMatchObject({
          counts: { [wallet]: 2, [empty]: 0 },
          volumesUsd: { [wallet]: 20_000_000_000.25, [empty]: 0 },
          assetsTraded: { [wallet]: [0, 1], [empty]: [] },
          windowFrom: now - 86400000,
          windowTo: now,
          projectionBackfillComplete: true,
        });
        await pool.query("SET enable_seqscan=off");
        const plan = (
          await pool.query(
            "EXPLAIN SELECT fingerprint FROM paperdash_analytics_wallet_fingerprints WHERE wallet=$1 AND source_at>=$2 AND source_at<=$3",
            [wallet, now - 86400000, now],
          )
        ).rows
          .map((row) => row["QUERY PLAN"])
          .join("\n");
        expect(plan).toContain(index);
        await pool.query("RESET enable_seqscan");

        // A valid same-name index with incompatible ordering must be preserved,
        // not dropped automatically or silently accepted by runtime startup.
        await pool.query(`DROP INDEX ${index}`);
        await pool.query(
          `CREATE INDEX ${index} ON paperdash_analytics_wallet_fingerprints(wallet DESC,source_at,fingerprint)`,
        );
        await expect(migratePgAnalyticsIndexes(pool)).rejects.toThrow(
          "unexpected definition",
        );
        expect((await pool.query(walletAssetIndexStatusSql)).rows[0]).toEqual({
          valid: true,
          expected: false,
        });
      } finally {
        await store?.close();
        await pool.end();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    }, 15000);
  },
);
