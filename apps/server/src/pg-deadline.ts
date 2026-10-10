import { Client, type ClientConfig, type PoolClient } from "pg";

export const PG_QUERY_DEADLINE_MS = 15000;
const retired = new WeakSet<Client>();

/** A timed-out write has an unknown outcome. Never return its session to use. */
export function retirePgClient(client: Client): void {
  if (retired.has(client)) return;
  retired.add(client);
  // end() marks the client as ending before any callbacks can release it. The
  // pool then discards it, and pg rejects outstanding/queued queries on close.
  try {
    void client.end().catch(() => {});
  } finally {
    // Also force closure if a future caller enables pg's pipelined mode.
    client.connection.stream.destroy();
  }
}

function positiveTimeout(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/** Uses pg's read timer, but retires the socket before exposing its timeout. */
export class DeadlinePgClient extends Client {
  override query: Client["query"];

  constructor(
    config?: string | ClientConfig,
    deadlineMs = PG_QUERY_DEADLINE_MS,
  ) {
    super(config);
    const configured =
      typeof config === "object" ? positiveTimeout(config.query_timeout) : null;
    const limit = Math.min(
      positiveTimeout(deadlineMs) ?? PG_QUERY_DEADLINE_MS,
      configured ?? Infinity,
    );
    const nativeQuery = super.query.bind(this) as (
      ...args: unknown[]
    ) => unknown;
    const onError = (error: unknown) => {
      if (error instanceof Error && error.message === "Query read timeout")
        retirePgClient(this);
    };
    const wrap = (callback: (...args: unknown[]) => unknown) =>
      function (this: unknown, ...args: unknown[]) {
        onError(args[0]);
        return callback.apply(this, args);
      };
    this.query = ((...original: unknown[]) => {
      const args = [...original];
      const input = args[0];
      if (
        input &&
        typeof input === "object" &&
        "submit" in input &&
        typeof input.submit === "function"
      ) {
        // No application path uses cursors/custom streams. Their event and row
        // buffering contracts differ, so fail closed instead of weakening the
        // deadline or silently converting an event stream into a callback query.
        throw new Error(
          "Custom streaming PostgreSQL queries are not supported by the bounded client.",
        );
      }
      if (typeof input === "string" || (input && typeof input === "object")) {
        const query =
          typeof input === "string" ? { text: input } : { ...input };
        const supplied =
          "query_timeout" in query
            ? positiveTimeout(query.query_timeout)
            : null;
        Object.assign(query, {
          query_timeout: Math.min(limit, supplied ?? Infinity),
        });
        if ("callback" in query && typeof query.callback === "function") {
          query.callback = wrap(
            query.callback as (...args: unknown[]) => unknown,
          );
        }
        args[0] = query;
      }
      for (const index of [1, 2]) {
        if (typeof args[index] === "function")
          args[index] = wrap(args[index] as (...args: unknown[]) => unknown);
      }
      const result = nativeQuery(...args);
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        return (result as Promise<unknown>).catch((error: unknown) => {
          onError(error);
          throw error;
        });
      }
      return result;
    }) as Client["query"];
  }
}

/** Preserve the triggering error, and never reuse a session after failed cleanup. */
export async function rollbackPg(client: PoolClient): Promise<void> {
  if (retired.has(client)) return;
  try {
    await client.query("ROLLBACK");
  } catch {
    retirePgClient(client);
  }
}
