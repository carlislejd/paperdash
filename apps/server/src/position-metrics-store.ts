import { rollbackPg } from "./pg-deadline.js";
import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import { addressSchema } from "./schemas.js";

export interface PositionMetrics {
  positionCount: number;
  avgHoldMs: number | null;
  avgLeverage: number | null;
  excludedCount: number;
  updatedAt: number | null;
  projectionBackfillComplete: boolean;
  pending: boolean;
}
export interface PositionMetricsStore {
  read(address?: string): Promise<PositionMetrics>;
  /** At most limit legacy keys queued and limit facts projected per tick. */
  tick(limit?: number): Promise<{
    backfilled: number;
    processed: number;
    projectionBackfillComplete: boolean;
    pending: boolean;
  }>;
}

export function positionMetricsSchemaSql(prefix: string, postgres: boolean) {
  const int = postgres ? "bigint" : "INTEGER";
  return `
CREATE TABLE IF NOT EXISTS ${prefix}position_metrics_queue(address TEXT NOT NULL,record_key TEXT NOT NULL,queued_at ${int} NOT NULL,PRIMARY KEY(address,record_key));
CREATE INDEX IF NOT EXISTS ${prefix}position_metrics_queue_due ON ${prefix}position_metrics_queue(queued_at,address,record_key);
CREATE TABLE IF NOT EXISTS ${prefix}position_metrics_facts(address TEXT NOT NULL,record_key TEXT NOT NULL,payload_hash TEXT NOT NULL,ambiguous INTEGER NOT NULL,received_at ${int} NOT NULL,hold_ms TEXT,leverage TEXT,PRIMARY KEY(address,record_key));
CREATE TABLE IF NOT EXISTS ${prefix}position_metrics_rollups(scope TEXT PRIMARY KEY,position_count TEXT NOT NULL,hold_sum TEXT NOT NULL,leverage_sum TEXT NOT NULL,excluded_count TEXT NOT NULL,updated_at ${int} NOT NULL);
CREATE TABLE IF NOT EXISTS ${prefix}position_metrics_state(id INTEGER PRIMARY KEY,cursor_address TEXT NOT NULL,cursor_key TEXT NOT NULL,complete INTEGER NOT NULL);
INSERT INTO ${prefix}position_metrics_state VALUES(1,'','',0) ON CONFLICT(id) DO NOTHING;
CREATE INDEX IF NOT EXISTS ${prefix}history_trades_projection ON ${prefix}history_records(address,record_key) WHERE kind='trades';
`;
}

/** Called after a trade upsert inside the same fenced history transaction.
 * Mark the actual retained version, including when an older incoming row lost
 * the source received_at guard. Existing marks keep their original queue age. */
export function enqueuePositionMetrics(
  prefix: string,
  address: string,
  key: string,
) {
  const queue = `${prefix}position_metrics_queue`;
  return {
    sql: `INSERT INTO ${queue}(address,record_key,queued_at)
      SELECT r.address,r.record_key,r.received_at FROM ${prefix}history_records r
      WHERE r.address=? AND r.kind='trades' AND r.record_key=? AND NOT EXISTS (
        SELECT 1 FROM ${prefix}position_metrics_facts f WHERE f.address=r.address AND f.record_key=r.record_key AND f.payload_hash=r.payload_hash AND f.ambiguous=r.ambiguous AND f.received_at=r.received_at)
      ON CONFLICT(address,record_key) DO UPDATE SET queued_at=CASE WHEN ${queue}.queued_at<excluded.queued_at THEN ${queue}.queued_at ELSE excluded.queued_at END`,
    params: [address, key],
  };
}

type Key = { address: string; record_key: string };
type Source = {
  payload: unknown;
  payload_hash: string;
  ambiguous: number;
  received_at: string | number;
};
type Fact = {
  payload_hash: string;
  ambiguous: number;
  received_at: string | number;
  hold_ms: string | null;
  leverage: string | null;
};
type Rollup = {
  position_count: string;
  hold_sum: string;
  leverage_sum: string;
  excluded_count: string;
  updated_at: string | number;
};
type Checkpoint = {
  cursor_address: string;
  cursor_key: string;
  complete: number;
};
type Contribution = {
  count: bigint;
  hold: bigint;
  leverage: bigint;
  excluded: bigint;
};
const zero: Contribution = { count: 0n, hold: 0n, leverage: 0n, excluded: 0n };
const parsed = (value: unknown): unknown =>
  typeof value === "string" ? JSON.parse(value) : value;
