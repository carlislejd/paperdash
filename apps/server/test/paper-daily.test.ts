import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProtocolSummary } from "../../../packages/shared/src/types.js";
import type { ProtocolChartObservation } from "../src/history-store.js";
import { createStore, type Store } from "../src/store.js";
import { readPaperEconomics, refreshProtocolCharts, VERIFIED_PROTOCOL_GENESIS } from "../src/protocol-charts.js";

const HOUR = 3600000;
const DAY = 86400000;
const today = Date.UTC(2026, 9, 12);
const now = today + 12 * HOUR + HOUR / 2;
const currentHour = Math.floor(now / HOUR) * HOUR;
const genesis = `genesis:${VERIFIED_PROTOCOL_GENESIS}`;
const unit = 10n ** 18n;
const stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  vi.restoreAllMocks();
});
function summary(at: number, supply = 1000n * unit, rewards = 100n * unit): ProtocolSummary {
  return {
    ok: true,
    source: { at, block: "1", genesis: VERIFIED_PROTOCOL_GENESIS },
    balances: { tvl: "0", margin: "0", lp: "0", reserve: "0", queue: "0" },
    activity: { volume: "0", open: 0 },
    fees: { lifetime: rewards.toString(), pending: "0" },
    paper: { supply: supply.toString(), staked: "0" },
  };
}
async function memory(value: ProtocolSummary | null = null) {
  const store = await createStore({ memory: true, databaseUrl: "" });
  stores.push(store);
  if (value) await store.put("summary", value, now);
  await store.put("collector-heartbeat", { at: now, errors: {} }, now);
  return store;
}
function observation(time: number, supply: number, rewards: number, overrides: Partial<ProtocolChartObservation> = {}): ProtocolChartObservation {
  return {
    time,
    endpointAt: Math.min(time + HOUR - 1, now),
    sourceAt: now,
    generation: "history-a",
    complete: time < currentHour,
    values: { paperSupply: supply, stakingRewards: rewards },
    ...overrides,
  };
}
function historyRows(from = today - 2 * DAY - HOUR) {
  return Array.from({ length: (currentHour - from) / HOUR + 1 }, (_, i) =>
    observation(from + i * HOUR, 1000 + 2 * i, 100 + 3 * i));
}
async function daily(store: Store, at = now) {
  await refreshProtocolCharts(store, at);
  return (await readPaperEconomics(store, at)).daily!;
}

