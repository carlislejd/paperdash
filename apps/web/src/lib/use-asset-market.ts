import { useEffect, useMemo, useState } from "react";
import type {
  AssetMarketResponse,
  AssetPricePoint,
  TradeEvent,
} from "../../../../packages/shared/src/types";
import { subscribeLiveEvents } from "./live-events";
import {
  mergeMarketPoints,
  mergeMarketTrades,
  validPricePoint,
} from "./market-data";
import { useAnalytics } from "./use-analytics";

type LiveMarket = {
  instrument: number;
  points: AssetPricePoint[];
  trades: TradeEvent[];
  price: AssetMarketResponse["price"];
};
const emptyLive = (instrument: number): LiveMarket => ({
  instrument,
  points: [],
  trades: [],
  price: null,
});

export function useAssetMarket(instrument: number) {
  const snapshot = useAnalytics<AssetMarketResponse>(
    `/api/assets/${instrument}/market`,
  );
  const [live, setLive] = useState<LiveMarket>(() => emptyLive(instrument));

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
  const data = snapshot.data?.instrument === instrument ? snapshot.data : null;
  const points = useMemo(
    () => mergeMarketPoints(data?.points ?? [], current.points),
    [data, current.points],
  );
  const trades = useMemo(
    () => mergeMarketTrades(data?.trades ?? [], current.trades, instrument),
    [data, current.trades, instrument],
  );
  const savedPrice = data?.price ?? null;
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
    price,
    stale: Boolean(snapshot.error) || (data?.stale ?? true),
  };
}
