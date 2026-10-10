import type { Store } from "./store.js";

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
  return (
    !heartbeat ||
    now - heartbeat.value.at > 30000 ||
    Boolean(
      heartbeat.value.errors?.stream ||
        heartbeat.value.errors?.recent ||
        heartbeat.value.errors?.["asset-activity"],
    ) ||
    overview?.value.status.stream !== "connected"
  );
}