describe("UTC calendar PAPER changes", () => {
  it("uses midnight cumulative boundaries rather than a rolling24-hour window or hourly bar sum", async () => {
    const store = await memory();
    await store.history.retainProtocolCharts("history", historyRows());
    const data = await daily(store);
    expect(data).toMatchObject({ intervalMs: DAY, timeZone: "UTC" });
    expect(data.supplyChange.aggregation).toBe("daily-change");
    expect(data.supplyChange.points).toHaveLength(7);
    expect(data.supplyChange.points.map((point) => point.time)).toEqual(
      Array.from({ length: 7 }, (_, i) => today - (6 - i) * DAY),
    );
    expect(data.supplyChange.points.at(-2)).toMatchObject({
      time: today - DAY, value: 48, observedFromMs: today - DAY - 1, observedToMs: today - 1,
    });
    expect(data.supplyChange.points.at(-2)?.partial).toBeUndefined();
    expect(data.rewardAllocation.points.at(-2)?.value).toBe(72);
    expect(data.supplyChange.points.at(-1)).toMatchObject({
      time: today, value: 26, partial: true, observedFromMs: today - 1, observedToMs: now,
    });
  });

  it("grows today's bar from the latest same-summary snapshot using exact raw differences and no extra reads", async () => {
    const base = 9007199254740993000000000000000000n;
    const store = await memory(summary(now, base + unit, base + 1n));
    await store.history.retainProtocolCharts("summary", Array.from({ length: 14 }, (_, i) => {
      const time = today - HOUR + i * HOUR;
      return observation(time, Number(base) / 1e18, Number(base) / 1e18, {
        endpointAt: Math.min(time + HOUR - 2000, now - 1000),
        complete: false,
        generation: genesis,
        paperSupplyRaw: base.toString(),
        allocatedRewardsRaw: base.toString(),
      });
    }));
    const readRows = vi.spyOn(store.history, "protocolChartRows");
    const reads = vi.spyOn(store, "get");
    const first = await daily(store);
    expect(readRows.mock.calls).toEqual([["history"], ["summary"]]);
    expect(reads.mock.calls.filter(([key]) => key === "summary")).toHaveLength(1);
    expect(first.supplyChange.points.at(-1)).toMatchObject({ value: 1, valueRaw: unit.toString(), partial: true,
      observedFromMs: today - 2000, observedToMs: now });
    expect(first.rewardAllocation.points.at(-1)).toMatchObject({ value: 1e-18, valueRaw: "1" });
    await store.put("summary", summary(now + 10000, base + 3n * unit, base + 3n), now + 10000);
    const second = await daily(store, now + 10000);
    expect(second.supplyChange.points.at(-1)).toMatchObject({ value: 3, observedToMs: now + 10000 });
    expect(second.rewardAllocation.points.at(-1)).toMatchObject({ value: 3e-18, valueRaw: "3" });
  });

  it("keeps unknown days unknown across missing hours, null values, partial history or generation changes", async () => {
    for (const defect of ["missing", "null", "partial", "generation"] as const) {
      const store = await memory();
      let rows = historyRows(today - DAY - HOUR);
      const affected = today - DAY + 8 * HOUR;
      rows = rows.flatMap((row) => row.time !== affected ? [row]
        : defect === "missing" ? []
          : [{ ...row,
            ...(defect === "null" ? { values: { paperSupply: null, stakingRewards: null } } : {}),
            ...(defect === "partial" ? { complete: false } : {}),
            ...(defect === "generation" ? { generation: "different-deployment" } : {}),
          }]);
      await store.history.retainProtocolCharts("history", rows);
      const data = await daily(store);
      for (const series of [data.supplyChange, data.rewardAllocation])
        expect(series.points.at(-2)).toMatchObject({ value: null, gapBefore: true, partial: true });
    }
  });

  it("rejects allocation counter resets inside a day even if the final endpoint has recovered", async () => {
    const store = await memory();
    const rows = historyRows(today - DAY - HOUR).map((row) => row.time === today - DAY + 8 * HOUR
      ? { ...row, values: { ...row.values, stakingRewards: 0 } }
      : row);
    await store.history.retainProtocolCharts("history", rows);
    const data = await daily(store);
    expect(data.rewardAllocation.points.at(-2)).toMatchObject({ value: null, gapBefore: true });
    expect(data.supplyChange.points.at(-2)?.value).toBe(48);
  });

  it("preserves a negative net PAPER change without describing it as minting", async () => {
    const store = await memory();
    const rows = historyRows(today - DAY - HOUR).map((row, i) => ({
      ...row, values: { ...row.values, paperSupply: 1000 - i },
    }));
    await store.history.retainProtocolCharts("history", rows);
    const data = await daily(store);
    expect(data.supplyChange.points.at(-2)?.value).toBe(-24);
    expect(data.rewardAllocation.points.at(-2)?.value).toBe(72);
    expect(data).not.toHaveProperty("minted");
  });

  it("does not bridge history and summary namespaces or fabricate a midnight baseline", async () => {
    for (const defect of ["mixed", "old-boundary", "unknown-genesis", "summary-gap"] as const) {
      const store = await memory(summary(now));
      const baseline = observation(today - HOUR, 900, 90, {
        generation: genesis, complete: false, endpointAt: today - 2000,
      });
      const rows = Array.from({ length: 13 }, (_, i) => observation(today + i * HOUR, 900 + i, 90 + i, {
        generation: genesis, complete: false,
      }));
      if (defect === "mixed")
        await store.history.retainProtocolCharts("history", [{ ...baseline, generation: "history-a", complete: true, endpointAt: today - 1 }]);
      else rows.unshift({ ...baseline, ...(defect === "old-boundary" ? { endpointAt: today - 60001 } : {}) });
      await store.history.retainProtocolCharts("summary", rows
        .filter((row) => defect !== "summary-gap" || row.time !== today + HOUR)
        .map((row) => defect === "unknown-genesis" ? { ...row, generation: "genesis:unknown" } : row));
      const data = await daily(store);
      expect(data.supplyChange.points.at(-1)).toMatchObject({ value: null, gapBefore: true });
    }
  });

  it("prefers complete past history to partial summaries and applies corrected daily endpoints idempotently", async () => {
    const store = await memory();
    const history = historyRows(today - DAY - HOUR);
    await store.history.retainProtocolCharts("history", history);
    await store.history.retainProtocolCharts("summary", history.map((row, i) => ({
      ...row, generation: genesis, complete: false,
      values: { paperSupply: 100 + i, stakingRewards: 10 + i },
    })));
    let data = await daily(store);
    expect(data.supplyChange.points.at(-2)?.value).toBe(48);
    expect(data.supplyChange.points.at(-2)?.partial).toBeUndefined();
    const boundary = history.find((row) => row.time === today - HOUR)!;
    await store.history.retainProtocolCharts("history", [{
      ...boundary, sourceAt: now + 1, values: { ...boundary.values, paperSupply: boundary.values.paperSupply! + 5 },
    }]);
    data = await daily(store, now + 1);
    expect(data.supplyChange.points.at(-2)?.value).toBe(53);
    expect((await daily(store, now + 1))).toEqual(data);
  });
});
