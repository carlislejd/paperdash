import type { PoolClient } from "pg";

/** Call inside the writer's existing transaction, after its other mutations.
 * bigserial allocation alone does not order commits. Hold this shared lock
 * through COMMIT so a tail reader can safely advance past every visible ID.
 * No writer may acquire domain locks after taking the stream append lock.
 */
export async function appendStreamEventPg(
  client: PoolClient,
  payload: string,
): Promise<string> {
  await client.query("SELECT pg_advisory_xact_lock(74481234,0)");
  const result = await client.query(
    "INSERT INTO paperdash_stream_events(payload) VALUES($1) RETURNING id",
    [payload],
  );
  const id = String(result.rows[0].id);
  // Only replay notifications expire. Durable financial observations remain.
  await client.query(
    "DELETE FROM paperdash_stream_events WHERE id <= $1::bigint - 1000",
    [id],
  );
  return id;
}
