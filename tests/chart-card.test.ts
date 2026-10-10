import { describe, expect, it } from "vitest";
import {
  chartFilename,
  chartGeometry,
  chartPoints,
  chartRange,
  chartShareUrl,
  CHART_POINT_LIMIT,
  formatChartNumber,
  formatChartTime,
  HOUR_MS,
  nearestChartPoint,
} from "../apps/web/src/lib/chart-data";
import {
  chartExportMetadata,
  CHART_EXPORT_SIZE,
} from "../apps/web/src/lib/chart-export";

const from = Date.UTC(2026, 9, 10);
const range = { from, to: from + 6 * HOUR_MS, label: "6h" };

describe("shareable chart geometry", () => {
  it("does not join unavailable, explicitly gapped, or missing hourly observations", () => {
    const geometry = chartGeometry(
      [
        { time: from, value: 10 },
        { time: from + HOUR_MS, value: null },
        { time: from + 2 * HOUR_MS, value: 11 },
        { time: from + 3 * HOUR_MS, value: 12, gapBefore: true },
        { time: from + 5 * HOUR_MS, value: 13 },
        { time: from + 6 * HOUR_MS, value: 14 },
      ],
      range,
      "line",
      700,
      200,
    );
    expect(geometry.path.match(/M/g)).toHaveLength(4);
    expect(geometry.path.match(/L/g)).toHaveLength(1);
    expect(geometry.markers).toHaveLength(3);
  });

  it("preserves missing latest values instead of substituting older data", () => {
    const { points } = chartPoints(
      [
        { time: from, value: 100 },
        { time: from + HOUR_MS, value: Infinity },
        { time: from + 2 * HOUR_MS, value: NaN },
      ],
      range,
    );
    expect(points.map((point) => point.value)).toEqual([100, null, null]);
    expect(formatChartNumber(points.at(-1)?.value)).toBe("—");
  });

  it("keeps finite coordinates and labels at both extremes of the number range", () => {
    for (const values of [
      [-1e308, 1e308],
      [0, 0],
      [1e-200, 2e-200],
      [Number.MAX_VALUE, Number.MAX_VALUE],
    ]) {
      const geometry = chartGeometry(
        values.map((value, i) => ({ time: from + i * HOUR_MS, value })),
        range,
        "line",
        700,
        200,
      );
      expect(geometry.path).not.toMatch(/NaN|Infinity/);
      for (const value of values)
        expect(geometry.y(value)).toBeGreaterThanOrEqual(0);
      for (const tick of geometry.ticks)
        expect(Number.isFinite(tick.value)).toBe(true);
    }
    expect(formatChartNumber(1e308)).toMatch(/E308/);
    expect(formatChartNumber(NaN)).toBe("—");
    expect(formatChartNumber(-Infinity)).toBe("—");
  });

  it("renders real zero bars, distinguishes missing bars, and marks partial buckets", () => {
    const geometry = chartGeometry(
      [
        { time: from, value: 0 },
        { time: from + HOUR_MS, value: null },
        { time: from + 2 * HOUR_MS, value: -20 },
        { time: from + 3 * HOUR_MS, value: 30, partial: true },
      ],
      range,
      "bar",
      700,
      200,
    );
    expect(geometry.bars).toHaveLength(3);
    expect(geometry.bars[0].height).toBe(1);
    expect(geometry.bars[1].y).toBe(geometry.baseline);
    expect(geometry.bars[2].partial).toBe(true);
    expect(geometry.bars.every((bar) => bar.width > 0 && bar.height > 0)).toBe(
      true,
    );
  });

  it("sorts, bounds, and combines duplicate gap/partial evidence", () => {
    const prepared = chartPoints(
      [
        { time: from + HOUR_MS, value: 2, gapBefore: true },
        { time: from - 1, value: 10 },
        { time: from, value: 1 },
        { time: from + HOUR_MS, value: 3, partial: true },
        { time: -1, value: 9 },
      ],
      range,
    );
    expect(prepared.points).toEqual([
      { time: from, value: 1 },
      { time: from + HOUR_MS, value: 3, gapBefore: true, partial: true },
    ]);
    const bounded = chartPoints(
      Array.from({ length: CHART_POINT_LIMIT + 50 }, (_, i) => ({
        time: from + i,
        value: i,
      })),
      range,
    );
    expect(bounded.points).toHaveLength(CHART_POINT_LIMIT);
    expect(bounded.truncated).toBe(true);
  });

  it("handles invalid ranges and keyboard/hover nearest-point selection", () => {
    expect(chartRange({ from: NaN, to: Infinity, label: "Unknown" })).toEqual({
      from: 0,
      to: HOUR_MS,
      label: "Unknown",
    });
    expect(chartRange({ from: 8.64e15, to: 8.64e15, label: "End" }).to).toBe(
      8.64e15,
    );
    expect(nearestChartPoint([], from)).toBeNull();
    expect(
      nearestChartPoint(
        [
          { time: from, value: 0 },
          { time: from + HOUR_MS, value: 1 },
        ],
        from + HOUR_MS - 1,
      ),
    ).toBe(1);
  });
});

describe("chart sharing metadata", () => {
  it("uses explicit UTC timestamps across date boundaries and never fabricates missing timestamps", () => {
    expect(formatChartTime(from)).toBe("10 Oct 2026, 00:00 UTC");
    expect(formatChartTime(null)).toBe("Unavailable");
    expect(formatChartTime(Infinity)).toBe("Unavailable");
    const metadata = chartExportMetadata({
      title: "Hourly volume",
      unit: "USDC",
      kind: "bar",
      points: [],
      range,
      sourceAt: from,
      coverage: "Partial observed history",
      stale: true,
      color: "lavender",
    });
    expect(metadata.join(" ")).toContain(
      "Data timestamp: 10 Oct 2026, 00:00 UTC",
    );
    expect(metadata.join(" ")).toContain(
      "Last available · Partial observed history",
    );
    expect(metadata.join(" ")).toContain("hatched bars are partial");
    expect(CHART_EXPORT_SIZE).toEqual({ width: 1800, height: 1000 });
  });

  it("creates chart-only share links without wallet/search state and safe download filenames", () => {
    const url = new URL(
      chartShareUrl(
        "https://papertrade.club/?view=wallets&q=private&wallet=0x123#activity",
        "volume-hourly",
      ),
    );
    expect(url.toString()).toBe(
      "https://papertrade.club/?view=overview&chart=volume-hourly",
    );
    expect(
      new URL(
        chartShareUrl("https://papertrade.club/?range=7d&wallet=secret", "tvl"),
      ).search,
    ).toBe("?view=overview&chart=tvl&range=7d");
    expect(
      new URL(
        chartShareUrl("https://papertrade.club/?range=24h", "tvl"),
      ).searchParams.get("range"),
    ).toBe("24h");
    expect(
      new URL(
        chartShareUrl("https://papertrade.club/?range=999d", "tvl"),
      ).searchParams.has("range"),
    ).toBe(false);
    expect(chartFilename("../../PAPER supply?<svg>")).toBe(
      "paperclub-paper-supply-svg.png",
    );
    expect(chartFilename("!!!")).toBe("paperclub-chart.png");
  });
});
