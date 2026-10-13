import { describe, expect, it } from "vitest";
import { niceChartAxis, formatAxisTick } from "../apps/web/src/lib/chart-axis";
import { chartGeometry, HOUR_MS } from "../apps/web/src/lib/chart-data";

describe("rounded chart axes", () => {
  it("encloses actual values with round ticks instead of rounding a label at the wrong position", () => {
    const axis = niceChartAxis(0, 47, { includeZero: true, padding: 0 });
    expect(axis.ticks).toEqual([0, 10, 20, 30, 40, 50]);
    expect(axis.position(47)).toBeCloseTo(47 / 50);
    const prices = niceChartAxis(3090, 3313, { padding: 0 });
    expect(prices.ticks).toEqual([3050, 3100, 3150, 3200, 3250, 3300, 3350]);
    expect(prices.position(3313)).toBeGreaterThan(prices.position(3300));
    expect(prices.position(3313)).toBeLessThan(1);
  });

  it("uses whole numbers for counts while retaining a real zero baseline", () => {
    for (const max of [0, 1, 2, 9, 10, 11, 12, 47]) {
      const axis = niceChartAxis(0, max, {
        integer: true,
        includeZero: true,
        padding: 0,
      });
      expect(axis.ticks.every(Number.isInteger)).toBe(true);
      expect(axis.ticks[0]).toBe(0);
      expect(axis.position(0)).toBe(0);
      expect(axis.ticks.at(-1)).toBeGreaterThanOrEqual(max);
    }
  });

  it("keeps signed, flat, tiny and huge series finite and bounded", () => {
    for (const [min, max] of [
      [-3313, -47],
      [-47, 47],
      [0, 0],
      [3500, 3500],
      [1e-200, 2e-200],
      [-1e308, 1e308],
      [Number.MAX_VALUE, Number.MAX_VALUE],
      [Number.MIN_VALUE, 2 * Number.MIN_VALUE],
      [1e15, 1e15 + 0.125],
    ]) {
      const axis = niceChartAxis(min, max);
      expect(axis.ticks.length).toBeGreaterThan(1);
      expect(axis.ticks.length).toBeLessThanOrEqual(16);
      expect(axis.ticks.every(Number.isFinite)).toBe(true);
      expect(new Set(axis.ticks).size).toBe(axis.ticks.length);
      for (const v of [min, max, ...axis.ticks]) {
        expect(axis.position(v)).toBeGreaterThanOrEqual(0);
        expect(axis.position(v)).toBeLessThanOrEqual(1);
      }
      expect(axis.position(min)).toBeLessThanOrEqual(axis.position(max));
      expect(axis.ticks.some((v) => Object.is(v, -0))).toBe(false);
    }
    const subnormalPrice = niceChartAxis(Number.MIN_VALUE, Number.MIN_VALUE, {
      minPadding: 0.01,
      nonnegative: true,
    });
    expect(Number.isFinite(subnormalPrice.position(Number.MIN_VALUE))).toBe(
      true,
    );
  });

  it("gives distinct compact labels to a narrow range around a large balance", () => {
    for (const ticks of [
      [5_000_000, 5_000_500, 5_001_000],
      [0, 0.0025, 0.005],
      [1e-200, 2e-200, 3e-200],
    ]) {
      const labels = ticks.map((v) => formatAxisTick(v, ticks));
      expect(new Set(labels).size).toBe(ticks.length);
      expect(labels.join(" ")).not.toMatch(/NaN|Infinity/);
    }
    expect(
      formatAxisTick(3500, [3000, 3500, 4000], {
        compact: false,
        currency: true,
      }),
    ).toBe("$3,500");
    expect(formatAxisTick(50, [0, 25, 50])).toBe("50");
    const fractions = [0, 2.5, 5, 7.5, 10];
    expect(fractions.map((v) => formatAxisTick(v, fractions))).toEqual([
      "0",
      "2.5",
      "5",
      "7.5",
      "10",
    ]);
    expect(formatAxisTick(1.5e308, [1e308, 1.5e308])).toBe("1.5E308");
  });

  it("keeps dashboard, expanded and PNG geometry on the same numeric ticks", () => {
    const points = [47, 13].map((value, i) => ({ time: i * HOUR_MS, value }));
    const range = { from: 0, to: 2 * HOUR_MS, label: "2h" };
    const charts = [
      [700, 138],
      [700, 268],
      [1540, 420],
    ].map(([width, height]) =>
      chartGeometry(points, range, "bar", width, height, HOUR_MS, true),
    );
    for (const chart of charts) {
      expect(chart.points).toEqual(points);
      expect(chart.ticks.map((t) => t.value)).toEqual(
        charts[0].ticks.map((t) => t.value),
      );
      for (const tick of chart.ticks) expect(tick.y).toBe(chart.y(tick.value));
    }
  });
});
