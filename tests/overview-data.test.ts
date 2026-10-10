import { describe, expect, it } from "vitest";
import type { Overview, ProtocolSummary } from "../packages/shared/src/types";
import { readLiveTvl } from "../packages/shared/src/live-tvl";
import {
  mergeOverviewUpdate,
  withLiveTvl,
} from "../apps/web/src/lib/overview-data";

const minute = 1_800_000_000_000;
function summary(value: string, at = minute + 1000): ProtocolSummary {
  return {
    ok: true,
    source: { at, block: String(at) },
    balances: { tvl: value, margin: "0", lp: "0", reserve: "0", queue: "0" },
    activity: { volume: "0", open: 0 },
    fees: { pending: "0", lifetime: "0" },
    paper: { supply: "0", staked: "0" },
  };
}
function overview(): Overview {
  return {
    summary: summary("100000000000000000000"),
    accountCount: 1,
    history: [
      { time: minute - 60000, value: 90 },
      { time: minute, value: 99 },
    ],
    historyCoverage: "upstream",
    trades: [],
    status: {
      sourceAt: minute + 1000,
      receivedAt: minute + 1000,
      indexedBlock: "1",
      persistence: "local",
      stale: false,
      stream: "connected",
    },
  };
}
function metrics(value: string, at: number) {
  return {
    summary: summary(value, at),
    accountCount: 1,
    status: { ...overview().status, sourceAt: at },
  };
}
describe("source-backed live TVL chart reconciliation", () => {
  it("updates the current chart point from initial and successive metrics at live cadence", () => {
    const initial = mergeOverviewUpdate(null, overview())!;
    expect(initial.history.at(-1)).toEqual({ time: minute, value: 100 });
    const updated = mergeOverviewUpdate(
      initial,
      metrics("105250000000000000000", minute + 2000),
    )!;
    expect(updated.history).toEqual([
      { time: minute - 60000, value: 90 },
      { time: minute, value: 105.25 },
    ]);
    expect(initial.history.at(-1)!.value).toBe(100);
  });
  it("appends only observed minute points and stays bounded while awaiting full history", () => {
    let current = {
      ...overview(),
      history: Array.from({ length: 300 }, (_, i) => ({
        time: minute - (299 - i) * 60000,
        value: i,
      })),
    };
    const anchor = current.history[0];
    for (let i = 1; i <= 5; i++) {
      current = mergeOverviewUpdate(
        current,
        metrics("101000000000000000000", minute + i * 60000),
      )!;
      expect(current.history).toHaveLength(301);
      expect(current.history[0]).toEqual(anchor);
      expect(current.history.at(-1)).toEqual({
        time: minute + i * 60000,
        value: 101,
      });
    }
    const jumped = mergeOverviewUpdate(
      current,
      metrics("102000000000000000000", minute + 10 * 60000),
    )!;
    expect(jumped.history.at(-2)!.time).toBe(minute + 5 * 60000);
    expect(jumped.history.at(-1)!.time).toBe(minute + 10 * 60000);
    expect(jumped.history[0]).toEqual(anchor);
  });
  it("preserves historical corrections while the latest summary owns its active-minute value", () => {
    const current = mergeOverviewUpdate(null, overview())!;
    const next = mergeOverviewUpdate(current, {
      history: [
        { time: minute - 60000, value: 85 },
        { time: minute, value: 77 },
      ],
      historyCoverage: "observed",
    })!;
    expect(next.history).toEqual([
      { time: minute - 60000, value: 85 },
      { time: minute, value: 100 },
    ]);
    expect(next.historyCoverage).toBe("observed");
    const oldHistory = mergeOverviewUpdate(current, {
      history: [{ time: minute - 60000, value: 84 }],
      historyCoverage: "upstream",
    })!;
    expect(oldHistory.history.at(-1)).toEqual({ time: minute, value: 100 });
  });
  it("rejects an older summary within the same minute and does not replace a future history tail", () => {
    const current = mergeOverviewUpdate(null, overview())!;
    expect(
      mergeOverviewUpdate(current, metrics("50000000000000000000", minute)),
    ).toBe(current);
    const future = {
      ...current,
      history: [{ time: minute + 60000, value: 123 }],
    };
    expect(withLiveTvl(future)).toBe(future);
    expect(
      mergeOverviewUpdate(current, {
        ...overview(),
        status: { ...current.status, sourceAt: minute },
      }),
    ).toBe(current);
  });
  it("does not invent a baseline before an initial overview or overwrite history on invalid summary", () => {
    expect(mergeOverviewUpdate(null, metrics("1", minute))).toBeNull();
    for (const value of [
      null,
      {},
      { ...summary("1"), ok: false },
      summary("-1"),
      summary("1.5"),
      summary("01"),
      summary("9".repeat(79)),
      summary("1", Infinity),
      summary("1", -1),
      summary("1", Number.MAX_SAFE_INTEGER + 1),
    ]) {
      const invalid = {
        ...overview(),
        summary: value as ProtocolSummary | null,
      };
      expect(withLiveTvl(invalid)).toBe(invalid);
      expect(readLiveTvl(value)).toBeNull();
    }
    expect(
      readLiveTvl(summary("10000000000000000000000000000"))!.point.value,
    ).toBe(10_000_000_000);
    expect(readLiveTvl(summary("0"))!.point.value).toBe(0);
    const maximumRaw = "9".repeat(78);
    expect(readLiveTvl(summary(maximumRaw))!.point.value).toBe(
      Number(BigInt(maximumRaw)) / 1e18,
    );
    expect(Number.isFinite(readLiveTvl(summary(maximumRaw))!.point.value)).toBe(
      true,
    );
  });
});
