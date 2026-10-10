import type { AssetMarketResponse } from "../../../packages/shared/src/types.js";
import { visibleTrades, type Store } from "./store.js";
import { activityDelayed } from "./activity-health.js";

export const marketSymbols = ["BTC", "ETH"] as const;
export async function refreshMarkets(store: Store, now = Date.now()) {
  for (const [instrument, symbol] of marketSymbols.entries()) {
    const data = await store.market.read(instrument, now);
    const visible = visibleTrades(data.rawTrades, 201);
    const response: AssetMarketResponse = {
      instrument,
      symbol,
      price: data.price,
      points: data.points,
      trades: visible.slice(0, 200),
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
  }
}
export async function readMarket(
  store: Store,
  instrument: number,
  now = Date.now(),
): Promise<AssetMarketResponse> {
  if (
    !Number.isInteger(instrument) ||
    instrument < 0 ||
    instrument >= marketSymbols.length
  )
    throw new Error("Unknown market instrument");
  const [saved, connection, tradesDelayed, heartbeat] = await Promise.all([
    store.get<AssetMarketResponse>(`market:${instrument}`),
    store.get<{ connected: boolean }>("market-connection"),
    activityDelayed(store, now),
    store.get<{ errors?: Record<string, string> }>("collector-heartbeat"),
  ]);
  if (saved)
    return {
      ...saved.value,
      stale:
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
  return {
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
