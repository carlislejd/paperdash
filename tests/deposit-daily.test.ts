import { describe, expect, it } from "vitest";
import type { DepositDailyResponse } from "../packages/shared/src/types";
import { depositDailyPoints } from "../apps/web/src/lib/deposit-daily";
import { DAY_MS } from "../apps/web/src/lib/chart-data";
import { chartExportMetadata } from "../apps/web/src/lib/chart-export";

const today = Date.UTC(2026, 9, 13);
const usdc = (amount: number) => (BigInt(amount) * 10n ** 18n).toString();
function retained(): DepositDailyResponse {
  return {
    intervalMs: 86400000,
    timeZone: "UTC",
    days: [
      {
        time: today - 4 * DAY_MS,
        depositVolumeRaw: usdc(500),
        depositCount: 3,
        firstDepositors: 2,
      },
      {
        time: today,
        depositVolumeRaw: usdc(200),
        depositCount: 5,
        firstDepositors: 1,
      },
    ],
    observedFrom: today - 4 * DAY_MS + 3000,
    updatedAt: today + 1000,
    stale: false,
    coverage: {
      partial: true,
      identityAmbiguous: true,
      projectionBackfillComplete: true,
      pending: false,
      excludedRecords: 0,
    },
  };
}

describe("daily retained deposit display", () => {
  it("keeps earlier unknown days blank, fills recorded empty days only after catch-up, and marks the current day partial", () => {
    const result = depositDailyPoints(retained(), today + 3600000);
    expect(result.counts.map((point) => point.value)).toEqual([
      null,
      null,
      2,
      0,
      0,
      0,
      1,
    ]);
    expect(result.volume.map((point) => point.value)).toEqual([
      null,
      null,
      500,
      0,
      0,
      0,
      200,
    ]);
    expect(result.counts[2].partial).toBe(true);
    expect(result.counts[3].partial).toBe(false);
    expect(result.counts.at(-1)?.partial).toBe(true);
    expect(result.range.to).toBe(today + DAY_MS);
  });

  it("does not make missing days zero while pending, backfilling, stale or failed", () => {
    for (const variant of [
      "pending",
      "backfill",
      "stale",
      "error",
      "network",
    ] as const) {
      const data = retained();
      if (variant === "pending") data.coverage.pending = true;
      if (variant === "backfill")
        data.coverage.projectionBackfillComplete = false;
      if (variant === "stale") data.stale = true;
      if (variant === "error") data.error = "Unavailable";
      const result = depositDailyPoints(data, today, variant === "network");
      expect(result.counts.map((point) => point.value)).toEqual([
        null,
        null,
        2,
        null,
        null,
        null,
        1,
      ]);
      expect(result.volume[3].value).toBeNull();
      expect(result.counts.every((point) => point.partial)).toBe(true);
    }
  });

  it("does not borrow yesterday's headline after UTC midnight, including stale data", () => {
    const data = retained();
    const previous = depositDailyPoints(data, today + DAY_MS - 1);
    expect(previous.counts.at(-1)?.value).toBe(1);
    const next = depositDailyPoints(data, today + DAY_MS);
    expect(next.counts.at(-1)?.time).toBe(today + DAY_MS);
    expect(next.counts.at(-1)?.value).toBe(0);
    data.stale = true;
    expect(
      depositDailyPoints(data, today + DAY_MS).counts.at(-1)?.value,
    ).toBeNull();
  });

  it("handles absent and malformed values without fabricating activity", () => {
    expect(
      depositDailyPoints(undefined, today).counts.every(
        (point) => point.value === null,
      ),
    ).toBe(true);
    const data = retained();
    data.days[1].firstDepositors = -1;
    data.days[1].depositVolumeRaw = "-1";
    const result = depositDailyPoints(data, today);
    expect(result.counts.at(-1)?.value).toBeNull();
    expect(result.volume.at(-1)?.value).toBeNull();
    data.observedFrom = null;
    expect(depositDailyPoints(data, today).counts[3].value).toBeNull();
  });

  it("labels the export timestamp as retained totals, not source freshness", () => {
    const data = retained();
    const result = depositDailyPoints(data, today);
    const metadata = chartExportMetadata({
      title: "First-time depositors",
      unit: "wallets",
      kind: "bar",
      points: result.counts,
      range: result.range,
      sourceAt: data.updatedAt,
      timestampLabel: "Stored totals updated",
      coverage: "Partial history",
      stale: false,
      color: "lavender",
      bucketMs: DAY_MS,
    });
    expect(metadata[2]).toContain("Stored totals updated:");
    expect(metadata[2]).not.toContain("Data timestamp");
  });
});
