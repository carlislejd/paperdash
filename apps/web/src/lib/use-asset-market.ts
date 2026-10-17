import { useEffect, useMemo, useState } from "react";
import type {
  AssetMarketResponse,
  AssetPricePoint,
  MarketSegment,
  MarketWindow,
  TradeEvent,
} from "../../../../packages/shared/src/types";
import { subscribeLiveEvents } from "./live-events";
import {
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
  trades: TradeEvent[];
  samples: Record<MarketWindow, TradeEvent[]>;
  price: AssetMarketResponse["price"];
};
const emptyLive = (instrument: number): LiveMarket => ({
  instrument,
  points: [],
  trades: [],
  samples: { "5m": [], "15m": [], "1h": [] },
  price: null,
});

export function useAssetMarket(
  instrument: number,
  window: MarketWindow = "15m",
  segment: MarketSegment = "all",
) {
  const snapshot = useAnalytics<AssetMarketResponse>(
    `/api/assets/${instrument}/market?window=${window}${segment === "profitable" ? "&segment=profitable" : ""}`,
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
            samples: Object.fromEntries(
              (Object.keys(MARKET_WINDOWS) as MarketWindow[]).map((range) => [
                range,
                selectMarketSample(
                  current.samples[range],
                  [message.data],
                  instrument,
                  range,
                ),
              ]),
            ) as LiveMarket["samples"],
            trades: mergeMarketTrades(
              current.trades,
              [message.data],
              instrument,
            ),
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
  )
    ? market
    : null;
  const profitable = segment === "profitable";
  const points = useMemo(
    () => mergeMarketPoints(market?.points ?? [], current.points),
    [market, current.points],
  );
  const trades = useMemo(
    () =>
      mergeMarketTrades(
        profitable
          ? (data?.trades ?? []).filter((trade) => trade.kind === "open")
          : (data?.trades ?? []),
        profitable ? [] : current.trades,
        instrument,
      ),
    [data, current.trades, instrument, profitable],
  );
  const chartSample = useMemo(() => {
    const sample = data?.chartSample;
    return validMarketSample(sample, window)
      ? {
          ...sample,
          trades: selectMarketSample(
            profitable
              ? sample.trades.filter((trade) => trade.kind === "open")
              : sample.trades,
            profitable ? [] : current.samples[window],
            instrument,
            window,
          ),
        }
      : undefined;
  }, [data, current.samples, instrument, window, profitable]);
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
    stale: Boolean(snapshot.error) || (market?.stale ?? true),
  };
}
