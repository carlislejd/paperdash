import type {
  AssetMarketResponse,
  MarketTradeSample,
  MarketWindow,
  MarketSegment,
  MarketMinPnlUsd,
  MarketActivity,
} from "../../../packages/shared/src/types.js";
import { marketMinPnlUsd } from "../../../packages/shared/src/types.js";
import { visibleTrades, type Store } from "./store.js";
import { activityHealth } from "./activity-health.js";
import { PROFITABLE_SNAPSHOT_MAX_AGE_MS, type MarketActivityData, type ProfitableMarketData } from "./market-store.js";

export const marketSymbols = ["BTC", "ETH"] as const;
interface ActivityView {
  activity: MarketActivity;
  trades: AssetMarketResponse["trades"];
  chartSamples: Record<MarketWindow, MarketTradeSample>;
  segmentCoverage?: AssetMarketResponse["segmentCoverage"];
  tradesCapped: boolean;
}
interface SavedMarket extends AssetMarketResponse {
  chartSamples?: Record<MarketWindow, MarketTradeSample>;
  /** Bounded variants share the same saved price history and publication. */
  activityViews?: Record<MarketActivity, ActivityView | null>;
  /** Version 1 permits null only for the activity already stored by legacy fields. */
  activityViewsVersion?: 1;
}
function activityViews(
  activities: Record<MarketActivity, MarketActivityData>,
  minPnlUsd?: MarketMinPnlUsd,
): Record<MarketActivity, ActivityView | null> {
  const legacyActivity = minPnlUsd === undefined ? "all" : "entries";
  return Object.fromEntries(Object.entries(activities).map(([activity, data]) => {
    if (activity === legacyActivity) return [activity, null];
    const cohort = minPnlUsd === undefined ? data : data.profitableByMinPnl[minPnlUsd];
    const trades = visibleTrades(cohort.rawTrades, 201);
    return [activity, {
      activity, trades: trades.slice(0, 200), chartSamples: cohort.chartSamples,
      tradesCapped: cohort.tradesCapped || trades.length > 200,
      ...(minPnlUsd === undefined ? {} : { segmentCoverage: (cohort as ProfitableMarketData).coverage }),
    }];
  })) as Record<MarketActivity, ActivityView | null>;
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
      activityViews: activityViews(data.activities),
      activityViewsVersion: 1,
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
          activityViews: activityViews(data.activities, minPnlUsd),
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
  activity?: MarketActivity,
): Promise<AssetMarketResponse> {
  if (
    !Number.isInteger(instrument) ||
    instrument < 0 ||
    instrument >= marketSymbols.length ||
    !["5m", "15m", "1h"].includes(window) ||
    !["all", "profitable"].includes(segment) ||
    !marketMinPnlUsd.includes(minPnlUsd) ||
    (segment === "all" && minPnlUsd !== 0) ||
    (activity !== undefined && !["all", "entries", "exits"].includes(activity))
  )
    throw new Error("Unknown market instrument");
  const [saved, connection, tradeHealth, heartbeat] = await Promise.all([
    store.get<SavedMarket>(snapshotKey(instrument, segment, minPnlUsd)),
    store.get<{ connected: boolean }>("market-connection"),
    activityHealth(store, now),
    store.get<{ errors?: Record<string, string> }>("collector-heartbeat"),
  ]);
  if (saved) {
    const { chartSamples: legacySamples, activityViews, activityViewsVersion, ...legacyValue } = saved.value;
    const encodedView = activity === undefined ? undefined : activityViews?.[activity];
    const legacyActivity = segment === "all" ? "all" : "entries";
    // Null is an explicit versioned reference, never a fallback for missing or
    // malformed metadata. Fully nested pre-reference snapshots remain readable.
    const view = encodedView === null && activityViewsVersion === 1 &&
      activity === legacyActivity && legacySamples
      ? {
        activity, trades: legacyValue.trades, chartSamples: legacySamples,
        tradesCapped: legacyValue.coverage.tradesCapped,
        segmentCoverage: legacyValue.segmentCoverage ? { ...legacyValue.segmentCoverage, activity } : undefined,
      } : encodedView ?? undefined;
    const activityUnavailable = activity !== undefined && view?.activity !== activity;
    const value = activity === undefined ? legacyValue : {
      ...legacyValue, activity,
      trades: activityUnavailable ? [] : view!.trades,
      segmentCoverage: activityUnavailable ? undefined : view!.segmentCoverage,
      coverage: { ...legacyValue.coverage, tradesCapped: view?.tradesCapped ?? false },
    };
    const chartSamples = activity === undefined ? legacySamples : activityUnavailable ? undefined : view?.chartSamples;
    // A stopped collector must not turn an indefinitely old classification into
    // a current profitable cohort. Price data may remain available separately.
    const classification = value.segmentCoverage;
    const classificationExpired =
      segment === "profitable" &&
      (value.segment !== "profitable" ||
        !classification ||
        classification.basis !== "positive-lifetime-realized-trading-pnl" ||
        (classification.minPnlUsd ?? 0) !== minPnlUsd ||
        (activity !== undefined && classification.activity !== activity) ||
        !Number.isSafeInteger(classification.classifiedAt) ||
        classification.classifiedAt > now ||
        now - classification.classifiedAt > PROFITABLE_SNAPSHOT_MAX_AGE_MS);
    const validClock = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= now + 30000;
    const delayed =
      activityUnavailable ||
      classificationExpired ||
      saved.value.stale ||
      !validClock(saved.receivedAt) ||
      now - saved.receivedAt > 15000 ||
      !connection?.value.connected ||
      tradeHealth.delayed ||
      Boolean(
        heartbeat?.value.errors?.["asset-live"] ||
          heartbeat?.value.errors?.["market-quotes"],
      ) ||
      !saved.value.price ||
      !validClock(saved.value.price.sourceAt) ||
      !validClock(saved.value.price.receivedAt) ||
      now - saved.value.price.sourceAt > 30000 ||
      now - saved.value.price.receivedAt > 30000;
    return {
      ...value,
      segment,
      ...(classificationExpired
        ? { trades: [], segmentCoverage: undefined, chartSample: undefined }
        : chartSamples?.[window]
          ? { chartSample: chartSamples[window] }
          : {}),
      stale: delayed || tradeHealth.historyGap,
      freshness: { delayed, historyGap: tradeHealth.historyGap },
    };
  }
  return {
    segment,
    ...(activity === undefined ? {} : { activity }),
    instrument,
    symbol: marketSymbols[instrument],
    price: null,
    points: [],
    trades: [],
    windowFrom: Math.max(0, now - 3600000),
    windowTo: now,
    receivedAt: now,
    stale: true,
    freshness: { delayed: true, historyGap: tradeHealth.historyGap },
    coverage: {
      source: "retained-market-observations",
      observedFrom: null,
      partial: true,
      tradesCapped: false,
    },
  };
}
