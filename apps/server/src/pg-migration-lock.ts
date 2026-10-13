import type { Client } from "pg";

export const PG_INDEX_MIGRATION_WAIT_MS = 120000;

/** Use an autocommit owner session. A blocking advisory-lock SELECT keeps its
 * virtual transaction alive while waiting; CREATE INDEX CONCURRENTLY can then
 * wait for that same transaction, forming a deadlock. Each failed try below
 * ends its statement before the JavaScript delay, leaving no waiting snapshot.
 * The caller closes its dedicated session in finally, releasing a held lock. */
export async function acquirePgIndexMigrationLock(
  client: Pick<Client, "query">,
  timeoutMs = PG_INDEX_MIGRATION_WAIT_MS,
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error("Invalid index migration lock deadline");
  const deadline = performance.now() + timeoutMs;
  while (true) {
    const remaining = deadline - performance.now();
    if (remaining <= 0)
      throw new Error(
        "Timed out waiting for the concurrent index migration lock",
      );
    // Namespace 74481231: 0=schema transaction, 1=collector, 2=index builds.
    // Bound each attempt by the remaining admission budget too. DeadlinePgClient
    // retires the session on a query timeout, including an unknown lock outcome.
    const attempt = {
      text: "SELECT pg_try_advisory_lock(74481231, 2) AS acquired",
      query_timeout: Math.ceil(remaining),
    };
    const result = await client.query<{ acquired: boolean }>(attempt);
    if (result.rows[0]?.acquired) return;
    const pause = Math.min(100, deadline - performance.now());
    if (pause > 0)
      await new Promise<void>((resolve) => setTimeout(resolve, pause));
  }
}
