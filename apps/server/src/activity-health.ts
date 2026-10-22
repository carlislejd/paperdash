import type { Store } from "./store.js";
import type { AssetFreshness } from "../../../packages/shared/src/types.js";

interface ActivityHeartbeat {
  at: number;
  errors?: Record<string, string>;
  tradeIntake?: {
    gap?: { at: number } | null;
    admissionPaused?: boolean;
    retrying?: boolean;
    error?: string | null;
  };
}
export function savedActivityHealth(
  heartbeat: ActivityHeartbeat | null | undefined,
  stream: string | undefined,
  now = Date.now(),
): AssetFreshness {
  const historyGap = Boolean(heartbeat?.errors?.["trade-ingestion-gap"]);
  const gapAt = heartbeat?.tradeIntake?.gap?.at;
  const delayed =
    !heartbeat ||
    !Number.isSafeInteger(heartbeat.at) ||
    heartbeat.at < 0 ||
    now - heartbeat.at > 30000 ||
    heartbeat.at > now + 30000 ||
    Boolean(
      heartbeat.errors?.stream ||
      heartbeat.errors?.recent ||
      heartbeat.errors?.["trade-ingestion"] ||
      heartbeat.errors?.["asset-activity"],
    ) ||
    stream !== "connected" ||
    (historyGap && (
      !Number.isSafeInteger(gapAt) ||
      gapAt! < 0 ||
      now - gapAt! <= 30000 ||
      Boolean(heartbeat?.tradeIntake?.admissionPaused ||
        heartbeat?.tradeIntake?.retrying || heartbeat?.tradeIntake?.error)
    ));
  return {
    delayed,
    historyGap,
  };
}

export function savedActivityDelayed(
  heartbeat: { at: number; errors?: Record<string, string> } | null | undefined,
  stream: string | undefined,
  now = Date.now(),
): boolean {
  const health = savedActivityHealth(heartbeat, stream, now);
  return health.delayed || health.historyGap;
}

/** Other collector loops can remain healthy while both trade transports fail. */
export async function activityHealth(
  store: Store,
  now = Date.now(),
): Promise<AssetFreshness> {
  const [heartbeat, overview] = await Promise.all([
    store.get<ActivityHeartbeat>("collector-heartbeat"),
    store.get<{ status: { stream: string } }>("overview"),
  ]);
  return savedActivityHealth(
    heartbeat?.value,
    overview?.value.status.stream,
    now,
  );
}

export async function activityDelayed(
  store: Store,
  now = Date.now(),
): Promise<boolean> {
  const health = await activityHealth(store, now);
  return health.delayed || health.historyGap;
}
