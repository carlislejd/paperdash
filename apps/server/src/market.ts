import type {
  AssetMarketResponse,
  MarketTradeSample,
  MarketWindow,
  MarketSegment,
  MarketMinPnlUsd,
} from "../../../packages/shared/src/types.js";
import { marketMinPnlUsd } from "../../../packages/shared/src/types.js";
import { visibleTrades, type Store } from "./store.js";
import { activityDelayed } from "./activity-health.js";
import { PROFITABLE_SNAPSHOT_MAX_AGE_MS } from "./market-store.js";

export const marketSymbols = ["BTC", "ETH"] as const;
interface SavedMarket extends AssetMarketResponse {
  chartSamples?: Record<MarketWindow, MarketTradeSample>;
}
const snapshotKey = (
  instrument: number,
  segment: MarketSegment,
  minPnlUsd: MarketMinPnlUsd,
) =>
  `market:${instrument}${segment === "profitable" ? `:profitable${minPnlUsd > 0 ? `:min-pnl:${minPnlUsd}` : ""}` : ""}`;
export async function refreshMarkets(store: Store, now = Date.now()) {
  for (const [instrument, symbol] of marketSymbols.entries()) {
    const data = await store.market.read(instrument, now);
    const visible = visibleTrades(data.rawTrades, 201);
    const response: SavedMarket = {
      segment: "all",
      instrument,
      symbol,
      price: data.price,
      points: data.points,
      trades: visible.slice(0, 200),
      chartSamples: data.chartSamples,
      windowFrom: Math.max(0, now - 3600000),
      windowTo: now,
      receivedAt: now,
      stale: !data.price || now - data.price.sourceAt > 30000,
      coverage: {
        source: "retained-market-observations",
        observedFrom: data.observedFrom,
        partial: true,
        tradesCapped: data.tradesCapped || visible.length > 200,
      },
    };
    await store.put(`market:${instrument}`, response, now);
    for (const minPnlUsd of marketMinPnlUsd) {
      const cohort = data.profitableByMinPnl[minPnlUsd];
      const profitable = visibleTrades(cohort.rawTrades, 201);
      await store.put(
        snapshotKey(instrument, "profitable", minPnlUsd),
        {
          ...response,
          segment: "profitable",
          segmentCoverage: cohort.coverage,
          trades: profitable.slice(0, 200),
          chartSamples: cohort.chartSamples,
          coverage: {
            ...response.coverage,
            tradesCapped: cohort.tradesCapped || profitable.length > 200,
          },
        },
        now,
      );
    }
  }
}
export async function readMarket(
  store: Store,
  instrument: number,
  now = Date.now(),
  window: MarketWindow = "1h",
  segment: MarketSegment = "all",
  minPnlUsd: MarketMinPnlUsd = 0,
): Promise<AssetMarketResponse> {
  if (
    !Number.isInteger(instrument) ||
    instrument < 0 ||
    instrument >= marketSymbols.length ||
    !["5m", "15m", "1h"].includes(window) ||
    !["all", "profitable"].includes(segment) ||
    !marketMinPnlUsd.includes(minPnlUsd) ||
    (segment === "all" && minPnlUsd !== 0)
  )
    throw new Error("Unknown market instrument");
  const [saved, connection, tradesDelayed, heartbeat] = await Promise.all([
    store.get<SavedMarket>(snapshotKey(instrument, segment, minPnlUsd)),
    store.get<{ connected: boolean }>("market-connection"),
    activityDelayed(store, now),
    store.get<{ errors?: Record<string, string> }>("collector-heartbeat"),
  ]);
  if (saved) {
    const { chartSamples, ...value } = saved.value;
    // A stopped collector must not turn an indefinitely old classification into
    // a current profitable cohort. Price data may remain available separately.
    const classification = value.segmentCoverage;
    const classificationExpired =
      segment === "profitable" &&
      (value.segment !== "profitable" ||
        !classification ||
        classification.basis !== "positive-lifetime-realized-trading-pnl" ||
        (classification.minPnlUsd ?? 0) !== minPnlUsd ||
        !Number.isSafeInteger(classification.classifiedAt) ||
        classification.classifiedAt > now ||
        now - classification.classifiedAt > PROFITABLE_SNAPSHOT_MAX_AGE_MS);
    return {
      ...value,
      segment,
      ...(classificationExpired
        ? { trades: [], segmentCoverage: undefined, chartSample: undefined }
        : chartSamples?.[window]
          ? { chartSample: chartSamples[window] }
          : {}),
      stale:
        classificationExpired ||
        saved.value.stale ||
        now - saved.receivedAt > 15000 ||
        !connection?.value.connected ||
        tradesDelayed ||
        Boolean(
          heartbeat?.value.errors?.["asset-live"] ||
            heartbeat?.value.errors?.["market-quotes"],
        ) ||
        !saved.value.price ||
        now - saved.value.price.sourceAt > 30000,
    };
  }
  return {
    segment,
    instrument,
    symbol: marketSymbols[instrument],
    price: null,
    points: [],
    trades: [],
    windowFrom: Math.max(0, now - 3600000),
    windowTo: now,
    receivedAt: now,
    stale: true,
    coverage: {
      source: "retained-market-observations",
      observedFrom: null,
      partial: true,
      tradesCapped: false,
    },
  };
}
