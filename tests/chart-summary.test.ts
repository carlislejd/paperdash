import { describe, expect, it } from "vitest";
import { DAY_MS, HOUR_MS } from "../apps/web/src/lib/chart-data";
import {
  chartValueCaption,
  hourlyChartRangeLabel,
  summarizeChart,
} from "../apps/web/src/lib/chart-summary";

const from = Date.UTC(2026, 9, 14);
const range = { from, to: from + 3 * HOUR_MS, label: "3 UTC hour buckets" };

describe("chart period totals and coverage", () => {
  it("sums only selected, visible buckets and keeps the growing current bucket separate from missing data", () => {
    const summary = summarizeChart(
      [
        { time: from - HOUR_MS, value: 500 },
        { time: from, value: 10 },
        { time: from + HOUR_MS, value: 20 },
        { time: from + HOUR_MS, value: 25 },
        { time: from + 2 * HOUR_MS, value: 5, partial: true },
        { time: range.to, value: 100 },
        { time: range.to + HOUR_MS, value: 200 },
      ],
      range,
      "bar",
      { aggregate: "sum", now: from + 2.5 * HOUR_MS },
    );
    expect(summary.total).toEqual({
      value: 40,
      label: "Selected-period total",
    });
    expect(summary.coverage).toBe("3/3 buckets available · 1 in progress");
  });

  it("uses an available subtotal for absent, null and explicitly gapped buckets without treating them as zero", () => {
    const summary = summarizeChart(
      [
        { time: from, value: 12, gapBefore: true },
        { time: from + HOUR_MS, value: null },
      ],
      range,
      "bar",
      { aggregate: "sum", totalLabel: "Recorded total" },
    );
    expect(summary.total).toEqual({ value: 12, label: "Available subtotal" });
    expect(summary.coverage).toBe("1/3 buckets available · 2 unknown · 1 gap");
    for (const points of [
      [],
      [{ time: from, value: null }],
      [{ time: from, value: Infinity }],
    ]) {
      expect(
        summarizeChart(points, range, "bar", { aggregate: "sum" }).total?.value,
      ).toBeNull();
    }
  });

  it("preserves real zeros, signed supply changes and source-partial coverage independently of bucket availability", () => {
    const days = { from, to: from + 3 * DAY_MS, label: "3 UTC days" };
    const summary = summarizeChart(
      [
        { time: from, value: 100, partial: true },
        { time: from + DAY_MS, value: -20 },
        { time: from + 2 * DAY_MS, value: 0, partial: true },
      ],
      days,
      "bar",
      { aggregate: "sum", bucketMs: DAY_MS, now: from + 2.5 * DAY_MS },
    );
    expect(summary.total?.value).toBe(80);
    expect(summary.coverage).toBe(
      "3/3 buckets available · 1 in progress · 1 other partial",
    );
    expect(
      summarizeChart(
        [{ time: from, value: 0 }],
        { ...range, to: from + HOUR_MS },
        "bar",
        {
          aggregate: "sum",
          totalLabel: "Recorded total",
        },
      ).total,
    ).toEqual({ value: 0, label: "Recorded total" });
  });

  it("does not sum stocks, prices or open-position bars and does not invent a zero when addition overflows", () => {
    const points = [
      { time: from, value: 100 },
      { time: from + HOUR_MS, value: 120 },
    ];
    expect(
      summarizeChart(points, range, "line", { aggregate: "sum" }).total,
    ).toBeNull();
    expect(summarizeChart(points, range, "bar").total).toBeNull();
    expect(
      summarizeChart(
        points.map((p) => ({ ...p, value: 1e308 })),
        range,
        "bar",
        { aggregate: "sum" },
      ).total?.value,
    ).toBeNull();
  });

  it("uses half-open calendar bucket ranges and accurate captions for older snapshots", () => {
    const now = from + 2.5 * HOUR_MS;
    expect(
      chartValueCaption("bar", "sum", from + 2 * HOUR_MS, HOUR_MS, now),
    ).toBe("This hour so far");
    expect(chartValueCaption("bar", "sum", from, HOUR_MS, now)).toBe(
      "Latest recorded hour",
    );
    expect(chartValueCaption("bar", undefined, from, HOUR_MS, now)).toBe(
      "Latest hourly snapshot",
    );
    expect(chartValueCaption("line", undefined, from, HOUR_MS, now)).toBe(
      "Latest snapshot",
    );
    expect(hourlyChartRangeLabel(168)).toBe("7 days · 168 UTC hour buckets");
    expect(hourlyChartRangeLabel(24)).toBe("24 UTC hour buckets");
    expect(
      summarizeChart(
        [{ time: from, value: 1 }],
        {
          ...range,
          to: from + HOUR_MS,
        },
        "bar",
      ).coverage,
    ).toBe("1/1 buckets available");
  });
});
