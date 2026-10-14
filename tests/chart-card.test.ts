import { describe, expect, it, vi } from "vitest";
import {
  chartFilename,
  chartGeometry,
  chartStackGeometry,
  chartColorValue,
  chartBucketCaption,
  cloneChartSegments,
  chartPoints,
  chartRange,
  chartShareUrl,
  CHART_POINT_LIMIT,
  formatChartNumber,
  formatChartTime,
  HOUR_MS,
  DAY_MS,
  nearestChartPoint,
  type ChartSegment,
} from "../apps/web/src/lib/chart-data";
import {
  chartExportMetadata,
  CHART_EXPORT_SIZE,
  renderChartPng,
} from "../apps/web/src/lib/chart-export";
import { summarizeChart } from "../apps/web/src/lib/chart-summary";

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

  it("uses daily widths, preserves missing days, and grows the partial current-day bar", () => {
    const points = [
      { time: from, value: 0 },
      { time: from + DAY_MS, value: 100 },
      { time: from + 2 * DAY_MS, value: null },
      { time: from + 3 * DAY_MS, value: 12, partial: true },
    ];
    const at = from + 3 * DAY_MS + 6 * HOUR_MS;
    const daily = chartGeometry(
      points,
      { from, to: at, label: "Available UTC days" },
      "bar",
      900,
      200,
      DAY_MS,
    );
    expect(daily.bars.map((bar) => bar.time)).toEqual([
      from,
      from + DAY_MS,
      from + 3 * DAY_MS,
    ]);
    expect(daily.bars[0].height).toBe(1);
    expect(daily.bars[2].width).toBeCloseTo(daily.bars[0].width / 4);
    expect(daily.bars[2].partial).toBe(true);
    const later = chartGeometry(
      [...points.slice(0, 3), { ...points[3], value: 24 }],
      { from, to: at, label: "Available UTC days" },
      "bar",
      900,
      200,
      DAY_MS,
    );
    expect(later.points.at(-1)?.value).toBe(24);
    expect(later.bars[2].partial).toBe(true);
    expect(later.bars[2].height).toBeCloseTo(daily.bars[2].height * 2);
    const fullDaySlots = chartGeometry(
      points,
      { from, to: from + 4 * DAY_MS, label: "4 UTC days" },
      "bar",
      900,
      200,
      DAY_MS,
    );
    expect(fullDaySlots.bars[2].width).toBeCloseTo(fullDaySlots.bars[0].width);
    expect(fullDaySlots.bars[2].partial).toBe(true);
    expect(
      later.bars.every((bar) => bar.width > 0 && Number.isFinite(bar.y)),
    ).toBe(true);
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

  it("keeps nonnegative bar axes above zero and real zero markers inside the clip", () => {
    for (const values of [
      [0, 0],
      [0, 25],
      [10, 20],
    ]) {
      const geometry = chartGeometry(
        values.map((value, i) => ({ time: from + i * HOUR_MS, value })),
        range,
        "bar",
        700,
        200,
      );
      expect(geometry.baseline).toBe(200);
      expect(geometry.ticks.every((tick) => tick.value >= 0)).toBe(true);
      if (values.every((value) => value === 0)) {
        expect(geometry.y(1)).toBe(0);
        expect(geometry.ticks.every((tick) => tick.value <= 1)).toBe(true);
      }
      geometry.bars.forEach((bar, index) => {
        if (values[index] === 0) {
          expect(bar.y).toBe(199);
          expect(bar.y + bar.height).toBe(200);
        }
      });
    }
    const zeros = [{ time: from, value: 0 }];
    const line = chartGeometry(zeros, range, "line", 700, 200);
    expect(line.ticks.some((tick) => tick.value < 0)).toBe(true);
    expect(line.baseline).toBe(100);
    const signed = chartGeometry(
      [
        { time: from, value: -10 },
        { time: from + HOUR_MS, value: 20 },
      ],
      range,
      "bar",
      700,
      200,
    );
    expect(signed.ticks.some((tick) => tick.value < 0)).toBe(true);
    expect(signed.baseline).toBeLessThan(200);
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
  it("keeps daily and default hourly bucket captions consistent in exported metadata", () => {
    for (const bucketMs of [undefined, HOUR_MS, 0, NaN])
      expect(chartBucketCaption(bucketMs)).toBe(
        "Hourly UTC buckets · hatched bars are partial",
      );
    expect(chartBucketCaption(DAY_MS)).toBe(
      "Daily UTC buckets · hatched bars are partial",
    );
    expect(chartBucketCaption(60000)).toBe(
      "UTC buckets · hatched bars are partial",
    );
    const metadata = chartExportMetadata({
      title: "Rewards allocated / day",
      unit: "USDC",
      kind: "bar",
      points: [{ time: from, value: 42, partial: true }],
      range: { from, to: from + DAY_MS, label: "Today UTC" },
      sourceAt: from + 6 * HOUR_MS,
      bucketMs: DAY_MS,
      coverage: "New allocations · current day partial",
      stale: false,
      color: "green",
    });
    expect(metadata).toContain("Daily UTC buckets · hatched bars are partial");
    expect(metadata.join(" ")).not.toContain("Hourly");
    expect(metadata).toContain("Data timestamp: 10 Oct 2026, 06:00 UTC");
  });
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

describe("stacked bar breakdowns", () => {
  const segments = (
    btc: (number | null)[],
    eth: (number | null)[],
  ): ChartSegment[] => [
    {
      id: "0",
      label: "BTC",
      color: "lavender",
      points: btc.map((value, i) => ({ time: from + i * HOUR_MS, value })),
    },
    {
      id: "1",
      label: "ETH",
      color: "green",
      points: eth.map((value, i) => ({ time: from + i * HOUR_MS, value })),
    },
  ];

  it("aligns series by timestamp and stacks both assets to the supplied total without overlap", () => {
    const geometry = chartGeometry(
      [{ time: from, value: 100 }],
      range,
      "bar",
      700,
      200,
    );
    const input = segments([30], [70]);
    input[0].points = [
      { time: from + HOUR_MS, value: 999 },
      ...input[0].points,
    ];
    const stack = chartStackGeometry(geometry, input);
    expect(stack.bars).toHaveLength(2);
    const [btc, eth] = stack.bars;
    expect(btc.segmentId).toBe("0");
    expect(eth.segmentId).toBe("1");
    expect(btc.x).toBe(eth.x);
    expect(btc.width).toBe(eth.width);
    expect(eth.y + eth.height).toBeCloseTo(btc.y);
    expect(btc.y + btc.height).toBeCloseTo(geometry.baseline);
    expect(eth.y).toBeCloseTo(geometry.y(100));
    expect(btc.height / eth.height).toBeCloseTo(30 / 70);
    expect(stack.incompleteTimes).toEqual([]);
  });

  it("does not turn unknown, negative, or mismatched components into a completed stack", () => {
    const totals = [100, 100, 100, null, 0, 0];
    const geometry = chartGeometry(
      totals.map((value, i) => ({ time: from + i * HOUR_MS, value })),
      range,
      "bar",
      700,
      200,
    );
    const stack = chartStackGeometry(
      geometry,
      segments([30, 30, -1, 10, 0, 1e-12], [null, 60, 101, 10, 0, 0]),
    );
    expect(stack.bars).toHaveLength(1);
    expect(stack.bars[0]).toMatchObject({
      time: from + 4 * HOUR_MS,
      height: 1,
    });
    expect(stack.incompleteTimes).toEqual([
      from,
      from + HOUR_MS,
      from + 2 * HOUR_MS,
      from + 5 * HOUR_MS,
    ]);
    const missing = segments([30], []);
    expect(
      chartStackGeometry(
        chartGeometry([{ time: from, value: 100 }], range, "bar", 700, 200),
        missing,
      ).bars,
    ).toEqual([]);
  });

  it("retains partial evidence and finite clipped geometry for huge and tiny stacks", () => {
    for (const total of [1e308, Number.MAX_VALUE, 1e-200]) {
      const geometry = chartGeometry(
        [{ time: from, value: total }],
        range,
        "bar",
        700,
        200,
      );
      const input = segments([total / 4], [total - total / 4]);
      input[1].points = [{ ...input[1].points[0], partial: true }];
      const stack = chartStackGeometry(geometry, input);
      expect(stack.bars).toHaveLength(2);
      for (const bar of stack.bars) {
        expect(bar.partial).toBe(true);
        expect(Number.isFinite(bar.y + bar.height)).toBe(true);
        expect(bar.y).toBeGreaterThanOrEqual(0);
        expect(bar.y + bar.height).toBeLessThanOrEqual(200);
      }
    }
    const geometry = chartGeometry(
      [{ time: from, value: 4, partial: true }],
      range,
      "bar",
      700,
      200,
    );
    expect(
      chartStackGeometry(geometry, segments([2], [2])).bars.every(
        (bar) => bar.partial,
      ),
    ).toBe(true);
  });

  it("clones segment data for an asynchronous share without retaining mutable source references", () => {
    const original = segments([30], [70]);
    const captured = cloneChartSegments(original)!;
    original[0].label = "Changed";
    (original[0].points[0] as { value: number }).value = 900;
    original[1].points = [];
    expect(captured[0].label).toBe("BTC");
    expect(captured[0].points[0].value).toBe(30);
    expect(captured[1].points[0].value).toBe(70);
    expect(cloneChartSegments(undefined)).toBeUndefined();
  });

  it("exports both colored stacks, partial hatching, and a legend with the current metric unit", async () => {
    const fills: Array<{
      color: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }> = [];
    const labels: string[] = [];
    const textBoxes: Array<{ text: string; x: number; width: number }> = [];
    const strokes: string[] = [];
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      globalAlpha: 1,
      fillRect(x: number, y: number, width: number, height: number) {
        fills.push({ color: this.fillStyle, x, y, width, height });
      },
      fillText(text: string, x: number, _y: number, width: number) {
        labels.push(text);
        textBoxes.push({ text, x, width });
      },
      measureText(text: string) {
        return { width: text.length * 10 };
      },
      stroke() {
        strokes.push(this.strokeStyle);
      },
      save() {},
      restore() {},
      translate() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      rect() {},
      clip() {},
      arc() {},
      fill() {},
    };
    vi.stubGlobal("document", {
      fonts: { ready: Promise.resolve() },
      createElement: () => ({
        getContext: () => ctx,
        toBlob: (callback: (blob: Blob) => void) =>
          callback(new Blob(["png"], { type: "image/png" })),
      }),
    });
    try {
      const snapshot = {
        title: "Liquidations / hour",
        unit: "liquidations",
        kind: "bar" as const,
        points: [{ time: from, value: 100, partial: true }],
        segments: segments([30], [70]),
        range,
        sourceAt: from,
        coverage: "Observed liquidations",
        stale: false,
        color: "lavender" as const,
        valueCaption: "Current hour",
      };
      expect(chartExportMetadata(snapshot)).toContain(
        "BTC + ETH · liquidations",
      );
      expect((await renderChartPng(snapshot)).type).toBe("image/png");
      expect(labels).toContain("BTC · liquidations");
      expect(labels).toContain("ETH · liquidations");
      expect(textBoxes).toContainEqual({
        text: "Current hour",
        x: 820,
        width: 300,
      });
      expect(textBoxes).toContainEqual({ text: "100", x: 80, width: 700 });
      const summary = summarizeChart(snapshot.points, range, "bar", {
        aggregate: "sum",
        now: from + HOUR_MS / 2,
      });
      const withTotal = { ...snapshot, summary };
      expect(chartExportMetadata(withTotal)).toContain(
        "Available subtotal: 100 liquidations",
      );
      expect(chartExportMetadata(withTotal)).toContain(
        "1/6 buckets available · 5 unknown · 1 in progress",
      );
      await renderChartPng(withTotal);
      expect(labels).toContain("Available subtotal");
      expect(labels).toContain("100 liquidations");
      expect(labels).toContain(summary.coverage);
      for (const color of ["lavender", "green"] as const) {
        expect(
          fills.some(
            (fill) => fill.color === chartColorValue(color) && fill.height > 20,
          ),
        ).toBe(true);
        expect(strokes).toContain(chartColorValue(color));
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
