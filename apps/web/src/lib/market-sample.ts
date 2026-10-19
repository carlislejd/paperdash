import type {
  MarketActivity,
  MarketTradeSample,
  MarketWindow,
  TradeEvent,
} from "../../../../packages/shared/src/types";
import { matchesMarketActivity, validMarketTrade } from "./market-data";

export const MARKET_WINDOWS: Record<MarketWindow, number> = {
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
};
const priced = (trade: TradeEvent) =>
  Number.isFinite(trade.priceUsd) && trade.priceUsd! > 0;
const largestFirst = (a: TradeEvent, b: TradeEvent) =>
  b.notionalUsd - a.notionalUsd ||
  b.ts - a.ts ||
  (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export function validMarketSample(
  sample: MarketTradeSample | undefined,
  window: MarketWindow,
  now = Date.now(),
): sample is MarketTradeSample {
  return Boolean(
    sample &&
      sample.selection === "largest-notional-per-time-bucket" &&
      sample.partial === true &&
      sample.perBucket === 2 &&
      sample.bucketMs === MARKET_WINDOWS[window] / 30 &&
      Number.isSafeInteger(sample.windowFrom) &&
      sample.windowFrom >= 0 &&
      Number.isSafeInteger(sample.windowTo) &&
      sample.windowTo <= now + 30_000 &&
      sample.windowTo - sample.windowFrom === MARKET_WINDOWS[window] &&
      Array.isArray(sample.trades) &&
      sample.trades.length <= 62,
  );
}

/** A separate bounded cohort; recent-feed limits must never trim its history. */
export function selectMarketSample(
  saved: readonly TradeEvent[],
  live: readonly TradeEvent[],
  instrument: number,
  window: MarketWindow,
  through = Date.now(),
  activity: MarketActivity = "all",
): TradeEvent[] {
  const from = through - MARKET_WINDOWS[window];
  const bucketMs = MARKET_WINDOWS[window] / 30;
  const byId = new Map<string, TradeEvent>();
  for (const trade of [...saved, ...live]) {
    if (
      !validMarketTrade(trade, instrument, through) ||
      !matchesMarketActivity(trade, activity) ||
      trade.ts < from ||
      trade.ts > through ||
      !priced(trade)
    )
      continue;
    byId.set(trade.id, trade);
  }
  const economic = new Map<
    string,
    { stream: TradeEvent[]; recent: TradeEvent[] }
  >();
  for (const trade of byId.values()) {
    const key = JSON.stringify({
      ts: trade.ts,
      wallet: trade.wallet.toLowerCase(),
      instrument: trade.instrument,
      side: trade.side,
      leverage: trade.leverage,
      notionalUsd: trade.notionalUsd,
      kind: trade.kind,
      pnlUsd: trade.pnlUsd,
    });
    const group = economic.get(key) ?? { stream: [], recent: [] };
    // Match the backend's maximum cross-source multiplicity, not a blanket
    // fingerprint dedup: equal events within one source may be distinct fills.
    (trade.provenance === "recent-api" ? group.recent : group.stream).push(
      trade,
    );
    economic.set(key, group);
  }
  const buckets = new Map<number, TradeEvent[]>();
  for (const group of economic.values()) {
    const members =
      group.recent.length >= group.stream.length ? group.recent : group.stream;
    for (const trade of members) {
      const bucket = Math.floor(trade.ts / bucketMs);
      const candidates = buckets.get(bucket) ?? [];
      candidates.push(trade);
      candidates.sort(largestFirst);
      buckets.set(bucket, candidates.slice(0, 2));
    }
  }
  return [...buckets.values()]
    .flat()
    .sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}
