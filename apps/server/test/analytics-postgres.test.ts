import { afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createStore, type Store } from "../src/store.js";
import type { TradeEvent } from "../../../packages/shared/src/types.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const instrument = 987654;
const address = "0xdddddddddddddddddddddddddddddddddddddddd";
const stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});
describe.skipIf(!databaseUrl)(
  "PostgreSQL observed analytics integration",
  () => {
    it("atomically merges concurrent source observations and backfills legacy rows without repeating completed work", async () => {
      const first = await createStore({ databaseUrl, autoMigrate: true });
      stores.push(first);
      const second = await createStore({ databaseUrl, autoMigrate: false });
      stores.push(second);
      const admin = new Pool({ connectionString: databaseUrl });
      const now = Date.now();
      const event = (
        id: string,
        fields: Partial<TradeEvent> = {},
      ): TradeEvent => ({
        id: `analytics-pg-${id}`,
        ts: now - 1000,
        wallet: address,
        instrument,
        side: "long",
        leverage: 2,
        notionalUsd: 0.125,
        kind: "open",
        pnlUsd: null,
        provenance: "public-stream",
        ...fields,
      });
      try {
        // Touch only this test's synthetic instrument/wallet/ID namespace.
        await admin.query(
          "DELETE FROM paperdash_analytics_members WHERE id LIKE 'analytics-pg-%'",
        );
        await admin.query(
          "DELETE FROM paperdash_trade_observations WHERE id LIKE 'analytics-pg-%'",
        );
        await admin.query(
          "DELETE FROM paperdash_analytics_fingerprints WHERE instrument=$1",
          [instrument],
        );
        await admin.query(
          "DELETE FROM paperdash_analytics_minutes WHERE instrument=$1",
          [instrument],
        );
        await admin.query(
          "DELETE FROM paperdash_analytics_oi_samples WHERE instrument=$1",
          [instrument],
        );
        await admin.query(
          "DELETE FROM paperdash_analytics_wallet_fingerprints WHERE wallet=$1",
          [address],
        );
        await admin.query(
          "DELETE FROM paperdash_analytics_wallet_minutes WHERE wallet=$1",
          [address],
        );
        const stream = event("stream-1"),
          recent = event("recent-1", { provenance: "recent-api" });
        expect(
          await Promise.all([
            first.recordTrade(stream),
            second.recordTrade(recent),
          ]),
        ).toEqual([true, true]);
        expect(
          (await first.analytics.activity([instrument], now))[0].counts.total,
        ).toBe(1);
        const extra = event("stream-2");
        expect(
          await Promise.all([
            first.recordTrade(extra),
            second.recordTrade(extra),
          ]),
        ).toEqual(expect.arrayContaining([true, false]));
        const activity = (
          await second.analytics.activity([instrument], now)
        )[0];
        expect(activity.counts).toEqual({ total: 2, long: 2, short: 0 });
        expect(activity.notionalUsd.total).toBe(0.25);
        expect(activity.recent).toHaveLength(2);
        expect(
          (await first.analytics.walletActivity("trades", 0, address, now))
            .rows,
        ).toEqual([{ address, count: 2, notionalUsd: 0.25 }]);
        expect(
          (await first.analytics.walletCounts([address], now)).counts,
        ).toEqual({ [address]: 2 });
        const legacy = event("legacy", { side: "short", kind: "close" });
        await admin.query(
          "INSERT INTO paperdash_trade_observations VALUES($1,$2,$3,$4)",
          [legacy.id, JSON.stringify(legacy), legacy.ts, now],
        );
        // Simulate the fresh v2 migration checkpoint; no retained rows are lost.
        await admin.query(
          "UPDATE paperdash_analytics_state SET cursor='',complete=0 WHERE id=2",
        );
        let completed = false;
        for (let i = 0; i < 100 && !completed; i++)
          completed = (await first.analytics.backfill(10)).complete;
        expect(completed).toBe(true);
        expect(
          (await second.analytics.activity([instrument], now))[0],
        ).toMatchObject({
          counts: { total: 3, short: 1 },
          coverage: { projectionBackfillComplete: true },
        });
        expect(await second.analytics.backfill(1)).toEqual({
          processed: 0,
          complete: true,
        });
        expect(
          await second.analytics.walletCounts([address], now),
        ).toMatchObject({
          counts: { [address]: 3 },
          projectionBackfillComplete: true,
        });
        expect((await second.analytics.walletCounts([], now)).counts).toEqual(
          {},
        );
        await first.analytics.sample({
          instrument,
          time: now,
          sourceAt: now,
          sourceBlock: null,
          longRaw: "90071992547409939999999999",
          shortRaw: "0",
          receivedAt: now,
        });
        await second.analytics.sample({
          instrument,
          time: now,
          sourceAt: now - 1,
          sourceBlock: null,
          longRaw: "1",
          shortRaw: "0",
          receivedAt: now + 1,
        });
        expect(
          (await first.analytics.samples(instrument, now - 60000))[0],
        ).toMatchObject({
          longRaw: "90071992547409939999999999",
          sourceAt: now,
          sourceBlock: null,
        });
      } finally {
        await admin.end();
      }
    }, 20000);
  },
);
