import { describe, expect, it } from "vitest";
import {
  GRAPH_PRICE_LIMIT,
  GRAPH_TRADE_LIMIT,
  graphBubbleRadius,
  graphPriceAxis,
  graphPricePath,
  graphPrices,
  graphExecutionPrice,
  graphTrades,
} from "../apps/web/src/lib/trade-graph";
import type { TradeEvent } from "../packages/shared/src/types";

const trade = (id: string, ts: number): TradeEvent => ({
  id,
  ts,
  instrument: 0,
  wallet: `0x${"a".repeat(40)}`,
  side: "long",
  kind: "open",
  leverage: 10,
  notionalUsd: 1_000,
  pnlUsd: null,
  provenance: "public-stream",
});

describe("bounded trade graph data", () => {
  it("keeps recent valid unique price samples and refuses future values", () => {
    const points = graphPrices(
      [
        ...Array.from({ length: 900 }, (_, time) => ({ time, priceUsd: 100 })),
        { time: 899, priceUsd: 200 },
        { time: 1000, priceUsd: 200 },
        { time: 800, priceUsd: NaN },
        { time: 799.5, priceUsd: 50 },
        { time: 801, priceUsd: -1 },
      ],
      0,
      900,
    );
    expect(points).toHaveLength(GRAPH_PRICE_LIMIT);
    expect(points.at(-1)).toEqual({ time: 899, priceUsd: 200 });
    expect(points[0].time).toBe(180);
  });

  it("requires a real execution price, never inferring one from the reference line", () => {
    expect(graphExecutionPrice(trade("unknown", 0))).toBeNull();
    expect(
      graphExecutionPrice({ ...trade("valid", 0), priceUsd: 52_000 }),
    ).toBe(52_000);
    expect(
      graphExecutionPrice({ ...trade("invalid", 0), priceUsd: NaN }),
    ).toBeNull();
    expect(
      graphExecutionPrice({ ...trade("zero", 0), priceUsd: 0 }),
    ).toBeNull();
  });

  it("preserves price gaps in the path and gives a flat series a finite rounded axis", () => {
    const points = [
      { time: 0, priceUsd: 100 },
      { time: 5_000, priceUsd: 100 },
      { time: 60_000, priceUsd: 100 },
    ];
    expect(
      graphPricePath(
        points,
        (time) => time / 1_000,
        (price) => price,
      ),
    ).toBe("M0.00,100.00 L5.00,100.00 M60.00,100.00");
    const axis = graphPriceAxis(points)!;
    expect(axis.ticks[0]).toBeLessThan(100);
    expect(axis.ticks.at(-1)).toBeGreaterThan(100);
    expect(axis.position(100)).toBeGreaterThan(0);
    expect(axis.position(100)).toBeLessThan(1);
    expect(graphPriceAxis([])).toBeNull();
  });

  it("uses the same rounded price axis for reference samples and execution prices", () => {
    const axis = graphPriceAxis([
      { time: 1, priceUsd: 83_456.75 },
      { time: 2, priceUsd: 83_489.15 },
      { time: 2, priceUsd: 83_510.4 },
    ])!;
    expect(axis.ticks[0]).toBeLessThan(83_456.75);
    expect(axis.ticks.at(-1)).toBeGreaterThan(83_510.4);
    expect(axis.ticks.every((tick) => Number.isInteger(tick))).toBe(true);
    axis.ticks.forEach((tick, index) => {
      expect(axis.position(tick)).toBeCloseTo(index / (axis.ticks.length - 1));
    });
    expect(axis.position(83_510.4)).toBeLessThan(1);
    expect(axis.position(83_510.4)).toBeGreaterThan(axis.position(83_489.15));
  });

  it("keeps tiny and extreme prices finite and nonnegative without admitting invalid prices", () => {
    expect(
      graphPriceAxis([
        { time: 0, priceUsd: NaN },
        { time: 1, priceUsd: Infinity },
        { time: 2, priceUsd: 0 },
        { time: 3, priceUsd: -1 },
      ]),
    ).toBeNull();
    for (const priceUsd of [0.000001, Number.MAX_VALUE]) {
      const axis = graphPriceAxis([{ time: 0, priceUsd }])!;
      expect(axis.ticks.length).toBeGreaterThan(1);
      expect(
        axis.ticks.every((tick) => Number.isFinite(tick) && tick >= 0),
      ).toBe(true);
      expect(Number.isFinite(axis.position(priceUsd))).toBe(true);
      expect(axis.position(priceUsd)).toBeGreaterThanOrEqual(0);
      expect(axis.position(priceUsd)).toBeLessThanOrEqual(1);
    }
  });

  it("preserves a known short reconnect gap when a current quote repeats its timestamp", () => {
    const points = graphPrices(
      [
        { time: 1_000, priceUsd: 100 },
        { time: 6_000, priceUsd: 101, gapBefore: true },
        { time: 6_000, priceUsd: 102 },
      ],
      0,
      10_000,
    );
    expect(points[1]).toEqual({ time: 6_000, priceUsd: 102, gapBefore: true });
    expect(
      graphPricePath(
        points,
        (time) => time / 1_000,
        (price) => price,
      ),
    ).toBe("M1.00,100.00 M6.00,102.00");
  });

  it("bounds and deduplicates the selected market without fabricating zero-notional bubbles", () => {
    const rows = Array.from({ length: 300 }, (_, i) => trade(String(i), i));
    const latest = trade("299", 299);
    latest.notionalUsd = 4_000;
    const result = graphTrades(
      [
        ...rows,
        latest,
        { ...trade("wrong", 299), instrument: 1 },
        trade("future", 301),
      ],
      0,
      0,
      300,
    );
    expect(result).toHaveLength(GRAPH_TRADE_LIMIT);
    expect(result[0].notionalUsd).toBe(4_000);
    expect(new Set(result.map((row) => row.id)).size).toBe(result.length);
    expect(graphBubbleRadius(0, 1_000)).toBe(0);
  });

  it("scales bubble area with notional between minimum and maximum caps", () => {
    expect(
      graphBubbleRadius(25, 100) ** 2 / graphBubbleRadius(100, 100) ** 2,
    ).toBeCloseTo(0.25);
    expect(graphBubbleRadius(1, 10_000)).toBe(4);
    expect(graphBubbleRadius(20_000, 10_000)).toBe(22);
    expect(graphBubbleRadius(Infinity, 10_000)).toBe(0);
  });
});