const pgSql = (sql: string) => {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
};
const table = (prefix: string, name: string) =>
  `${prefix}position_metrics_${name}`;
function limitFor(value: number) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("Invalid position projection limit");
  return Math.min(value, 5000);
}
function contribution(fact?: Fact): Contribution {
  if (!fact) return zero;
  return fact.hold_ms !== null && fact.leverage !== null
    ? {
        count: 1n,
        hold: BigInt(fact.hold_ms),
        leverage: BigInt(fact.leverage),
        excluded: 0n,
      }
    : { ...zero, excluded: 1n };
}
function factFrom(source: Source): Fact {
  const value = parsed(source.payload);
  const item =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const { timestampMs: closed, openedAtMs: opened, leverage } = item;
  const receivedAt = Number(source.received_at);
  const valid =
    Number(source.ambiguous) === 0 &&
    (item.kind === "PositionClosed" || item.kind === "Liquidated") &&
    typeof closed === "number" &&
    Number.isSafeInteger(closed) &&
    closed >= 0 &&
    typeof opened === "number" &&
    Number.isSafeInteger(opened) &&
    opened >= 0 &&
    opened <= closed &&
    Number.isSafeInteger(receivedAt) &&
    closed - receivedAt <= 30000 &&
    typeof leverage === "number" &&
    Number.isSafeInteger(leverage) &&
    leverage > 0;
  return {
    payload_hash: source.payload_hash,
    ambiguous: Number(source.ambiguous),
    received_at: source.received_at,
    hold_ms: valid ? (BigInt(closed) - BigInt(opened)).toString() : null,
    leverage: valid ? BigInt(leverage).toString() : null,
  };
}
function deltaBetween(previous?: Fact, next?: Fact): Contribution {
  const before = contribution(previous),
    after = contribution(next);
  return {
    count: after.count - before.count,
    hold: after.hold - before.hold,
    leverage: after.leverage - before.leverage,
    excluded: after.excluded - before.excluded,
  };
}
function nextRollup(prior: Rollup, delta: Contribution, now: number) {
  const values = [
    BigInt(prior.position_count) + delta.count,
    BigInt(prior.hold_sum) + delta.hold,
    BigInt(prior.leverage_sum) + delta.leverage,
    BigInt(prior.excluded_count) + delta.excluded,
  ];
  if (values.some((value) => value < 0n))
    throw new Error("Position metrics contribution is inconsistent");
  return [...values.map(String), now];
}
function average(total: string, count: string): number | null {
  const n = BigInt(count);
  return n === 0n
    ? null
    : Number(BigInt(total) / n) + Number(BigInt(total) % n) / Number(n);
}
interface ReadDb {
  prefix: string;
  rows<T>(sql: string, params?: (string | number)[]): Promise<T[]>;
}
function reader(db: ReadDb): PositionMetricsStore["read"] {
  return async (address) => {
    const wallet =
      address === undefined ? undefined : addressSchema.parse(address);
    const [rows, checkpoints, queued] = await Promise.all([
      db.rows<Rollup>(
        `SELECT * FROM ${table(db.prefix, "rollups")} WHERE scope=?`,
        [wallet ? `wallet:${wallet}` : "global"],
      ),
      db.rows<Checkpoint>(
        `SELECT * FROM ${table(db.prefix, "state")} WHERE id=1`,
      ),
      db.rows(
        `SELECT 1 FROM ${table(db.prefix, "queue")} ${wallet ? "WHERE address=?" : ""} LIMIT 1`,
        wallet ? [wallet] : [],
      ),
    ]);
    const row = rows[0],
      complete = Number(checkpoints[0]?.complete) === 1;
    return {
      positionCount: row ? Number(row.position_count) : 0,
      avgHoldMs: row ? average(row.hold_sum, row.position_count) : null,
      avgLeverage: row ? average(row.leverage_sum, row.position_count) : null,
      excludedCount: row ? Number(row.excluded_count) : 0,
      updatedAt: row ? Number(row.updated_at) : null,
      projectionBackfillComplete: complete,
      pending: !complete || queued.length > 0,
    };
  };
}
const nextLegacy = (prefix: string) =>
  `SELECT address,record_key FROM ${prefix}history_records WHERE kind='trades' AND (address,record_key)>(?,?) ORDER BY address,record_key LIMIT 1`;
