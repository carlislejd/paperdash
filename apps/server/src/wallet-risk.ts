import type { WalletSnapshot } from "../../../packages/shared/src/types.js";
import {
  buildWalletMarginRisk,
  referencePriceRaw,
  type RiskReference,
  type WalletMarginRiskResponse,
} from "../../../packages/shared/src/margin-risk.js";
import { verifiedPositionInstrument } from "../../../packages/shared/src/position-details.js";
import type { Store } from "./store.js";
import type { Cached } from "./upstream.js";
import { PublicReadCache } from "./public-read-cache.js";

const headCaches = new WeakMap<Pick<Store, "getMany">, PublicReadCache>();
function headsCache(store: Pick<Store, "getMany">) {
  let cache = headCaches.get(store);
  if (!cache) {
    cache = new PublicReadCache({
      ttl: 1000,
      maxEntries: 1,
      maxBytes: 64 * 1024,
      maxPending: 1,
    });
    headCaches.set(store, cache);
  }
  return cache;
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const time = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 8.64e15;
const delayed = (value: unknown, now: number, maxAge: number) =>
  !time(value) || value > now + 30000 || now - value > maxAge;

/** Enrich the same wallet observation already loaded by the profile. This path
 * reads only bounded saved quote heads; it never refreshes a wallet or scans history. */
export async function readWalletMarginRisk(
  store: Pick<Store, "getMany">,
  address: string,
  snapshot: Cached<WalletSnapshot> | null,
  now = Date.now(),
  snapshotError?: string,
  referenceCache?: PublicReadCache,
): Promise<WalletMarginRiskResponse> {
  const context = {
    address,
    asOf: now,
    snapshotReceivedAt: snapshot?.receivedAt ?? null,
    snapshotStale: !snapshot || snapshot.stale || Boolean(snapshot.error),
    error: snapshot?.error ?? snapshotError,
  };
  // Missing positions are unavailable; a genuine empty snapshot needs no quote.
  if (
    !snapshot ||
    (Array.isArray(snapshot.value.openPositions) &&
      snapshot.value.openPositions.length === 0)
  )
    return buildWalletMarginRisk(snapshot?.value ?? null, {
      ...context,
      references: [],
    });
  let saved;
  try {
    saved = await (referenceCache ?? headsCache(store)).read(
      "heads",
      async () => {
        const rows = await store.getMany<unknown>([
          "market:0",
          "market:1",
          "market-connection",
          "collector-heartbeat",
        ]);
        // Discard chart arrays and sampled trades before the shared cache retains anything.
        return Object.fromEntries(
          Object.entries(rows).map(([key, row]) => {
            const value = object(row.value);
            return [
              key,
              {
                receivedAt: row.receivedAt,
                value: key.startsWith("market:")
                  ? { instrument: value?.instrument, price: value?.price }
                  : value,
              },
            ];
          }),
        );
      },
    );
  } catch {
    return buildWalletMarginRisk(snapshot.value, {
      ...context,
      references: [],
      error: context.error ?? "Market references are temporarily unavailable.",
    });
  }
  const connection = object(saved["market-connection"]?.value);
  const heartbeat = object(saved["collector-heartbeat"]?.value);
  const errors = object(heartbeat?.errors);
  const feedDelayed =
    connection?.connected !== true ||
    delayed(heartbeat?.at, now, 30000) ||
    Boolean(errors?.["market-quotes"] || errors?.["asset-live"]);
  const references: RiskReference[] = [];
  for (const instrumentId of [0, 1]) {
    const row = saved[`market:${instrumentId}`];
    const market = object(row?.value);
    const price = object(market?.price);
    if (
      !market ||
      market.instrument !== instrumentId ||
      !price ||
      price.instrument !== instrumentId ||
      typeof price.priceUsd !== "number" ||
      !time(price.sourceAt) ||
      !time(price.receivedAt) ||
      price.sourceAt > now + 30000 ||
      price.receivedAt > now + 30000 ||
      price.sourceAt > price.receivedAt + 30000
    )
      continue;
    const priceRaw = referencePriceRaw(price.priceUsd);
    if (priceRaw === null) continue;
    references.push({
      instrumentId,
      symbol: verifiedPositionInstrument(instrumentId)!.symbol,
      priceUsd: price.priceUsd,
      priceRaw,
      sourceAt: price.sourceAt,
      receivedAt: price.receivedAt,
      stale:
        feedDelayed ||
        delayed(row.receivedAt, now, 15000) ||
        delayed(price.sourceAt, now, 30000) ||
        delayed(price.receivedAt, now, 30000),
      source: "hyperliquid-bbo-mid",
    });
  }
  return buildWalletMarginRisk(snapshot.value, { ...context, references });
}
