import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  ProtocolSummary,
  ProtocolChartsResponse,
} from "../../../packages/shared/src/types.js";
import { createStore, type Store } from "../src/store.js";
import {
  annualizedStakingRevenue,
  retainProtocolChartHistory,
  retainProtocolChartSummary,
  refreshProtocolCharts,
  readProtocolCharts,
  VERIFIED_PROTOCOL_GENESIS,
} from "../src/protocol-charts.js";
import { buildApi } from "../src/api.js";
import { Upstream, RequestGate } from "../src/upstream.js";
import { ChangeBus } from "../src/bus.js";
import { refreshHouse } from "../src/house.js";

const HOUR = 3600000,
  DAY = 86400000;
const hour = Math.floor((VERIFIED_PROTOCOL_GENESIS + 4 * DAY) / HOUR) * HOUR;
const now = hour + HOUR / 2;
const stores: Store[] = [],
  apps: FastifyInstance[] = [],
  upstreams: Upstream[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const upstream of upstreams.splice(0)) await upstream.close();
  for (const store of stores.splice(0)) await store.close();
  vi.restoreAllMocks();
});
function summary(at = now, volume = "1000000000000000000000"): ProtocolSummary {
  return {
    ok: true,
    source: { at, block: String(at), genesis: VERIFIED_PROTOCOL_GENESIS },
    balances: {
      tvl: "123000000000000000000",
      margin: "0",
      lp: "1",
      reserve: "0",
      queue: "0",
    },
    activity: { volume, open: 42 },
    fees: { pending: "99", lifetime: "100000000000000000000" },
    paper: { supply: "900000000000000000000", staked: "700000000000000000000" },
  };
}
function history() {
  return {
    startMs: hour - 2 * HOUR,
    intervalMs: 60000,
    source: { asOfMs: now, generation: "a", revision: "1" },
    columns: {
      tvl: Array.from({ length: 150 }, (_, i) => 100 + i),
      volume: Array.from({ length: 150 }, (_, i) => i * 10),
      paperSupply: Array.from({ length: 150 }, (_, i) => i * 2),
      paperStaked: Array.from({ length: 150 }, (_, i) => i),
      stakingRewards: Array.from({ length: 150 }, (_, i) => i * 3),
      trades: Array.from({ length: 150 }, () => 99999),
    },
  };
}
async function memory() {
  const store = await createStore({ memory: true, databaseUrl: "" });
  stores.push(store);
  await store.put("summary", summary(), now);
  await store.put("collector-heartbeat", { at: now, errors: {} }, now);
  return store;
}

describe("protocol lifetime annualized staking revenue", () => {
  it("annualizes all lifetime allocated USDC with exact raw arithmetic and a 365-day year", () => {
    const value = summary(VERIFIED_PROTOCOL_GENESIS + DAY);
    value.fees.lifetime = "12345678901234567890123456789";
    const result = annualizedStakingRevenue(value, value.source.at);
    expect(result).toEqual({
      usdPerYearRaw: (BigInt(value.fees.lifetime) * 365n).toString(),
      lifetimeRewardsRaw: value.fees.lifetime,
      fromMs: VERIFIED_PROTOCOL_GENESIS,
      toMs: value.source.at,
      basis: "protocol-lifetime",
      yearDays: 365,
    });
    value.fees.lifetime = "0";
    expect(annualizedStakingRevenue(value, value.source.at).usdPerYearRaw).toBe(
      "0",
    );
  });
  it("never substitutes first observation time or an unverified/invalid lifetime", () => {
    for (const value of [
      null,
      { ...summary(), source: { block: "1", at: now } },
      { ...summary(), source: { block: "1", at: now, genesis: now - HOUR } },
      summary(VERIFIED_PROTOCOL_GENESIS),
      summary(now + 30001),
    ])
      expect(annualizedStakingRevenue(value, now).usdPerYearRaw).toBeNull();
  });
  it("is included in the worker-saved house payload without pending reward inflation", async () => {
    const store = await memory();
    await refreshHouse(store, now);
    const saved = await store.get<{
      annualizedStakingRevenue: ReturnType<typeof annualizedStakingRevenue>;
    }>("house");
    expect(saved?.value.annualizedStakingRevenue).toEqual(
      annualizedStakingRevenue(summary(), now),
    );
    expect(saved?.value.annualizedStakingRevenue.lifetimeRewardsRaw).toBe(
      summary().fees.lifetime,
    );
  });
});