const loadSource = (prefix: string) =>
  `SELECT payload,payload_hash,ambiguous,received_at FROM ${prefix}history_records WHERE address=? AND kind='trades' AND record_key=?`;
const putFact = (prefix: string) =>
  `INSERT INTO ${table(prefix, "facts")} VALUES(?,?,?,?,?,?,?) ON CONFLICT(address,record_key) DO UPDATE SET payload_hash=excluded.payload_hash,ambiguous=excluded.ambiguous,received_at=excluded.received_at,hold_ms=excluded.hold_ms,leverage=excluded.leverage`;
const factValues = (key: Key, fact: Fact) => [
  key.address,
  key.record_key,
  fact.payload_hash,
  fact.ambiguous,
  fact.received_at,
  fact.hold_ms,
  fact.leverage,
];

async function projectPg(client: PoolClient, key: Key) {
  const prefix = "paperdash_",
    params = [key.address, key.record_key];
  // The queue is locked, not the source row: producers lock history_records
  // before marking this queue. A concurrent producer re-enqueues after commit.
  const source = (await client.query(pgSql(loadSource(prefix)), params))
    .rows[0] as Source | undefined;
  const prior = (
    await client.query(
      `SELECT * FROM ${table(prefix, "facts")} WHERE address=$1 AND record_key=$2 FOR UPDATE`,
      params,
    )
  ).rows[0] as Fact | undefined;
  const next = source ? factFrom(source) : undefined;
  const delta = deltaBetween(prior, next);
  if (Object.values(delta).some((value) => value !== 0n)) {
    // All projectors take the shared/global lock before a wallet lock.
    for (const scope of ["global", `wallet:${key.address}`]) {
      await client.query(
        `INSERT INTO ${table(prefix, "rollups")} VALUES($1,'0','0','0','0',$2) ON CONFLICT(scope) DO NOTHING`,
        [scope, Date.now()],
      );
      const current = (
        await client.query(
          `SELECT * FROM ${table(prefix, "rollups")} WHERE scope=$1 FOR UPDATE`,
          [scope],
        )
      ).rows[0] as Rollup;
      await client.query(
        `UPDATE ${table(prefix, "rollups")} SET position_count=$1,hold_sum=$2,leverage_sum=$3,excluded_count=$4,updated_at=$5 WHERE scope=$6`,
        [...nextRollup(current, delta, Date.now()), scope],
      );
    }
  }
  if (next) await client.query(pgSql(putFact(prefix)), factValues(key, next));
  else
    await client.query(
      `DELETE FROM ${table(prefix, "facts")} WHERE address=$1 AND record_key=$2`,
      params,
    );
  await client.query(
    `DELETE FROM ${table(prefix, "queue")} WHERE address=$1 AND record_key=$2`,
    params,
  );
}
export function createPgPositionMetrics(pool: Pool): PositionMetricsStore {
  const prefix = "paperdash_";
  const read = reader({
    prefix,
    async rows<T>(sql: string, params = []) {
      return (await pool.query(pgSql(sql), params)).rows as T[];
    },
  });
  return {
    read,
    async tick(input = 500) {
      const limit = limitFor(input),
        client = await pool.connect();
      let backfilled = 0,
        processed = 0;
      try {
        // One legacy key plus cursor per transaction also prevents lock-order
        // inversion against a producer marking several keys in a history page.
        for (; backfilled < limit; backfilled++) {
          await client.query("BEGIN");
          const state = (
            await client.query(
              `SELECT * FROM ${table(prefix, "state")} WHERE id=1 FOR UPDATE`,
            )
          ).rows[0] as Checkpoint;
          if (Number(state.complete) === 1) {
            await client.query("COMMIT");
            break;
          }
          const key = (
            await client.query(pgSql(nextLegacy(prefix)), [
              state.cursor_address,
              state.cursor_key,
            ])
          ).rows[0] as Key | undefined;
          if (!key) {
            await client.query(
              `UPDATE ${table(prefix, "state")} SET complete=1 WHERE id=1`,
            );
            await client.query("COMMIT");
            break;
          }
          const mark = enqueuePositionMetrics(
            prefix,
            key.address,
            key.record_key,
          );
          await client.query(pgSql(mark.sql), mark.params);
          await client.query(
            `UPDATE ${table(prefix, "state")} SET cursor_address=$1,cursor_key=$2 WHERE id=1`,
            [key.address, key.record_key],
          );
          await client.query("COMMIT");
        }
        for (; processed < limit; processed++) {
          await client.query("BEGIN");
          const key = (
            await client.query(
              `SELECT address,record_key FROM ${table(prefix, "queue")} ORDER BY queued_at,address,record_key LIMIT 1 FOR UPDATE SKIP LOCKED`,
            )
          ).rows[0] as Key | undefined;
          if (!key) {
            await client.query("COMMIT");
            break;
          }
          await projectPg(client, key);
          await client.query("COMMIT");
        }
      } catch (error) {
        await rollbackPg(client);
        throw error;
      } finally {
        client.release();
      }
      const status = await read();
      return {
        backfilled,
        processed,
        projectionBackfillComplete: status.projectionBackfillComplete,
        pending: status.pending,
      };
    },
  };
}

