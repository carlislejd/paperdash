import type { Store } from "./store.js";

export function savedActivityDelayed(
  heartbeat: { at: number; errors?: Record<string, string> } | null | undefined,
  stream: string | undefined,
  now = Date.now(),
): boolean {
  return (
    !heartbeat ||
    now - heartbeat.at > 30000 ||
    heartbeat.at > now + 30000 ||
    Boolean(
      heartbeat.errors?.stream ||
      heartbeat.errors?.recent ||
      heartbeat.errors?.["trade-ingestion"] ||
      heartbeat.errors?.["trade-ingestion-gap"] ||
      heartbeat.errors?.["asset-activity"],
    ) ||
    stream !== "connected"
  );
}

/** Other collector loops can remain healthy while both trade transports fail. */
export async function activityDelayed(
  store: Store,
  now = Date.now(),
): Promise<boolean> {
  const [heartbeat, overview] = await Promise.all([
    store.get<{ at: number; errors?: Record<string, string> }>(
      "collector-heartbeat",
    ),
    store.get<{ status: { stream: string } }>("overview"),
  ]);
  return savedActivityDelayed(
    heartbeat?.value,
    overview?.value.status.stream,
    now,
  );
}