describe("retained hourly protocol charts", () => {
  it("uses the last snapshot in each hour and differences cumulative volume, never trades for open count", async () => {
    const store = await memory();
    await retainProtocolChartHistory(store, history(), now);
    await refreshProtocolCharts(store, now);
    const data = await readProtocolCharts(store, now);
    expect(data.stale).toBe(false);
    expect(data.series.tvl.points.map((p) => p.value)).toEqual([159, 219, 249]);
    expect(data.series.volume.points.map((p) => p.value)).toEqual([
      null,
      600,
      300,
    ]);
    expect(data.series.volume.points[1].partial).toBeUndefined();
    expect(data.series.volume.points[2].partial).toBe(true);
    expect(data.series.openPositions.points).toEqual([]);
    expect(data.series.paperSupply.points.map((p) => p.value)).toEqual([
      118, 238, 298,
    ]);
    expect(data.series.stakingRewards.aggregation).toBe("cumulative");
  });
  it("updates live endpoints from summary and refuses source regressions or future observations", async () => {
    const store = await memory();
    await retainProtocolChartHistory(store, history(), now);
    const live = summary(now, "1600000000000000000000");
    await retainProtocolChartSummary(store, live, now);
    await retainProtocolChartSummary(
      store,
      { ...summary(now - 1000), activity: { volume: "1", open: 1 } },
      now,
    );
    await refreshProtocolCharts(store, now);
    let data = await readProtocolCharts(store, now);
    expect(data.series.openPositions.points).toEqual([
      { time: hour, value: 42, partial: true },
    ]);
    expect(data.series.volume.points.at(-1)).toMatchObject({
      value: 410,
      partial: true,
    });
    await expect(
      retainProtocolChartSummary(store, summary(now + 30001), now),
    ).rejects.toThrow();
    const older = history();
    older.source.asOfMs -= 1000;
    older.columns.tvl[59] = 1;
    await retainProtocolChartHistory(store, older, now);
    await refreshProtocolCharts(store, now);
    data = await readProtocolCharts(store, now);
    expect(data.series.tvl.points[0].value).toBe(159);
  });
  it("preserves supplied raw precision with a complete baseline and leaves missing hours unjoined", async () => {
    const store = await memory();
    const base = 9007199254740993000000000000000000n;
    await store.history.retainProtocolCharts("history", [
      {
        time: hour - HOUR,
        endpointAt: hour - 1,
        sourceAt: now,
        generation: "a",
        complete: true,
        values: { volume: Number(base) / 1e18 },
        volumeRaw: String(base),
      },
    ]);
    await retainProtocolChartSummary(
      store,
      summary(now, String(base + 10n ** 18n)),
      now,
    );
    await refreshProtocolCharts(store, now);
    expect(
      (await readProtocolCharts(store, now)).series.volume.points.at(-1),
    ).toMatchObject({ value: 1, partial: true });
    await retainProtocolChartSummary(
      store,
      summary(now + 2 * HOUR, String(base + 3n * 10n ** 18n)),
      now + 2 * HOUR,
    );
    await refreshProtocolCharts(store, now + 2 * HOUR);
    const data = await readProtocolCharts(store, now + 2 * HOUR);
    expect(data.series.volume.points.at(-1)).toMatchObject({
      value: null,
      gapBefore: true,
    });
    expect(data.series.openPositions.points.at(-1)?.gapBefore).toBe(true);
  });

  it("does not assign a multi-hour difference to one bar after an early prior-hour observation", async () => {
    const store = await memory();
    await retainProtocolChartSummary(
      store,
      summary(hour - HOUR + 10 * 60000, "100000000000000000000"),
      now,
    );
    await retainProtocolChartSummary(
      store,
      summary(now, "600000000000000000000"),
      now,
    );
    await refreshProtocolCharts(store, now);
    expect(
      (await readProtocolCharts(store, now)).series.volume.points.at(-1)?.value,
    ).toBeNull();
    const h = history();
    h.columns.volume[119] = 400;
    h.columns.volume[149] = 600;
    await retainProtocolChartHistory(store, h, now);
    await refreshProtocolCharts(store, now);
    expect(
      (await readProtocolCharts(store, now)).series.volume.points.at(-1),
    ).toMatchObject({ value: 200, partial: true });
  });
  it("does not bridge nulls, cumulative counter decreases or generation changes", async () => {
    const store = await memory();
    const h = history();
    h.columns.volume[119] = -1;
    await retainProtocolChartHistory(store, h, now);
    await refreshProtocolCharts(store, now);
    expect(
      (await readProtocolCharts(store, now)).series.volume.points.map(
        (p) => p.value,
      ),
    ).toEqual([null, null, null]);
    const changed = history();
    changed.startMs = hour;
    changed.source.generation = "new";
    changed.source.asOfMs += 1;
    changed.columns = Object.fromEntries(
      Object.entries(changed.columns).map(([key, values]) => [
        key,
        values.slice(120),
      ]),
    ) as typeof changed.columns;
    await retainProtocolChartHistory(store, changed, now + 1);
    await refreshProtocolCharts(store, now + 1);
    expect(
      (await readProtocolCharts(store, now + 1)).series.volume.points.at(-1),
    ).toMatchObject({ value: null, gapBefore: true });
  });
  it("caps the payload at169 points while retaining a prior endpoint for the first volume bar", async () => {
    const store = await memory();
    await store.history.retainProtocolCharts(
      "history",
      Array.from({ length: 170 }, (_, i) => ({
        time: hour - (169 - i) * HOUR,
        endpointAt: hour - (169 - i) * HOUR + HOUR - 1,
        sourceAt: now + HOUR,
        generation: "a",
        complete: true,
        values: { volume: i * 100, tvl: i },
      })),
    );
    await refreshProtocolCharts(store, now);
    const data = await readProtocolCharts(store, now);
    expect(data.series.volume.points).toHaveLength(169);
    expect(data.series.volume.points[0].value).toBe(100);
    expect(data.series.tvl.points).toHaveLength(169);
  });
  it("serves only saved data at the public endpoint and reports stale collection", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = await memory();
    await retainProtocolChartSummary(store, summary(), now);
    await refreshProtocolCharts(store, now);
    const fetcher = vi.fn(async () => {
      throw new Error("No upstream call allowed");
    });
    const upstream = new Upstream(
      store,
      fetcher as typeof fetch,
      "https://papertrade.test",
      new RequestGate(1, 0),
    );
    upstreams.push(upstream);
    const app = await buildApi(store, upstream, new ChangeBus(), {
      logger: false,
      readCacheMs: 0,
    });
    apps.push(app);
    const response = await app.inject("/api/protocol/charts");
    expect(response.statusCode).toBe(200);
    expect(
      response.json<ProtocolChartsResponse>().series.openPositions.points[0]
        .value,
    ).toBe(42);
    expect(fetcher).not.toHaveBeenCalled();
    await store.put("collector-heartbeat", {
      at: now,
      errors: { history: "Source history delayed" },
    });
    expect((await readProtocolCharts(store, now)).stale).toBe(true);
    expect((await readProtocolCharts(store, now - 30001)).stale).toBe(true);
  });
});
