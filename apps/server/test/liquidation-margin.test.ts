import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { TradeEvent } from "../../../packages/shared/src/types.js";
import {
  createLocalLiquidations,
  migrateLocalLiquidations,
  projectLiquidationSqlite,
} from "../src/liquidations-store.js";

const now = 1800000012345;
const event = (id: string, fields: Partial<TradeEvent> = {}): TradeEvent => ({
  id,
  ts: now - 100000,
  wallet: `0x${"a".repeat(40)}`,
  instrument: 0,
  side: "long",
  leverage: 1000,
  notionalUsd: 10000,
  kind: "liq",
  pnlUsd: -10,
  provenance: "public-stream",
  ...fields,
});
function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE trade_observations(id TEXT PRIMARY KEY,payload TEXT NOT NULL)",
  );
  migrateLocalLiquidations(db);
  const store = createLocalLiquidations(db, async () => {});
  const insert = (value: TradeEvent) => {
    db.exec("BEGIN");
    try {
      db.prepare("INSERT INTO trade_observations VALUES(?,?)").run(
        value.id,
        JSON.stringify(value),
      );
      projectLiquidationSqlite(db, value);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  return { db, store, insert };
}
describe("liquidated initial margin", () => {
  it("upgrades an old projection without historical rewrites, fills source multiplicity once, and resumes the independent checkpoint", async () => {
    const { db, store, insert } = setup();
    try {
      insert(event("s1"));
      insert(event("s2"));
      insert(event("r1", { provenance: "recent-api" }));
      insert(event("eth", { instrument: 1, notionalUsd: 120, leverage: 3 }));
      db.exec(`ALTER TABLE liquidation_fingerprints DROP COLUMN estimated_margin;
        ALTER TABLE liquidation_minutes DROP COLUMN estimated_margin;
        ALTER TABLE liquidation_minutes DROP COLUMN margin_observation_count;
        DELETE FROM liquidation_state WHERE id=2;
        UPDATE liquidation_state SET complete=1 WHERE id=1;`);
      migrateLocalLiquidations(db);
      migrateLocalLiquidations(db);
      expect((await store.stats(undefined, now)).day).toMatchObject({
        count: 3,
        estimatedMarginUsd: null,
        marginObservationCount: 0,
      });
      // A live source counterpart fills all existing effective occurrences, not just itself.
      insert(event("r2", { provenance: "recent-api", priceUsd: 82000 }));
      expect((await store.stats(0, now)).day).toMatchObject({
        count: 2,
        estimatedMarginUsd: 20,
        marginObservationCount: 2,
      });
      insert(event("r3", { provenance: "recent-api" }));
      expect((await store.stats(0, now)).day).toMatchObject({
        count: 3,
        estimatedMarginUsd: 30,
        marginObservationCount: 3,
      });
      expect(await store.backfill(1)).toEqual({
        processed: 1,
        complete: false,
      });
      const restarted = createLocalLiquidations(db, async () => {});
      for (let i = 0; i < 4; i++)
        if ((await restarted.backfill(1)).complete) break;
      expect((await restarted.stats(undefined, now)).day).toMatchObject({
        count: 4,
        estimatedMarginUsd: 70,
        marginObservationCount: 4,
      });
      expect(await restarted.backfill(10)).toEqual({
        processed: 0,
        complete: true,
      });
      insert(event("s3", { priceUsd: 82100 }));
      expect(
        (await restarted.stats(undefined, now)).day.estimatedMarginUsd,
      ).toBe(70);
    } finally {
      db.close();
    }
  });
  it("uses exact rolling boundaries, supports billion-dollar notional, and returns null instead of a partial estimate", async () => {
    const { db, store, insert } = setup();
    try {
      expect((await store.stats(undefined, now)).day).toMatchObject({
        estimatedMarginUsd: 0,
        marginObservationCount: 0,
      });
      insert(event("outside", { ts: now - 86400001 }));
      insert(event("left", { ts: now - 86400000, notionalUsd: 10000000000 }));
      insert(
        event("now", { ts: now, instrument: 1, notionalUsd: 1, leverage: 4 }),
      );
      insert(event("future", { ts: now + 1 }));
      expect((await store.stats(undefined, now)).day).toMatchObject({
        count: 2,
        estimatedMarginUsd: 10000000.25,
        marginObservationCount: 2,
      });
      expect((await store.stats(undefined, now)).hour.estimatedMarginUsd).toBe(
        0.25,
      );
      insert(event("invalid-derivation", { leverage: Number.MIN_VALUE }));
      const invalid = (await store.stats(undefined, now)).day;
      expect(invalid).toMatchObject({
        count: 3,
        estimatedMarginUsd: null,
        marginObservationCount: 2,
      });
      // An incomplete BTC observation must not make ETH's complete cohort unavailable.
      expect((await store.stats(1, now)).day.estimatedMarginUsd).toBe(0.25);
    } finally {
      db.close();
    }
  });
});
