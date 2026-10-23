import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
  readPaperEconomics,
  VERIFIED_PROTOCOL_GENESIS,
} from "../src/protocol-charts.js";
import { buildApi } from "../src/api.js";
import { Upstream, RequestGate } from "../src/upstream.js";
import { ChangeBus } from "../src/bus.js";
import { refreshHouse } from "../src/house.js";
import { retainProtocolHistory } from "../src/collector.js";
import { VERIFIED_TRADING_WINDOW } from "../../../packages/shared/src/trading-launch.js";

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
async function memory(value: ProtocolSummary | null = summary()) {
  const store = await createStore({ memory: true, databaseUrl: "" });
  stores.push(store);
  if (value) await store.put("summary", value, now);
  await store.put("collector-heartbeat", { at: now, errors: {} }, now);
  return store;
}

describe("allocation rates since public trading launch", () => {
  it("ties the cutoff and zero baseline to the announcement and archived prelaunch history", () => {
    const evidence = JSON.parse(readFileSync(new URL(
      "../../../docs/evidence/2026-10-16-trading-launch-verification.json", import.meta.url,
    ), "utf8"));
    const bytes = readFileSync(new URL(
      "../../../docs/evidence/2026-10-16-trading-launch-protocol-history.json", import.meta.url,
    ));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      evidence.protocolHistory.temporaryCaptureSha256,
    );
    const history = JSON.parse(bytes.toString());
    const cutoff = VERIFIED_TRADING_WINDOW.fromMs;
    expect(cutoff).toBe(Date.parse(evidence.officialAnnouncement.scheduledTradingStart));
    expect(VERIFIED_TRADING_WINDOW.genesis).toBe(VERIFIED_PROTOCOL_GENESIS);
    expect(cutoff).toBeGreaterThan(VERIFIED_PROTOCOL_GENESIS);
    expect(VERIFIED_TRADING_WINDOW.baselineRewardsRaw).toBe("0");
    const first = (cutoff - history.startMs) / history.intervalMs;
    expect(Number.isInteger(first)).toBe(true);
    expect(history.intervalMs).toBe(HOUR);
    expect(history.source.asOfMs).toBeGreaterThan(cutoff + HOUR);
    for (const column of ["stakingRewards", "volume", "trades", "paperSupply"]) {
      expect(history.columns[column].slice(0, first).every((v: unknown) => v === 0)).toBe(true);
      expect(history.columns[column][first]).toBeGreaterThan(0);
    }
  });
  it("annualizes allocations after the verified baseline using exact days, excluding deployment and deposit days", () => {
    const value = summary(VERIFIED_TRADING_WINDOW.fromMs + DAY);
    value.fees.lifetime = "12345678901234567890123456789";
    const result = annualizedStakingRevenue(value, value.source.at);
    expect(result).toEqual({
      usdPerYearRaw: (BigInt(value.fees.lifetime) * 365n).toString(),
      usdPerDayRaw: value.fees.lifetime,
      lifetimeRewardsRaw: value.fees.lifetime,
      baselineRewardsRaw: "0",
      allocatedSinceStartRaw: value.fees.lifetime,
      fromMs: VERIFIED_TRADING_WINDOW.fromMs,
      toMs: value.source.at,
      basis: "observed-trading-window",
      cutoffBasis: "announced-trading-start",
      yearDays: 365,
    });
    value.fees.lifetime = "0";
    expect(annualizedStakingRevenue(value, value.source.at).usdPerYearRaw).toBe(
      "0",
    );
  });
  it("uses the source clock and preserves partial days without rounding the daily rate first", () => {
    const value = summary(VERIFIED_TRADING_WINDOW.fromMs + DAY + DAY / 2);
    value.fees.lifetime = "1";
    const result = annualizedStakingRevenue(value, value.source.at + HOUR);
    expect(result).toMatchObject({ usdPerDayRaw: "0", usdPerYearRaw: "243", toMs: value.source.at });
    expect(annualizedStakingRevenue(value, value.source.at + 2 * HOUR)).toEqual(result);
  });
  it("never annualizes prelaunch activity, unknown deployments, failed summaries or invalid clocks", () => {
    for (const value of [
      null,
      { ...summary(), source: { block: "1", at: now } },
      { ...summary(), source: { block: "1", at: now, genesis: now - HOUR } },
      { ...summary(), ok: false },
      summary(VERIFIED_PROTOCOL_GENESIS),
      summary(Date.UTC(2026, 9, 8, 14)),
      summary(VERIFIED_TRADING_WINDOW.fromMs - 1),
      summary(VERIFIED_TRADING_WINDOW.fromMs),
      summary(NaN),
      summary(now + 0.5),
      summary(now + 30001),
    ]) {
      const result = annualizedStakingRevenue(value, now);
      expect(result.usdPerYearRaw).toBeNull();
      expect(result.usdPerDayRaw).toBeNull();
      expect(result.allocatedSinceStartRaw).toBeNull();
    }
    for (const invalid of ["-1", "01", "1.5", "1e18", "9".repeat(79)]) {
      const value = summary();
      value.fees.lifetime = invalid;
      expect(annualizedStakingRevenue(value, now).usdPerYearRaw).toBeNull();
    }
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
  it("publishes every live snapshot from the saved summary before hourly retention catches up, without additional reads", async () => {
    const store = await memory(null);
    await retainProtocolChartHistory(store, history(), now);
    await retainProtocolChartSummary(
      store,
      summary(now - 1000, "1500000000000000000000"),
      now,
    );
    const fresh = summary(now, "1600000000000000000000");
    fresh.activity.open = 77;
    fresh.balances.tvl = "250000000000000000000";
    fresh.paper.supply = "301000000000000000000";
    fresh.paper.staked = "151000000000000000000";
    fresh.fees.lifetime = "448000000000000000000";
    await store.put("summary", fresh, now);
    const readRows = vi.spyOn(store.history, "protocolChartRows");
    const reads = vi.spyOn(store, "get");
    await refreshProtocolCharts(store, now);
    expect(readRows.mock.calls).toEqual([["history"], ["summary"]]);
    expect(reads.mock.calls).toEqual([["summary"], ["onchain-paper"], ["staking-reward-history"], ["staking-reward-history-days"]]);
    const data = await readProtocolCharts(store, now);
    expect(data.sourceAt).toBe(now);
    for (const [metric, value] of Object.entries({
      tvl: 250,
      volume: 410,
      openPositions: 77,
      paperSupply: 301,
      paperStaked: 151,
      stakingRewards: 448,
    })) {
      expect(
        data.series[metric as keyof typeof data.series].points.at(-1),
      ).toMatchObject({ value, partial: true });
    }
    const economics = await readPaperEconomics(store, now);
    expect(economics.series.supply.points.at(-1)?.value).toBe(301);
    // Accurate snapshots do not grant permission to join economic-delta
    // endpoints from the summary and history generation namespaces.
    expect(economics.series.supplyChange.points.at(-1)).toMatchObject({
      value: null,
      gapBefore: true,
    });
  });

  it("prefers exact current-summary counters at a matching history timestamp without losing small raw changes", async () => {
    const store = await memory(null);
    const base = 9007199254740993000000000000000000n;
    await store.history.retainProtocolCharts("history", [
      {
        time: hour - HOUR,
        endpointAt: hour - 1,
        sourceAt: now,
        generation: "a",
        complete: true,
        values: { volume: Number(base) / 1e18 },
        volumeRaw: base.toString(),
      },
      {
        time: hour,
        endpointAt: now,
        sourceAt: now,
        generation: "a",
        complete: false,
        values: { volume: Number(base + 10n ** 18n) / 1e18 },
      },
    ]);
    await store.put(
      "summary",
      summary(now, (base + 10n ** 18n).toString()),
      now,
    );
    await refreshProtocolCharts(store, now);
    expect(
      (await readProtocolCharts(store, now)).series.volume.points.at(-1),
    ).toMatchObject({ value: 1, partial: true });
    expect(await store.history.protocolChartRows("summary")).toEqual([]);
  });

  it("keeps daily source-boundary precision explicit instead of forcing approximate observed days to equal lifetime totals", async () => {
    const store = await memory(null);
    const today = Math.floor(now / DAY) * DAY;
    const start = today - DAY - HOUR;
    await store.history.retainProtocolCharts(
      "history",
      Array.from({ length: 25 }, (_, i) => {
        const time = start + i * HOUR;
        return {
          time,
          endpointAt: time + HOUR - 1,
          sourceAt: now,
          generation: "history-a",
          complete: true,
          values: {
            paperSupply: i === 0 ? 0 : 100.03,
            stakingRewards: i === 0 ? 0 : 100.03,
          },
        };
      }),
    );
    await store.history.retainProtocolCharts(
      "summary",
      Array.from({ length: (hour - today) / HOUR + 2 }, (_, i) => {
        const time = today - HOUR + i * HOUR;
        return {
          time,
          endpointAt: Math.min(time + HOUR - 2000, now - 1000),
          sourceAt: now,
          generation: `genesis:${VERIFIED_PROTOCOL_GENESIS}`,
          complete: false,
          values: { paperSupply: 100, stakingRewards: 100 },
          paperSupplyRaw: "100000000000000000000",
          allocatedRewardsRaw: "100000000000000000000",
        };
      }),
    );
    const fresh = summary(now);
    fresh.paper.supply = "105000000000000000000";
    fresh.fees.lifetime = "105000000000000000000";
    await store.put("summary", fresh, now);
    await refreshProtocolCharts(store, now);
    const data = await readPaperEconomics(store, now);
    const days = data.daily!.rewardAllocation.points;
    expect(days.at(-2)).toMatchObject({
      value: 100.03,
      observedToMs: today - 1,
    });
    expect(days.at(-1)).toMatchObject({
      value: 5,
      valueRaw: "5000000000000000000",
      partial: true,
      observedFromMs: today - 2000,
      observedToMs: now,
    });
    expect(days.at(-2)!.value! + days.at(-1)!.value!).toBeCloseTo(105.03, 8);
    expect(data.allocatedRewardsRaw).toBe("105000000000000000000");
  });

  it("repairs a generation-split launch day from coherent hourly source history without inventing a baseline", async () => {
    const day = Date.UTC(2026, 9, 10);
    const asOf = Date.UTC(2026, 9, 14, 3, 30);
    vi.spyOn(Date, "now").mockReturnValue(asOf);
    const store = await createStore({ memory: true, databaseUrl: "" });
    stores.push(store);
    const supply = 5049945675.721906,
      rewards = 23974675.45572573;
    const start = day - DAY - HOUR;
    const rows = Array.from(
      { length: Math.floor((asOf - start) / HOUR) + 1 },
      (_, i) => {
        const time = start + i * HOUR;
        const progress = Math.max(
          0,
          Math.min(1, (time - day - 13 * HOUR) / (10 * HOUR)),
        );
        return {
          time,
          endpointAt: Math.min(time + HOUR - 1, asOf - 1),
          sourceAt: asOf - 1,
          generation: time < day + 19 * HOUR ? "deployment:0" : "deployment:34",
          complete: time + HOUR <= asOf,
          values: {
            tvl: 1,
            paperSupply: supply * progress,
            stakingRewards: rewards * progress,
          },
        };
      },
    );
    await store.history.retainProtocolCharts("history", rows);
    await store.put("collector-heartbeat", { at: asOf, errors: {} }, asOf);
    await refreshProtocolCharts(store, asOf);
    let data = await readPaperEconomics(store, asOf);
    expect(
      data.daily!.supplyChange.points.find((point) => point.time === day),
    ).toMatchObject({ value: null, gapBefore: true });
    expect(
      data.daily!.rewardAllocation.points.find((point) => point.time === day),
    ).toMatchObject({ value: null, gapBefore: true });

    // This is a fresh coherent response, not a change that joins the two old
    // generations or assigns the difference from lifetime totals to this day.
    const coherent = {
      startMs: start,
      intervalMs: HOUR,
      source: { asOfMs: asOf, generation: "deployment:34", revision: "1" },
      columns: {
        tvl: rows.map((row) => row.values.tvl),
        paperSupply: rows.map((row) => row.values.paperSupply),
        stakingRewards: rows.map((row) => row.values.stakingRewards),
      },
    };
    await retainProtocolHistory(store, coherent);
    await refreshProtocolCharts(store, asOf);
    data = await readPaperEconomics(store, asOf);
    expect(
      data.daily!.supplyChange.points.find((point) => point.time === day),
    ).toEqual({
      time: day,
      value: supply,
      observedFromMs: day - 1,
      observedToMs: day + DAY - 1,
    });
    expect(
      data.daily!.rewardAllocation.points.find((point) => point.time === day),
    ).toEqual({
      time: day,
      value: rewards,
      observedFromMs: day - 1,
      observedToMs: day + DAY - 1,
    });
    // Missing the actual preceding midnight still cannot manufacture zero.
    await store.history.retainProtocolCharts("history", [
      {
        ...rows.find((row) => row.time === day - HOUR)!,
        sourceAt: asOf + 1,
        generation: "deployment:34",
        values: { paperSupply: null, stakingRewards: null },
      },
    ]);
    await refreshProtocolCharts(store, asOf + 1);
    expect(
      (
        await readPaperEconomics(store, asOf + 1)
      ).daily!.supplyChange.points.find((point) => point.time === day),
    ).toMatchObject({ value: null, gapBefore: true });
  });
  it("uses the last snapshot in each hour and differences cumulative volume, never trades for open count", async () => {
    const store = await memory(null);
    await retainProtocolChartHistory(store, history(), now);
    await refreshProtocolCharts(store, now);
    const data = await readProtocolCharts(store, now);
    // History alone never claims a fresh summary clock or an open-position count.
    expect(data.stale).toBe(true);
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
    await store.put("summary", live, now);
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
    const store = await memory(null);
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
    await store.put("summary", summary(now, String(base + 10n ** 18n)), now);
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
    const store = await memory(summary(now, "600000000000000000000"));
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
    const store = await memory(null);
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
