import type { PositionMetricsResponse } from "../../../packages/shared/src/position-metrics.js";
import type { Store } from "./store.js";

/** Reads saved rollups only; a profile visit never downloads or scans history. */
export async function readPositionMetrics(
  store: Store,
  address?: string,
  now = Date.now(),
): Promise<PositionMetricsResponse> {
  const [metrics, heartbeat, jobs, indexing, accounts] = await Promise.all([
    store.positionMetrics.read(address),
    store.get<{ at: number; errors?: Record<string, string> }>(
      "collector-heartbeat",
    ),
    address ? store.history.getStatus(address) : Promise.resolve([]),
    address
      ? Promise.resolve(null)
      : store.get<{ wallets: number }>("indexing-status"),
    address ? Promise.resolve(null) : store.get<number>("account-count"),
  ]);
  const history = jobs.find((job) => job.kind === "trades");
  const highlights = metrics.highlights;
  const historyChecked = typeof history?.state.lastSuccessAt === "number";
  return {
    positionCount: metrics.positionCount,
    avgHoldMs: metrics.avgHoldMs,
    avgLeverage: metrics.avgLeverage,
    excludedCount: metrics.excludedCount,
    updatedAt: metrics.updatedAt,
    stale:
      !heartbeat ||
      now - heartbeat.value.at > 30000 ||
      Boolean(
        heartbeat.value.errors?.["position-metrics"] ||
        heartbeat.value.errors?.["wallet-indexer"],
      ) ||
      Boolean(history?.state.error),
    ...(address && highlights
      ? {
          highlights: {
            ...highlights,
            tradeCount:
              highlights.tradeCount ??
              (historyChecked && highlights.complete ? 0 : null),
            complete:
              highlights.complete &&
              historyChecked &&
              history?.state.complete === true &&
              history.state.cursor == null &&
              !history.state.error,
          },
        }
      : {}),
    coverage: {
      source: "retained-closed-positions",
      projectionBackfillComplete: metrics.projectionBackfillComplete,
      pending: metrics.pending,
      historyBackfillComplete: address
        ? (history?.state.complete ?? false)
        : null,
      lastHistoryIndexedAt: history?.state.lastSuccessAt ?? null,
      walletsDiscovered: indexing?.value.wallets ?? null,
      totalWallets: accounts?.value ?? null,
    },
  };
}
