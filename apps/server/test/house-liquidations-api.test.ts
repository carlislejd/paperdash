import { afterEach, describe, expect, it } from "vitest";
import { createStore, type Store } from "../src/store.js";
import { buildApi } from "../src/api.js";
import { retainHouseSource, refreshHouse } from "../src/house.js";
import { refreshLiquidations } from "../src/liquidations.js";

const stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});
describe("house and liquidation public route contracts", () => {
  it("returns source metadata and validates liquidation cursor/filter parameters", async () => {
    const store = await createStore({ memory: true, databaseUrl: "" });
    stores.push(store);
    const now = Date.now();
    await store.put("collector-heartbeat", { at: now, errors: {} }, now);
    await store.put("overview", { status: { stream: "connected" } }, now);
    await store.put(
      "summary",
      {
        source: { at: now, block: "123" },
        balances: {
          tvl: "1",
          lp: "9999",
          margin: "0",
          reserve: "0",
          queue: "0",
        },
        activity: { volume: "0", open: 0 },
        fees: { lifetime: "123456789012345678901234", pending: "0" },
        paper: { supply: "1", staked: "1", pendingRewards: "0" },
      },
      now,
    );
    await retainHouseSource(
      store,
      {
        ok: true,
        historyGeneration: "g",
        historyRevision: "r",
        sourceAsOfMs: now,
        head: [now, 100, 120, 5, 0, 0, 0, 0],
      },
      now,
    );
    await refreshHouse(store, now);
    await store.recordTrade({
      id: "liq-fixture",
      ts: now - 1000,
      wallet: `0x${"a".repeat(40)}`,
      instrument: 1,
      side: "short",
      leverage: 1000,
      notionalUsd: 10000000000,
      kind: "liq",
      pnlUsd: -10000000,
      provenance: "public-stream",
      priceUsd: 2500,
    });
    await refreshLiquidations(store, now);
    const app = await buildApi(store, undefined, undefined, { logger: false });
    try {
      const house = await app.inject("/api/house");
      expect(house.statusCode).toBe(200);
      expect(house.json()).toMatchObject({
        house: { fundsRaw: "-25000000000000000000" },
        paper: { stakerRewardsRaw: "123456789012345678901234" },
        sourceAt: now,
        summarySourceAt: now,
        sourceBlock: "123",
        stale: false,
        houseStale: false,
        change: null,
        history: [
          {
            time: now,
            fundsRaw: "-25000000000000000000",
            lpRaw: "100000000000000000000",
            openPnlRaw: "-120000000000000000000",
            queueDebtRaw: "5000000000000000000",
          },
        ],
        coverage: { partial: true, approximate: true },
      });
      const liquidation = await app.inject("/api/liquidations?instrument=1");
      expect(liquidation.statusCode).toBe(200);
      expect(liquidation.json()).toMatchObject({
        stats: { day: { count: 1, shortCount: 1, notionalUsd: 10000000000 } },
        stale: false,
        coverage: { partial: true, identityAmbiguous: true },
      });
      expect(liquidation.json().items[0]).toMatchObject({
        instrument: 1,
        kind: "liq",
        leverage: 1000,
        priceUsd: 2500,
      });
      expect(
        (await app.inject("/api/liquidations?instrument=0")).json().items,
      ).toEqual([]);
      for (const query of [
        "instrument=BTC",
        "instrument=-1",
        "instrument=2",
        "cursor=broken",
      ])
        expect(
          (await app.inject(`/api/liquidations?${query}`)).statusCode,
        ).toBe(400);
    } finally {
      await app.close();
    }
  });
});