function projectLocal(db: DatabaseSync, key: Key) {
  const params = [key.address, key.record_key];
  const source = db.prepare(loadSource("")).get(...params) as
    Source | undefined;
  const prior = db
    .prepare(
      "SELECT * FROM position_metrics_facts WHERE address=? AND record_key=?",
    )
    .get(...params) as Fact | undefined;
  const next = source ? factFrom(source) : undefined;
  const delta = deltaBetween(prior, next);
  if (Object.values(delta).some((value) => value !== 0n))
    for (const scope of ["global", `wallet:${key.address}`]) {
      db.prepare(
        "INSERT INTO position_metrics_rollups VALUES(?,'0','0','0','0',?) ON CONFLICT(scope) DO NOTHING",
      ).run(scope, Date.now());
      const current = db
        .prepare("SELECT * FROM position_metrics_rollups WHERE scope=?")
        .get(scope) as Rollup;
      db.prepare(
        "UPDATE position_metrics_rollups SET position_count=?,hold_sum=?,leverage_sum=?,excluded_count=?,updated_at=? WHERE scope=?",
      ).run(...nextRollup(current, delta, Date.now()), scope);
    }
  if (next) db.prepare(putFact("")).run(...factValues(key, next));
  else
    db.prepare(
      "DELETE FROM position_metrics_facts WHERE address=? AND record_key=?",
    ).run(...params);
  db.prepare(
    "DELETE FROM position_metrics_queue WHERE address=? AND record_key=?",
  ).run(...params);
}
export function createLocalPositionMetrics(
  db: DatabaseSync,
  writable: () => Promise<void>,
): PositionMetricsStore {
  const read = reader({
    prefix: "",
    async rows<T>(sql: string, params = []) {
      return db.prepare(sql).all(...params) as T[];
    },
  });
  return {
    read,
    async tick(input = 500) {
      const limit = limitFor(input);
      await writable();
      let backfilled = 0,
        processed = 0;
      // Keep the entire bounded SQLite write synchronous; no await can allow
      // another collector transaction to interleave on this connection.
      db.exec("BEGIN IMMEDIATE");
      try {
        const state = db
          .prepare("SELECT * FROM position_metrics_state WHERE id=1")
          .get() as Checkpoint;
        if (state.complete !== 1) {
          for (; backfilled < limit; backfilled++) {
            const key = db
              .prepare(nextLegacy(""))
              .get(state.cursor_address, state.cursor_key) as Key | undefined;
            if (!key) {
              state.complete = 1;
              break;
            }
            const mark = enqueuePositionMetrics(
              "",
              key.address,
              key.record_key,
            );
            db.prepare(mark.sql).run(...mark.params);
            state.cursor_address = key.address;
            state.cursor_key = key.record_key;
          }
          db.prepare(
            "UPDATE position_metrics_state SET cursor_address=?,cursor_key=?,complete=? WHERE id=1",
          ).run(state.cursor_address, state.cursor_key, state.complete);
        }
        for (; processed < limit; processed++) {
          const key = db
            .prepare(
              "SELECT address,record_key FROM position_metrics_queue ORDER BY queued_at,address,record_key LIMIT 1",
            )
            .get() as Key | undefined;
          if (!key) break;
          projectLocal(db, key);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      const status = await read();
      return {
        backfilled,
        processed,
        projectionBackfillComplete: status.projectionBackfillComplete,
        pending: status.pending,
      };
    },
  };
}
