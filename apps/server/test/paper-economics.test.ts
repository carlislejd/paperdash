import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  PaperEconomicsResponse,
  ProtocolSummary,
} from "../../../packages/shared/src/types.js";
import { buildApi } from "../src/api.js";
import { createStore, type Store } from "../src/store.js";
import { Upstream } from "../src/upstream.js";
import { VERIFIED_TRADING_WINDOW } from "../../../packages/shared/src/trading-launch.js";
import type { ProtocolChartObservation } from "../src/history-store.js";
import {
  readPaperEconomics,
  refreshProtocolCharts,
  retainProtocolChartSummary,
  VERIFIED_PROTOCOL_GENESIS,
} from "../src/protocol-charts.js";

const HOUR = 3600000;
const hour =
  Math.floor((VERIFIED_PROTOCOL_GENESIS + 10 * 86400000) / HOUR) * HOUR;
const now = hour + HOUR / 2;
const stores: Store[] = [];
const apps: FastifyInstance[] = [];
const upstreams: Upstream[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const upstream of upstreams.splice(0)) await upstream.close();
  for (const store of stores.splice(0)) await store.close();
  vi.restoreAllMocks();
});
function summary(): ProtocolSummary {
  return {
    ok: true,
    source: { at: now, block: "12345", genesis: VERIFIED_PROTOCOL_GENESIS },
    balances: { tvl: "1", margin: "0", lp: "1", reserve: "0", queue: "0" },
    activity: { volume: "1", open: 0 },
    fees: { pending: "999", lifetime: "123456789012345678901234567890" },
    paper: {
      supply: "9007199254740993000000000000000000",
      staked: "3002399751580331000000000000000000",
      pendingRewards: "876543210987654321",
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
function row(
  offset: number,
  values: ProtocolChartObservation["values"],
  overrides: Partial<ProtocolChartObservation> = {},
): ProtocolChartObservation {
  const time = hour + offset * HOUR;
  return {
    time,
    endpointAt: Math.min(time + HOUR - 1, now),
    sourceAt: now,
    generation: "history-a",
    complete: offset < 0,
    values,
    ...overrides,
  };
}

describe("saved PAPER economics", () => {
  it("keeps exact summary totals and same-snapshot stake ratio without adding history reads", async () => {
    const source = summary();
    const store = await memory(source);
    const reads = vi.spyOn(store.history, "protocolChartRows");
    const get = vi.spyOn(store, "get");
    await refreshProtocolCharts(store, now);
    expect(reads.mock.calls).toEqual([["history"], ["summary"]]);
    expect(get.mock.calls).toEqual([["summary"], ["paper-price"]]);
    const data = await readPaperEconomics(store, now);
    expect(data).toMatchObject({
      sourceAt: now,
      receivedAt: now,
      stale: false,
      supplyRaw: source.paper.supply,
      stakedRaw: source.paper.staked,
      allocatedRewardsRaw: source.fees.lifetime,
      pendingRewardsRaw: source.paper.pendingRewards,
      stakeRatioBps: 3333,
      coverage: { partial: true, historyApproximate: true },
      annualized: {
        lifetimeRewardsRaw: source.fees.lifetime,
        baselineRewardsRaw: "0",
        allocatedSinceStartRaw: source.fees.lifetime,
        fromMs: VERIFIED_TRADING_WINDOW.fromMs,
        basis: "observed-trading-window",
        cutoffBasis: "announced-trading-start",
      },
    });
    expect(data.annualized.usdPerYearRaw).toBe(
      (
        (BigInt(source.fees.lifetime) * BigInt(365 * 86400000)) /
        BigInt(now - VERIFIED_TRADING_WINDOW.fromMs)
      ).toString(),
    );
    expect(data.annualized.usdPerDayRaw).toBe(
      ((BigInt(source.fees.lifetime) * 86400000n) / BigInt(now - VERIFIED_TRADING_WINDOW.fromMs)).toString(),
    );
    expect(data).not.toHaveProperty("distributedRaw");
    expect(data).not.toHaveProperty("claimedRaw");
  });

  it("distinguishes zero, unavailable pending, empty supply and invalid stake ratios", async () => {
    const source = summary();
    source.paper = { supply: "10", staked: "0" };
    source.fees.lifetime = "0";
    const store = await memory(source);
    await refreshProtocolCharts(store, now);
    expect(await readPaperEconomics(store, now)).toMatchObject({
      stakeRatioBps: 0,
      pendingRewardsRaw: null,
      allocatedRewardsRaw: "0",
      annualized: { usdPerYearRaw: "0" },
    });
    for (const [supply, staked] of [
      ["0", "0"],
      ["10", "11"],
    ]) {
      await store.put("summary", { ...source, paper: { supply, staked } }, now);
      await refreshProtocolCharts(store, now);
      expect((await readPaperEconomics(store, now)).stakeRatioBps).toBeNull();
    }
  });

  it("retains exact new summary observations and rejects malformed optional raw metadata", async () => {
    const store = await memory();
    const source = summary();
    await retainProtocolChartSummary(store, source, now);
    expect((await store.history.protocolChartRows("summary"))[0]).toMatchObject(
      {
        paperSupplyRaw: source.paper.supply,
        paperStakedRaw: source.paper.staked,
        allocatedRewardsRaw: source.fees.lifetime,
      },
    );
    for (const raw of ["-1", "01", "1.5", "1e18", "9".repeat(79)])
      await expect(
        store.history.retainProtocolCharts("history", [
          row(-1, { paperSupply: 1 }, { paperSupplyRaw: raw }),
        ]),
      ).rejects.toThrow("Invalid protocol chart observation");
  });

  it("subtracts available raw endpoints before converting approximate chart output", async () => {
    const store = await memory(null);
    const base = 9007199254740993000000000000000000n;
    await store.history.retainProtocolCharts("history", [
      row(
        -1,
        {
          paperSupply: Number(base) / 1e18,
          stakingRewards: Number(base) / 1e18,
        },
        {
          paperSupplyRaw: String(base),
          allocatedRewardsRaw: String(base),
        },
      ),
      row(
        0,
        {
          paperSupply: Number(base + 10n ** 18n) / 1e18,
          stakingRewards: Number(base + 1n) / 1e18,
        },
        {
          paperSupplyRaw: String(base + 10n ** 18n),
          allocatedRewardsRaw: String(base + 1n),
        },
      ),
    ]);
    await refreshProtocolCharts(store, now);
    const data = await readPaperEconomics(store, now);
    expect(data.series.supplyChange.points.at(-1)?.value).toBe(1);
    expect(data.series.rewardAllocation.points.at(-1)?.value).toBe(1e-18);
  });

  it("shows signed net supply change and allocated-reward deltas with partial current hours", async () => {
    const store = await memory(null);
    await store.history.retainProtocolCharts("history", [
      row(-2, { paperSupply: 100, paperStaked: 50, stakingRewards: 10 }),
      row(-1, { paperSupply: 90, paperStaked: 40, stakingRewards: 16 }),
      row(0, { paperSupply: 110, paperStaked: 60, stakingRewards: 17 }),
    ]);
    await refreshProtocolCharts(store, now);
    const { series } = await readPaperEconomics(store, now);
    expect(series.supplyChange.points.map((point) => point.value)).toEqual([
      null,
      -10,
      20,
    ]);
    expect(series.rewardAllocation.points.map((point) => point.value)).toEqual([
      null,
      6,
      1,
    ]);
    expect(series.supply.points.map((point) => point.value)).toEqual([
      100, 90, 110,
    ]);
    expect(series.staked.points.map((point) => point.value)).toEqual([
      50, 40, 60,
    ]);
    expect(series.allocated.points.map((point) => point.value)).toEqual([
      10, 16, 17,
    ]);
    expect(series.allocated.aggregation).toBe("cumulative");
    expect(series.supplyChange).toMatchObject({
      unit: "PAPER",
      aggregation: "hourly-change",
    });
    expect(series.rewardAllocation).toMatchObject({
      unit: "USD",
      aggregation: "hourly-change",
    });
    expect(series.rewardAllocation.points.at(-1)).toMatchObject({
      partial: true,
    });
    expect(series.supplyChange.coverage.observedFrom).toBe(hour - HOUR);
  });

  it("does not bridge missing hours, generation changes, null endpoints or partial prior hours", async () => {
    const store = await memory(null);
    await store.history.retainProtocolCharts("history", [
      row(-8, { paperSupply: 10, stakingRewards: 10 }),
      row(-6, { paperSupply: 20, stakingRewards: 20 }),
      row(
        -5,
        { paperSupply: 30, stakingRewards: 30 },
        { generation: "history-b" },
      ),
      row(
        -4,
        { paperSupply: null, stakingRewards: null },
        { generation: "history-b" },
      ),
      row(
        -3,
        { paperSupply: 50, stakingRewards: 50 },
        { generation: "history-b", complete: false },
      ),
      row(
        -2,
        { paperSupply: 60, stakingRewards: 60 },
        { generation: "history-b" },
      ),
    ]);
    await refreshProtocolCharts(store, now);
    const { series } = await readPaperEconomics(store, now);
    for (const data of [series.supplyChange, series.rewardAllocation]) {
      expect(data.points.map((point) => point.value)).toEqual([
        null,
        null,
        null,
        null,
        null,
        null,
      ]);
      expect(data.points[1].gapBefore).toBe(true);
      expect(data.points[2].gapBefore).toBe(true);
      expect(data.points.at(-1)?.partial).toBe(true);
    }
  });

  it("does not interpret a reward reset as negative revenue or join summary/history generations", async () => {
    const store = await memory();
    await store.history.retainProtocolCharts("history", [
      row(-2, { paperSupply: 10, stakingRewards: 10 }),
      row(-1, { paperSupply: 12, stakingRewards: 1 }),
    ]);
    await retainProtocolChartSummary(store, summary(), now);
    await refreshProtocolCharts(store, now);
    const data = await readPaperEconomics(store, now);
    expect(data.series.rewardAllocation.points[1]).toMatchObject({
      value: null,
      gapBefore: true,
    });
    for (const series of [
      data.series.supplyChange,
      data.series.rewardAllocation,
    ])
      expect(series.points.at(-1)).toMatchObject({
        value: null,
        gapBefore: true,
        partial: true,
      });
    // The latest available stock stays visible even when its delta is unprovable.
    expect(data.series.supply.points.at(-1)?.value).toBe(
      Number(BigInt(summary().paper.supply)) / 1e18,
    );
  });

  it("applies history corrections idempotently and bounds each series to169 hourly points", async () => {
    const store = await memory(null);
    await store.history.retainProtocolCharts(
      "history",
      Array.from({ length: 170 }, (_, index) =>
        row(index - 169, {
          paperSupply: 1000 + index,
          paperStaked: 500 + index,
          stakingRewards: 100 + index,
        }),
      ),
    );
    await refreshProtocolCharts(store, now);
    const original = await readPaperEconomics(store, now);
    for (const series of Object.values(original.series))
      expect(series.points).toHaveLength(169);
    expect(original.series.supplyChange.points[0].value).toBe(1);
    await store.history.retainProtocolCharts("history", [
      row(
        -1,
        { paperSupply: 1170, stakingRewards: 270 },
        { sourceAt: now + 1 },
      ),
    ]);
    await refreshProtocolCharts(store, now + 1);
    const corrected = await readPaperEconomics(store, now + 1);
    expect(corrected.series.supplyChange.points.at(-2)?.value).toBe(3);
    expect(corrected.series.supplyChange.points.at(-1)?.value).toBe(-1);
    expect(corrected.series.rewardAllocation.points.at(-1)?.value).toBeNull();
    await refreshProtocolCharts(store, now + 1);
    expect((await readPaperEconomics(store, now + 1)).series).toEqual(
      corrected.series,
    );
  });

  it("returns cold-start nulls and retains old values while reporting every collection outage", async () => {
    const store = await memory(null);
    const cold = await readPaperEconomics(store, now);
    expect(cold).toMatchObject({
      stale: true,
      sourceAt: null,
      receivedAt: null,
      supplyRaw: null,
      stakeRatioBps: null,
    });
    expect(cold.series.supplyChange.points).toEqual([]);
    await store.put("summary", summary(), now);
    await refreshProtocolCharts(store, now);
    for (const key of ["summary", "history", "protocol-charts"]) {
      await store.put(
        "collector-heartbeat",
        { at: now, errors: { [key]: "source delayed" } },
        now,
      );
      expect(await readPaperEconomics(store, now)).toMatchObject({
        stale: true,
        supplyRaw: summary().paper.supply,
      });
    }
    await store.put("collector-heartbeat", { at: now, errors: {} }, now);
    expect((await readPaperEconomics(store, now + 30001)).stale).toBe(true);
    expect((await readPaperEconomics(store, now - 30001)).stale).toBe(true);
    await store.put(
      "summary",
      { ...summary(), source: { ...summary().source, at: now - 30001 } },
      now,
    );
    await refreshProtocolCharts(store, now);
    expect((await readPaperEconomics(store, now)).stale).toBe(true);
  });

  it("serves cached saved responses without upstream calls or per-viewer history reads", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = await memory();
    await refreshProtocolCharts(store, now);
    const historyReads = vi.spyOn(store.history, "protocolChartRows");
    const reads = vi.spyOn(store, "get");
    const upstream = new Upstream(store);
    upstreams.push(upstream);
    const request = vi
      .spyOn(upstream, "request")
      .mockRejectedValue(new Error("No upstream calls"));
    const app = await buildApi(store, upstream, undefined, { logger: false });
    apps.push(app);
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => app.inject("/api/paper/economics")),
    );
    expect(responses.every((response) => response.statusCode === 200)).toBe(
      true,
    );
    expect(responses[0].json<PaperEconomicsResponse>().supplyRaw).toBe(
      summary().paper.supply,
    );
    expect(
      reads.mock.calls.filter(([key]) => key === "paper-economics"),
    ).toHaveLength(1);
    expect(historyReads).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
