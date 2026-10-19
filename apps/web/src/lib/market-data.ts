import type {
  AssetPricePoint,
  MarketActivity,
  TradeEvent,
} from "../../../../packages/shared/src/types";

export const MARKET_WINDOW_MS = 3_600_000;
const PRICE_BUCKET_MS = 5_000;

export function matchesMarketActivity(trade: TradeEvent, activity: MarketActivity) {
  return activity === "entries"
    ? trade.kind === "open"
    : activity === "exits"
      ? trade.kind === "close" || trade.kind === "liq"
      : ["open", "close", "liq"].includes(trade.kind);
}

export function validMarketTrade(
  trade: TradeEvent,
  instrument: number,
  now: number,
) {
  return Boolean(
    trade &&
      trade.instrument === instrument &&
      typeof trade.id === "string" &&
      trade.id.length > 0 &&
      trade.id.length <= 300 &&
      Number.isSafeInteger(trade.ts) &&
      trade.ts >= Math.max(0, now - MARKET_WINDOW_MS) &&
      trade.ts <= now + 30_000 &&
      /^0x[0-9a-f]{40}$/i.test(trade.wallet) &&
      Number.isFinite(trade.notionalUsd) &&
      trade.notionalUsd >= 0 &&
      Number.isFinite(trade.leverage) &&
      trade.leverage > 0 &&
      ["long", "short"].includes(trade.side) &&
      ["open", "close", "liq"].includes(trade.kind),
  );
}

export function validPricePoint(point: AssetPricePoint, now: number) {
  return (
    point &&
    Number.isSafeInteger(point.time) &&
    point.time >= 0 &&
    point.time <= now + 30_000 &&
    Number.isFinite(point.priceUsd) &&
    point.priceUsd > 0
  );
}

export function mergeMarketPoints(
  saved: AssetPricePoint[],
  live: AssetPricePoint[],
  now = Date.now(),
): AssetPricePoint[] {
  const buckets = new Map<number, AssetPricePoint>();
  for (const point of [...saved, ...live]) {
    if (!validPricePoint(point, now) || point.time < now - MARKET_WINDOW_MS)
      continue;
    const key = Math.floor(point.time / PRICE_BUCKET_MS);
    const previous = buckets.get(key);
    if (!previous || point.time >= previous.time)
      buckets.set(key, {
        ...point,
        ...(previous?.gapBefore || point.gapBefore ? { gapBefore: true } : {}),
      });
    else if (point.gapBefore && !previous.gapBefore)
      buckets.set(key, { ...previous, gapBefore: true });
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time).slice(-720);
}

export function mergeMarketTrades(
  saved: TradeEvent[],
  live: TradeEvent[],
  instrument: number,
  now = Date.now(),
): TradeEvent[] {
  const trades = new Map<string, TradeEvent>();
  for (const trade of [...saved, ...live]) {
    if (!validMarketTrade(trade, instrument, now)) continue;
    const previous = trades.get(trade.id);
    // A poll can still contain the original unpriced record when a live
    // observation has already supplied its execution price.
    const priceUsd =
      Number.isFinite(trade.priceUsd) && trade.priceUsd! > 0
        ? trade.priceUsd
        : (previous?.priceUsd ?? null);
    trades.set(trade.id, { ...trade, priceUsd });
  }
  return [...trades.values()]
    .sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id))
    .slice(0, 200);
}
