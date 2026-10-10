import { setTimeout as delay } from "node:timers/promises";

/** A replacement stays alive while Render drains the previous lease owner. */
export async function waitForCollectorLease(
  collector: { start(): Promise<boolean> },
  signal: AbortSignal,
  options: { intervalMs?: number; onWaiting?: () => void } = {},
): Promise<boolean> {
  let notified = false;
  while (!signal.aborted) {
    const acquired = await collector.start();
    // The caller waits for this function before stopping the collector, so a
    // signal arriving during acquisition cannot race shutdown with startup.
    if (signal.aborted) return false;
    if (acquired) return true;
    if (!notified) {
      options.onWaiting?.();
      notified = true;
    }
    try {
      await delay(options.intervalMs ?? 2000, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
  return false;
}
