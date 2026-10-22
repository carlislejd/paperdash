import { useEffect, useMemo, useState } from "react";
import type {
  AssetMarketResponse,
  AssetPricePoint,
  MarketActivity,
  MarketSegment,
  MarketWindow,
  TradeEvent,
} from "../../../../packages/shared/src/types";
import { subscribeLiveEvents } from "./live-events";
import {
  matchesMarketActivity,
  mergeMarketPoints,
  mergeMarketTrades,
  validPricePoint,
} from "./market-data";
import { useAnalytics } from "./use-analytics";
import { acceptsMarketSegment } from "./market-segment";
import {
  MARKET_WINDOWS,
  selectMarketSample,
  validMarketSample,
} from "./market-sample";

type LiveMarket = {
  instrument: number;
  points: AssetPricePoint[];
  activities: Record<MarketActivity, {
    trades: TradeEvent[];
    samples: Record<MarketWindow, TradeEvent[]>;
  }>;
  price: AssetMarketResponse["price"];
};
const emptyLive = (instrument: number): LiveMarket => ({
  instrument,
  points: [],
  activities: {
    all: { trades: [], samples: { "5m": [], "15m": [], "1h": [] } },
    entries: { trades: [], samples: { "5m": [], "15m": [], "1h": [] } },
    exits: { trades: [], samples: { "5m": [], "15m": [], "1h": [] } },
  },
  price: null,
});

export function useAssetMarket(
  instrument: number,
  window: MarketWindow = "15m",
  segment: MarketSegment = "all",
  minPnlUsd = 0,
  activity: MarketActivity = "all",
) {
  const snapshot = useAnalytics<AssetMarketResponse>(
    `/api/assets/${instrument}/market?window=${window}${segment === "profitable" ? `&segment=profitable${minPnlUsd > 0 ? `&minPnl=${minPnlUsd}` : ""}` : ""}&activity=${activity}`,
    { liveAsset: instrument },
  );
  const [live, setLive] = useState<LiveMarket>(() => emptyLive(instrument));
  const [classificationNow, setClassificationNow] = useState(Date.now());
  const classifiedAt = snapshot.data?.segmentCoverage?.classifiedAt;

  useEffect(() => {
    if (segment !== "profitable") return;
    const update = () => {
      if (!document.hidden) setClassificationNow(Date.now());
    };
    update();
    const timer = Number.isSafeInteger(classifiedAt)
      ? setTimeout(update, Math.max(0, classifiedAt! + 60_001 - Date.now()))
      : undefined;
    document.addEventListener("visibilitychange", update);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [segment, classifiedAt]);

  useEffect(() => {
    setLive(emptyLive(instrument));
    return subscribeLiveEvents((message) => {
      if (document.hidden) return;
      if (
        message.type === "asset-price" &&
        message.data.instrument === instrument
      ) {
        const { point, receivedAt } = message.data;
        const now = Date.now();
        if (
          !validPricePoint(point, now) ||
          !Number.isSafeInteger(receivedAt) ||
          receivedAt < 0 ||
          receivedAt > now + 30_000
        )
          return;
        setLive((previous) => {
          const current =
            previous.instrument === instrument
              ? previous
              : emptyLive(instrument);
          if (current.price && point.time < current.price.sourceAt)
            return current;
          return {
            ...current,
            points: mergeMarketPoints(current.points, [point], now),
            price: {
              priceUsd: point.priceUsd,
              sourceAt: point.time,
              receivedAt,
            },
          };
        });
      } else if (
        message.type === "trade" &&
        message.data.instrument === instrument
      ) {
        setLive((previous) => {
          const current =
            previous.instrument === instrument
              ? previous
              : emptyLive(instrument);
          return {
            ...current,
            // Maintain each activity before applying bounds so switching to
            // exits cannot lose them to a burst of larger/newer entries.
            activities: Object.fromEntries(
              (["all", "entries", "exits"] as const).map((cohort) => {
                const previous = current.activities[cohort];
                if (!matchesMarketActivity(message.data, cohort))
                  return [cohort, previous];
                return [cohort, {
                  samples: Object.fromEntries(
                    (Object.keys(MARKET_WINDOWS) as MarketWindow[]).map((range) => [
                      range,
                      selectMarketSample(previous.samples[range], [message.data], instrument, range),
                    ]),
                  ),
                  trades: mergeMarketTrades(previous.trades, [message.data], instrument),
                }];
              }),
            ) as LiveMarket["activities"],
          };
        });
      }
    });
  }, [instrument]);

  const current = live.instrument === instrument ? live : emptyLive(instrument);
  const market = snapshot.data?.instrument === instrument ? snapshot.data : null;
  const data = acceptsMarketSegment(
    market,
    instrument,
    segment,
    Math.max(classificationNow, Date.now()),
    Boolean(snapshot.error),
    minPnlUsd,
    activity,
  )
    ? market
    : null;
  const profitable = segment === "profitable";
  const cohort = current.activities[activity];
  const points = useMemo(
    () => mergeMarketPoints(market?.points ?? [], current.points),
    [market, current.points],
  );
  const trades = useMemo(
    () =>
      mergeMarketTrades(
        (data?.trades ?? []).filter((trade) => matchesMarketActivity(trade, activity)),
        profitable ? [] : cohort.trades,
        instrument,
      ),
    [data, cohort.trades, instrument, profitable, activity],
  );
  const chartSample = useMemo(() => {
    const sample = data?.chartSample;
    return validMarketSample(sample, window)
      ? {
          ...sample,
          trades: selectMarketSample(
            sample.trades,
            profitable ? [] : cohort.samples[window],
            instrument,
            window,
            Date.now(),
            activity,
          ),
        }
      : undefined;
  }, [data, cohort.samples, instrument, window, profitable, activity]);
  const savedPrice = market?.price ?? null;
  const price =
    current.price &&
    (!savedPrice ||
      current.price.sourceAt > savedPrice.sourceAt ||
      (current.price.sourceAt === savedPrice.sourceAt &&
        current.price.receivedAt > savedPrice.receivedAt))
      ? current.price
      : savedPrice;
  return {
    ...snapshot,
    data,
    points,
    trades,
    chartSample,
    segmentCoverage: data?.segmentCoverage,
    segmentUnavailable: profitable && !data,
    price,
    stale: !data || Boolean(snapshot.error) || (market?.stale ?? true),
    freshness: market?.freshness ? {
      ...market.freshness,
      delayed: !data || Boolean(snapshot.error) || market.freshness.delayed,
    } : undefined,
  };
}
