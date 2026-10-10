import type {
  LiquidationTotals,
  LiquidationsResponse,
} from "../../../packages/shared/src/types.js";
import type { Store } from "./store.js";
import type { LiquidationsStore } from "./liquidations-store.js";

type LiquidationsContext = Store & { liquidations: LiquidationsStore };
const key = (instrument?: number) => `liquidations:${instrument ?? "all"}`;
const zero = (): LiquidationTotals => ({
  count: 0,
  longCount: 0,
  shortCount: 0,
  notionalUsd: 0,
});
function empty(now: number): LiquidationsResponse {
  return {
    items: [],
    nextCursor: null,
    stats: { hour: zero(), day: zero() },
    windowTo: now,
    receivedAt: null,
    stale: true,
    coverage: {
      source: "retained-public-observations",
      partial: true,
      identityAmbiguous: true,
      projectionBackfillComplete: false,
      observedFrom: null,
      latestObservedAt: null,
    },
  };
}
export async function refreshLiquidations(
  store: LiquidationsContext,
  now = Date.now(),
): Promise<void> {
  for (const instrument of [undefined, 0, 1]) {
    const [stats, page] = await Promise.all([
      store.liquidations.stats(instrument, now),
      store.liquidations.page(instrument, undefined, now),
    ]);
    const response: LiquidationsResponse = {
      ...page,
      stats: { hour: stats.hour, day: stats.day },
      windowTo: now,
      receivedAt: now,
      stale: false,
      coverage: stats.coverage,
    };
    await store.put(key(instrument), response, now);
  }
}
export async function readLiquidations(
  store: LiquidationsContext,
  instrument?: number,
  cursor?: string,
  now = Date.now(),
): Promise<LiquidationsResponse> {
  if (instrument !== undefined && ![0, 1].includes(instrument))
    throw new Error("Unknown liquidation instrument");
  const [saved, heartbeat, overview] = await Promise.all([
    store.get<LiquidationsResponse>(key(instrument)),
    store.get<{ at: number; errors?: Record<string, string> }>(
      "collector-heartbeat",
    ),
    store.get<{ status: { stream: string } }>("overview"),
  ]);
  const base = saved?.value ?? empty(now);
  const page = cursor
    ? await store.liquidations.page(instrument, cursor, now)
    : null;
  const errors = heartbeat?.value.errors;
  const delayed =
    !heartbeat ||
    now - heartbeat.value.at > 30000 ||
    heartbeat.value.at > now + 30000 ||
    overview?.value.status.stream !== "connected" ||
    Boolean(errors?.stream || errors?.recent);
  const stale =
    !saved ||
    now - saved.receivedAt > 15000 ||
    saved.receivedAt > now + 30000 ||
    delayed ||
    Boolean(errors?.liquidations || errors?.["liquidations-backfill"]);
  return {
    ...base,
    ...(page ?? {}),
    stale,
    ...(stale
      ? {
          error: saved
            ? "Liquidation observations are delayed."
            : "Waiting for the first liquidation snapshot.",
        }
      : {}),
  };
}
