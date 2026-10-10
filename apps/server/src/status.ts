import { createStore } from "./store.js";
import { addressSchema } from "./schemas.js";
import type { AssetMarketResponse } from "../../../packages/shared/src/types.js";
import type { MarketConnection } from "./market-feed.js";

const store = await createStore({ autoMigrate: false });
try {
  const address = process.argv[2] ? addressSchema.parse(process.argv[2]) : null;
  const [
    heartbeat,
    stream,
    stats,
    jobs,
    positionMetrics,
    marketConnection,
    markets,
  ] = await Promise.all([
    store.get<{ at: number; errors: Record<string, string> }>(
      "collector-heartbeat",
    ),
    store.get("stream-diagnostics"),
    store.history.stats(),
    address ? store.history.getStatus(address) : null,
    store.positionMetrics.read(address ?? undefined),
    store.get<MarketConnection>("market-connection"),
    Promise.all(
      [0, 1].map((instrument) =>
        store.get<AssetMarketResponse>(`market:${instrument}`),
      ),
    ),
  ]);
  const healthy = Boolean(heartbeat && Date.now() - heartbeat.value.at < 30000);
  console.log(
    JSON.stringify(
      {
        persistence: store.kind,
        collectorHealthy: healthy,
        heartbeat: heartbeat?.value ?? null,
        stream: stream?.value ?? null,
        stats,
        positionMetrics,
        marketConnection: marketConnection?.value ?? null,
        markets: markets.map((saved, instrument) =>
          saved
            ? {
                instrument,
                symbol: saved.value.symbol,
                price: saved.value.price?.priceUsd ?? null,
                sourceAt: saved.value.price?.sourceAt ?? null,
                receivedAt: saved.receivedAt,
                points: saved.value.points.length,
                trades: saved.value.trades.length,
                stale:
                  saved.value.stale ||
                  !healthy ||
                  !marketConnection?.value.connected ||
                  Date.now() - saved.receivedAt > 15000 ||
                  !saved.value.price ||
                  Date.now() - saved.value.price.sourceAt > 30000 ||
                  Boolean(
                    heartbeat?.value.errors?.["market-quotes"] ||
                      heartbeat?.value.errors?.["asset-live"] ||
                      heartbeat?.value.errors?.stream ||
                      heartbeat?.value.errors?.recent,
                  ),
              }
            : { instrument, available: false },
        ),
        ...(address ? { address, jobs } : {}),
      },
      null,
      2,
    ),
  );
  if (!healthy) process.exitCode = 1;
} finally {
  await store.close();
}
