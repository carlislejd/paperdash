import type { PoolClient } from "pg";
import { PG_QUERY_DEADLINE_MS } from "./pg-deadline.js";

/** The held session must prove it is alive; a silent partition is lease loss. */
export function monitorPgLease(
  client: PoolClient,
  onLost: (error: Error) => void,
  options: { intervalMs?: number; deadlineMs?: number } = {},
): () => void {
  let stopped = false;
  let failed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const lost = (error: Error) => {
    if (stopped || failed) return;
    failed = true;
    clearTimeout(timer);
    clearTimeout(deadline);
    // The caller must fail-stop, not drain writes after ownership becomes
    // uncertain. Keep listeners until normal cleanup so late errors are handled.
    onLost(error);
  };
  const ended = () => lost(new Error("Collector lease session ended."));
  const schedule = () => {
    if (!stopped && !failed)
      timer = setTimeout(() => void heartbeat(), options.intervalMs ?? 5000);
  };
  const heartbeat = async () => {
    if (stopped || failed) return;
    deadline = setTimeout(
      () => lost(new Error("Collector lease heartbeat deadline exceeded.")),
      options.deadlineMs ?? PG_QUERY_DEADLINE_MS,
    );
    try {
      await client.query("SELECT 1");
    } catch (error) {
      lost(
        error instanceof Error
          ? error
          : new Error("Collector lease heartbeat failed."),
      );
    } finally {
      clearTimeout(deadline);
      schedule();
    }
  };
  client.on("error", lost);
  client.on("end", ended);
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(deadline);
    client.removeListener("error", lost);
    client.removeListener("end", ended);
  };
}
