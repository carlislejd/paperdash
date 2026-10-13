import type {
  AssetPricePoint,
  TradeEvent,
} from "../../../../packages/shared/src/types";
import { niceChartAxis } from "./chart-axis";

export type GraphPricePoint = AssetPricePoint & { gapBefore?: boolean };

export const GRAPH_PRICE_LIMIT = 720;
export const GRAPH_TRADE_LIMIT = 120;
export const GRAPH_PRICE_GAP_MS = 30_000;

export function graphPrices(
  samples: readonly GraphPricePoint[],
  from: number,
  through: number,
): GraphPricePoint[] {
  const byTime = new Map<number, GraphPricePoint>();
  for (const point of samples) {
    if (
      Number.isSafeInteger(point.time) &&
      point.time >= 0 &&
      point.time >= from - GRAPH_PRICE_GAP_MS &&
      point.time <= through &&
      Number.isFinite(point.priceUsd) &&
      point.priceUsd > 0
    )
      byTime.set(point.time, {
        ...point,
        ...(point.gapBefore || byTime.get(point.time)?.gapBefore
          ? { gapBefore: true }
          : {}),
      });
  }
  return [...byTime.values()]
    .sort((a, b) => a.time - b.time)
    .slice(-GRAPH_PRICE_LIMIT);
}

export function graphTrades(
  trades: readonly TradeEvent[],
  instrument: number,
  from: number,
  through: number,
): TradeEvent[] {
  const byId = new Map<string, TradeEvent>();
  for (const trade of trades) {
    if (
      trade.instrument === instrument &&
      typeof trade.id === "string" &&
      trade.id.length > 0 &&
      /^0x[0-9a-f]{40}$/i.test(trade.wallet) &&
      Number.isSafeInteger(trade.ts) &&
      trade.ts >= from &&
      trade.ts <= through &&
      Number.isFinite(trade.notionalUsd) &&
      trade.notionalUsd >= 0 &&
      (trade.side === "long" || trade.side === "short") &&
      (trade.kind === "open" || trade.kind === "close" || trade.kind === "liq")
    )
      byId.set(trade.id, trade);
  }
  return [...byId.values()]
    .sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id))
    .slice(0, GRAPH_TRADE_LIMIT);
}

export function graphExecutionPrice(
  trade: TradeEvent & { priceUsd?: number | null },
): number | null {
  return typeof trade.priceUsd === "number" &&
    Number.isFinite(trade.priceUsd) &&
    trade.priceUsd > 0
    ? trade.priceUsd
    : null;
}

export function graphBubbleRadius(notional: number, largest: number): number {
  if (!Number.isFinite(notional) || notional <= 0) return 0;
  if (!Number.isFinite(largest) || largest <= 0) return 0;
  return Math.max(4, 22 * Math.sqrt(Math.min(notional / largest, 1)));
}

export function graphPriceAxis(points: readonly GraphPricePoint[]) {
  let low = Infinity;
  let high = -Infinity;
  for (const point of points) {
    if (!Number.isFinite(point.priceUsd) || point.priceUsd <= 0) continue;
    low = Math.min(low, point.priceUsd);
    high = Math.max(high, point.priceUsd);
  }
  if (!Number.isFinite(low)) return null;
  return niceChartAxis(low, high, {
    tickCount: 5,
    padding: 0.16,
    flatPadding: 0.00015,
    minPadding: 0.01,
    nonnegative: true,
  });
}

export function graphPricePath(
  points: readonly GraphPricePoint[],
  x: (time: number) => number,
  y: (price: number) => number,
): string {
  return points
    .map(
      (point, index) =>
        `${index === 0 || point.gapBefore || point.time - points[index - 1].time > GRAPH_PRICE_GAP_MS ? "M" : "L"}${x(point.time).toFixed(2)},${y(point.priceUsd).toFixed(2)}`,
    )
    .join(" ");
}
