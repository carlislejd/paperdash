import { rollbackPg } from "./pg-deadline.js";
import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import { addressSchema } from "./schemas.js";
import { normalizeClosedPosition } from "../../../packages/shared/src/position-details.js";
import type { PositionHighlights } from "../../../packages/shared/src/position-metrics.js";

export interface PositionMetrics {
  positionCount: number;
  avgHoldMs: number | null;
  avgLeverage: number | null;
  excludedCount: number;
  updatedAt: number | null;
  projectionBackfillComplete: boolean;
  pending: boolean;
  /** Internal complete flag covers projection only; response adds history coverage. */
  highlights?: PositionHighlights;
}
export interface RetainedPositionCount {
  /** Recorded close/liquidation rows, including rows excluded from duration averages. */
  recordedCount: number | null;
  indexedAt: number | null;
  backfillComplete: boolean;
  projectionPending: boolean;
  excludedCount: number;
  stale: boolean;
}
export interface PositionMetricsStore {
  read(address?: string): Promise<PositionMetrics>;
  /** Admit a known wallet's retained rows for local projection, without a source fetch. */
  requestWallet(address: string): Promise<void>;
  /** One bounded saved-rollup read for a displayed leaderboard page. */
  readMany(
    addresses: string[],
    now?: number,
  ): Promise<Record<string, RetainedPositionCount>>;
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
INSERT INTO ${prefix}position_metrics_state VALUES(2,'','',0) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS ${prefix}position_metrics_highlights(address TEXT NOT NULL,record_key TEXT NOT NULL,payload_hash TEXT NOT NULL,ambiguous INTEGER NOT NULL,received_at ${int} NOT NULL,pnl_raw TEXT,pnl_sort TEXT ${postgres ? 'COLLATE "C"' : "COLLATE BINARY"},symbol TEXT,position_id TEXT,PRIMARY KEY(address,record_key));
CREATE INDEX IF NOT EXISTS ${prefix}position_metrics_highlight_order ON ${prefix}position_metrics_highlights(address,pnl_sort,record_key) WHERE pnl_sort IS NOT NULL;
CREATE TABLE IF NOT EXISTS ${prefix}position_metrics_highlight_wallets(address TEXT PRIMARY KEY,trade_count TEXT NOT NULL,excluded_count TEXT NOT NULL,updated_at ${int} NOT NULL);
CREATE TABLE IF NOT EXISTS ${prefix}position_metrics_wallet_state(address TEXT PRIMARY KEY,cursor_key TEXT NOT NULL DEFAULT '',complete INTEGER NOT NULL DEFAULT 0,requested_at ${int} NOT NULL,last_served_at ${int} NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS ${prefix}position_metrics_wallet_due ON ${prefix}position_metrics_wallet_state(last_served_at,address) WHERE complete=0;
CREATE INDEX IF NOT EXISTS ${prefix}history_trades_projection ON ${prefix}history_records(address,record_key) WHERE kind='trades';
`;
}

/** Called after a trade upsert inside the same fenced history transaction.
 * Mark the actual retained version, including when an older incoming row lost
 * the source received_at guard. Receipt-only overlap does not change a fact;
 * recheck it only if the canonical timestampMs (history_records.source_at)
 * crosses the same 30-second future-clock boundary used by factFrom.
 * Existing marks must still be touched even if the current fact matches: a
 * projector may hold that mark while applying an intermediate A-to-B-to-A
 * version. Its producer then waits and leaves a fresh mark after commit. */
export function enqueuePositionMetrics(
  prefix: string,
  address: string,
  key: string,
) {
  const queue = `${prefix}position_metrics_queue`;
  return {
    sql: `INSERT INTO ${queue}(address,record_key,queued_at)
      SELECT r.address,r.record_key,r.received_at FROM ${prefix}history_records r
      WHERE r.address=? AND r.kind='trades' AND r.record_key=? AND (
        EXISTS (SELECT 1 FROM ${queue} q WHERE q.address=r.address AND q.record_key=r.record_key)
        OR NOT EXISTS (
          SELECT 1 FROM ${prefix}position_metrics_facts f WHERE f.address=r.address AND f.record_key=r.record_key AND f.payload_hash=r.payload_hash AND f.ambiguous=r.ambiguous
            AND (r.source_at<=f.received_at+30000)=(r.source_at<=r.received_at+30000))
        OR NOT EXISTS (
          SELECT 1 FROM ${prefix}position_metrics_highlights h WHERE h.address=r.address AND h.record_key=r.record_key AND h.payload_hash=r.payload_hash AND h.ambiguous=r.ambiguous
            AND (r.source_at<=h.received_at+30000)=(r.source_at<=r.received_at+30000)))
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
  source_at: string | number;
};
type Fact = {
  payload_hash: string;
  ambiguous: number;
  received_at: string | number;
  hold_ms: string | null;
  leverage: string | null;
};
type HighlightFact = Omit<Fact, "hold_ms" | "leverage"> & {
  pnl_raw: string | null;
  pnl_sort: string | null;
  symbol: string | null;
  position_id: string | null;
};
type HighlightWallet = {
  trade_count: string;
  excluded_count: string;
  updated_at: number | string;
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

function highlightFrom(key: Key, source: Source): HighlightFact {
  const receivedAt = Number(source.received_at);
  const position = normalizeClosedPosition(parsed(source.payload), {
    walletAddress: key.address,
    receivedAt,
    asOf: receivedAt,
    identityAmbiguous: Number(source.ambiguous) !== 0,
  });
  // Missing/invalid hold or leverage does not hide an otherwise valid outcome.
  const valid =
    Number(source.ambiguous) === 0 &&
    position !== null &&
    position.closedAt !== null &&
    position.closedAt - receivedAt <= 30000 &&
    position.adjustedPnlRaw !== null;
  const pnl = valid ? position.adjustedPnlRaw : null;
  return {
    payload_hash: source.payload_hash,
    ambiguous: Number(source.ambiguous),
    received_at: source.received_at,
    pnl_raw: pnl,
    // Offset signed int256 into uint256, then fixed-width ASCII decimal. The
    // binary/C-collated index orders every raw wei exactly, without float casts.
    pnl_sort:
      pnl === null
        ? null
        : (BigInt(pnl) + (1n << 255n)).toString().padStart(78, "0"),
    symbol: valid ? position.symbol : null,
    position_id: valid ? position.positionId : null,
  };
}
function highlightDelta(previous?: HighlightFact, next?: HighlightFact) {
  const count = (fact?: HighlightFact) =>
    fact?.pnl_sort !== null && fact !== undefined ? 1n : 0n;
  const excluded = (fact?: HighlightFact) =>
    fact?.pnl_sort === null ? 1n : 0n;
  return {
    count: count(next) - count(previous),
    excluded: excluded(next) - excluded(previous),
  };
}
function sameAppliedVersion(
  prior: Fact | HighlightFact | undefined,
  source: Source,
) {
  return (
    prior !== undefined &&
    prior.payload_hash === source.payload_hash &&
    Number(prior.ambiguous) === Number(source.ambiguous) &&
    Number(source.source_at) <= Number(prior.received_at) + 30000 ===
      Number(source.source_at) <= Number(source.received_at) + 30000
  );
}
function nextHighlightWallet(
  previous: HighlightWallet,
  delta: ReturnType<typeof highlightDelta>,
  now: number,
) {
  const count = BigInt(previous.trade_count) + delta.count;
  const excluded = BigInt(previous.excluded_count) + delta.excluded;
  if (count < 0n || excluded < 0n)
    throw new Error("Position highlights contribution is inconsistent");
  return [count.toString(), excluded.toString(), now];
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
async function readHighlights(
  db: ReadDb,
  wallet: string,
): Promise<PositionHighlights> {
  type Row = HighlightWallet & {
    complete: number;
    queued: boolean | number;
    best_pnl: string | null;
    best_symbol: string | null;
    best_id: string | null;
    worst_pnl: string | null;
    worst_symbol: string | null;
    worst_id: string | null;
  };
  // One consistent database snapshot; both extrema use the wallet/order index.
  const [row] = await db.rows<Row>(
    `WITH best AS (
      SELECT pnl_raw,symbol,position_id FROM ${table(db.prefix, "highlights")}
      WHERE address=? AND pnl_sort IS NOT NULL ORDER BY pnl_sort DESC,record_key DESC LIMIT 1
    ), worst AS (
      SELECT pnl_raw,symbol,position_id FROM ${table(db.prefix, "highlights")}
      WHERE address=? AND pnl_sort IS NOT NULL ORDER BY pnl_sort,record_key LIMIT 1
    ) SELECT w.trade_count,w.excluded_count,CASE WHEN s.complete=1 OR local.complete=1 THEN 1 ELSE 0 END AS complete,
      EXISTS(SELECT 1 FROM ${table(db.prefix, "queue")} q WHERE q.address=?) AS queued,
      best.pnl_raw AS best_pnl,best.symbol AS best_symbol,best.position_id AS best_id,
      worst.pnl_raw AS worst_pnl,worst.symbol AS worst_symbol,worst.position_id AS worst_id
    FROM ${table(db.prefix, "state")} s
    LEFT JOIN ${table(db.prefix, "highlight_wallets")} w ON w.address=?
    LEFT JOIN ${table(db.prefix, "wallet_state")} local ON local.address=?
    LEFT JOIN best ON 1=1 LEFT JOIN worst ON 1=1 WHERE s.id=2`,
    [wallet, wallet, wallet, wallet, wallet],
  );
  const count = row?.trade_count == null ? null : BigInt(row.trade_count);
  const excluded = BigInt(row?.excluded_count ?? "0");
  const safeCount =
    count === null || (count >= 0n && count <= BigInt(Number.MAX_SAFE_INTEGER));
  return {
    bestTrade:
      row?.best_pnl != null && row.best_id !== null
        ? {
            pnlRaw: row.best_pnl,
            symbol: row.best_symbol,
            positionId: row.best_id,
          }
        : null,
    worstTrade:
      row?.worst_pnl != null && row.worst_id !== null
        ? {
            pnlRaw: row.worst_pnl,
            symbol: row.worst_symbol,
            positionId: row.worst_id,
          }
        : null,
    tradeCount: count !== null && safeCount ? Number(count) : null,
    excludedCount: Number(excluded),
    complete:
      Number(row?.complete) === 1 &&
      !row?.queued &&
      excluded === 0n &&
      safeCount,
  };
}
function reader(db: ReadDb): PositionMetricsStore["read"] {
  return async (address) => {
    const wallet =
      address === undefined ? undefined : addressSchema.parse(address);
    const [rows, checkpoints, queued, highlights] = await Promise.all([
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
      wallet ? readHighlights(db, wallet) : Promise.resolve(undefined),
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
      ...(highlights ? { highlights } : {}),
    };
  };
}
function batchReader(db: ReadDb): PositionMetricsStore["readMany"] {
  return async (input, now = Date.now()) => {
    if (input.length > 25 || !Number.isSafeInteger(now) || now < 0)
      throw new Error("Invalid retained position-count batch");
    const addresses = [
      ...new Set(input.map((address) => addressSchema.parse(address))),
    ];
    if (!addresses.length) return {};
    // All fields share one database snapshot. Each requested address makes
    // indexed lookups only: no history rows are downloaded or counted here.
    const rows = await db.rows<{
      address: string;
      position_count: string | null;
      excluded_count: string | null;
      state: unknown;
      complete: number | null;
      queued: boolean | number;
    }>(
      `WITH requested(address) AS (VALUES ${addresses.map(() => "(?)").join(",")})
      SELECT requested.address,r.position_count,r.excluded_count,j.state,s.complete,
        EXISTS(SELECT 1 FROM ${table(db.prefix, "queue")} q WHERE q.address=requested.address) AS queued
      FROM requested
      LEFT JOIN ${table(db.prefix, "rollups")} r ON r.scope='wallet:'||requested.address
      LEFT JOIN ${db.prefix}history_jobs j ON j.address=requested.address AND j.kind='trades'
      LEFT JOIN ${table(db.prefix, "state")} s ON s.id=1`,
      addresses,
    );
    return Object.fromEntries(
      rows.map((row) => {
        const state = parsed(row.state) as {
          lastSuccessAt?: number | null;
          complete?: boolean;
          cursor?: string | null;
          error?: string;
        } | null;
        const indexedAt =
          typeof state?.lastSuccessAt === "number" &&
          Number.isSafeInteger(state.lastSuccessAt) &&
          state.lastSuccessAt >= 0
            ? state.lastSuccessAt
            : null;
        const projectionPending =
          Number(row.complete) !== 1 || Boolean(row.queued);
        const total =
          BigInt(row.position_count ?? "0") + BigInt(row.excluded_count ?? "0");
        const available =
          total > 0n || (indexedAt !== null && !projectionPending);
        return [
          row.address,
          {
            recordedCount:
              available &&
              total >= 0n &&
              total <= BigInt(Number.MAX_SAFE_INTEGER)
                ? Number(total)
                : null,
            indexedAt,
            backfillComplete: state?.complete === true && state.cursor == null,
            projectionPending,
            excludedCount: Number(row.excluded_count ?? 0),
            stale:
              indexedAt === null ||
              indexedAt > now ||
              now - indexedAt > 300000 ||
              Boolean(state?.error),
          } satisfies RetainedPositionCount,
        ];
      }),
    );
  };
}
const nextLegacy = (prefix: string) =>
  `SELECT address,record_key FROM ${prefix}history_records WHERE kind='trades' AND (address,record_key)>(?,?) ORDER BY address,record_key LIMIT 1`;
const walletRequestEligible = (prefix: string) =>
  `SELECT address FROM ${prefix}history_wallets WHERE address=?
    AND EXISTS(SELECT 1 FROM ${table(prefix, "state")} WHERE id=2 AND complete=0)
    AND NOT EXISTS(SELECT 1 FROM ${table(prefix, "wallet_state")} WHERE address=?)
    AND (SELECT count(*) FROM (SELECT 1 FROM ${table(prefix, "wallet_state")} WHERE complete=0 LIMIT 1000) bounded)<1000`;
const requestWalletSql = (prefix: string) =>
  `INSERT INTO ${table(prefix, "wallet_state")}(address,requested_at)
    SELECT address,? FROM (${walletRequestEligible(prefix)}) eligible
    WHERE 1=1 ON CONFLICT(address) DO NOTHING`;
const nextWallet = (prefix: string, excluded = 0) =>
  `SELECT address FROM ${table(prefix, "wallet_state")} WHERE complete=0
    AND EXISTS(SELECT 1 FROM ${table(prefix, "state")} WHERE id=2 AND complete=0)
    ${excluded ? `AND address NOT IN (${Array(excluded).fill("?").join(",")})` : ""}
    ORDER BY last_served_at,address LIMIT 1`;
const nextWalletKey = (prefix: string) =>
  `SELECT address,record_key FROM ${prefix}history_records WHERE address=? AND kind='trades' AND record_key>? ORDER BY record_key LIMIT 1`;
const completeWallet = (prefix: string) =>
  `UPDATE ${table(prefix, "wallet_state")} SET complete=1 WHERE address=? AND complete=0
    AND NOT EXISTS(SELECT 1 FROM ${prefix}history_records r WHERE r.address=${table(prefix, "wallet_state")}.address AND r.kind='trades' AND r.record_key>${table(prefix, "wallet_state")}.cursor_key)
    AND NOT EXISTS(SELECT 1 FROM ${table(prefix, "queue")} q WHERE q.address=${table(prefix, "wallet_state")}.address)`;
const loadSource = (prefix: string) =>
  `SELECT payload,payload_hash,ambiguous,received_at,source_at FROM ${prefix}history_records WHERE address=? AND kind='trades' AND record_key=?`;
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
const putHighlight = (prefix: string) =>
  `INSERT INTO ${table(prefix, "highlights")} VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(address,record_key) DO UPDATE SET payload_hash=excluded.payload_hash,ambiguous=excluded.ambiguous,received_at=excluded.received_at,pnl_raw=excluded.pnl_raw,pnl_sort=excluded.pnl_sort,symbol=excluded.symbol,position_id=excluded.position_id`;
const highlightValues = (key: Key, fact: HighlightFact) => [
  key.address,
  key.record_key,
  fact.payload_hash,
  fact.ambiguous,
  fact.received_at,
  fact.pnl_raw,
  fact.pnl_sort,
  fact.symbol,
  fact.position_id,
];
const advanceLegacy = (prefix: string) =>
  `UPDATE ${table(prefix, "state")} SET cursor_address=?,cursor_key=? WHERE id=2 OR (id=1 AND complete=0 AND (cursor_address,cursor_key)<(?,?))`;

async function projectHighlightPg(
  client: PoolClient,
  key: Key,
  source?: Source,
) {
  const prefix = "paperdash_",
    params = [key.address, key.record_key];
  const prior = (
    await client.query(
      `SELECT * FROM ${table(prefix, "highlights")} WHERE address=$1 AND record_key=$2 FOR UPDATE`,
      params,
    )
  ).rows[0] as HighlightFact | undefined;
  const next = source ? highlightFrom(key, source) : undefined;
  const delta = highlightDelta(prior, next);
  if (delta.count !== 0n || delta.excluded !== 0n) {
    await client.query(
      `INSERT INTO ${table(prefix, "highlight_wallets")} VALUES($1,'0','0',$2) ON CONFLICT(address) DO NOTHING`,
      [key.address, Date.now()],
    );
    const current = (
      await client.query(
        `SELECT * FROM ${table(prefix, "highlight_wallets")} WHERE address=$1 FOR UPDATE`,
        [key.address],
      )
    ).rows[0] as HighlightWallet;
    await client.query(
      `UPDATE ${table(prefix, "highlight_wallets")} SET trade_count=$1,excluded_count=$2,updated_at=$3 WHERE address=$4`,
      [...nextHighlightWallet(current, delta, Date.now()), key.address],
    );
  }
  if (next && source) {
    if (!sameAppliedVersion(prior, source))
      await client.query(
        pgSql(putHighlight(prefix)),
        highlightValues(key, next),
      );
  } else
    await client.query(
      `DELETE FROM ${table(prefix, "highlights")} WHERE address=$1 AND record_key=$2`,
      params,
    );
}

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
  if (next && source) {
    if (!sameAppliedVersion(prior, source))
      await client.query(pgSql(putFact(prefix)), factValues(key, next));
  } else
    await client.query(
      `DELETE FROM ${table(prefix, "facts")} WHERE address=$1 AND record_key=$2`,
      params,
    );
  await projectHighlightPg(client, key, source);
  await client.query(
    `DELETE FROM ${table(prefix, "queue")} WHERE address=$1 AND record_key=$2`,
    params,
  );
}
export function createPgPositionMetrics(pool: Pool): PositionMetricsStore {
  const prefix = "paperdash_";
  const db: ReadDb = {
    prefix,
    async rows<T>(sql: string, params = []) {
      return (await pool.query(pgSql(sql), params)).rows as T[];
    },
  };
  const read = reader(db);
  return {
    read,
    readMany: batchReader(db),
    async requestWallet(input) {
      const address = addressSchema.parse(input);
      // Already admitted/completed wallets do not write or contend on admission.
      if (
        !(await db.rows(walletRequestEligible(prefix), [address, address]))
          .length
      )
        return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // A short admission lock makes the 1,000-pending-wallet cap exact across APIs.
        await client.query("SELECT pg_advisory_xact_lock(74481236,0)");
        await client.query(pgSql(requestWalletSql(prefix)), [
          Date.now(),
          address,
          address,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await rollbackPg(client);
        throw error;
      } finally {
        client.release();
      }
    },
    async tick(input = 500) {
      const limit = limitFor(input),
        focusedLimit = Math.min(250, Math.floor(limit / 2)),
        client = await pool.connect();
      let backfilled = 0,
        processed = 0;
      try {
        const served: string[] = [];
        while (
          served.length < 8 &&
          (backfilled < focusedLimit || processed < focusedLimit)
        ) {
          let wallet: string | undefined;
          await client.query("BEGIN");
          wallet = (
            await client.query(
              pgSql(
                `${nextWallet(prefix, served.length)} FOR UPDATE SKIP LOCKED`,
              ),
              served,
            )
          ).rows[0]?.address;
          if (wallet)
            await client.query(
              `UPDATE ${table(prefix, "wallet_state")} SET last_served_at=GREATEST(last_served_at+1,$1) WHERE address=$2`,
              [Date.now(), wallet],
            );
          await client.query("COMMIT");
          if (!wallet) break;
          served.push(wallet);
          for (; backfilled < focusedLimit; backfilled++) {
            await client.query("BEGIN");
            const state = (
              await client.query(
                `SELECT cursor_key,complete FROM ${table(prefix, "wallet_state")} WHERE address=$1 FOR UPDATE`,
                [wallet],
              )
            ).rows[0];
            const key =
              Number(state.complete) === 0
                ? ((
                    await client.query(pgSql(nextWalletKey(prefix)), [
                      wallet,
                      state.cursor_key,
                    ])
                  ).rows[0] as Key | undefined)
                : undefined;
            if (!key) {
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
              `UPDATE ${table(prefix, "wallet_state")} SET cursor_key=$1 WHERE address=$2`,
              [key.record_key, wallet],
            );
            await client.query("COMMIT");
          }
          for (; processed < focusedLimit; processed++) {
            await client.query("BEGIN");
            const key = (
              await client.query(
                `SELECT address,record_key FROM ${table(prefix, "queue")} WHERE address=$1 ORDER BY record_key LIMIT 1 FOR UPDATE SKIP LOCKED`,
                [wallet],
              )
            ).rows[0] as Key | undefined;
            if (!key) {
              await client.query("COMMIT");
              break;
            }
            await projectPg(client, key);
            await client.query("COMMIT");
          }
          await client.query(pgSql(completeWallet(prefix)), [wallet]);
        }
        // Version 2 adds highlights over already retained rows. Its own cursor
        // resumes independently; version 1's progress never moves backwards.
        // One key/transaction avoids lock inversion with multi-row producers.
        for (; backfilled < limit; backfilled++) {
          await client.query("BEGIN");
          const state = (
            await client.query(
              `SELECT * FROM ${table(prefix, "state")} WHERE id=2 FOR UPDATE`,
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
              `UPDATE ${table(prefix, "state")} SET complete=1 WHERE id IN (1,2)`,
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
          await client.query(pgSql(advanceLegacy(prefix)), [
            key.address,
            key.record_key,
            key.address,
            key.record_key,
          ]);
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

function projectHighlightLocal(db: DatabaseSync, key: Key, source?: Source) {
  const params = [key.address, key.record_key];
  const prior = db
    .prepare(
      "SELECT * FROM position_metrics_highlights WHERE address=? AND record_key=?",
    )
    .get(...params) as HighlightFact | undefined;
  const next = source ? highlightFrom(key, source) : undefined;
  const delta = highlightDelta(prior, next);
  if (delta.count !== 0n || delta.excluded !== 0n) {
    db.prepare(
      "INSERT INTO position_metrics_highlight_wallets VALUES(?,'0','0',?) ON CONFLICT(address) DO NOTHING",
    ).run(key.address, Date.now());
    const current = db
      .prepare(
        "SELECT * FROM position_metrics_highlight_wallets WHERE address=?",
      )
      .get(key.address) as HighlightWallet;
    db.prepare(
      "UPDATE position_metrics_highlight_wallets SET trade_count=?,excluded_count=?,updated_at=? WHERE address=?",
    ).run(...nextHighlightWallet(current, delta, Date.now()), key.address);
  }
  if (next && source) {
    if (!sameAppliedVersion(prior, source))
      db.prepare(putHighlight("")).run(...highlightValues(key, next));
  } else
    db.prepare(
      "DELETE FROM position_metrics_highlights WHERE address=? AND record_key=?",
    ).run(...params);
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
  if (next && source) {
    if (!sameAppliedVersion(prior, source))
      db.prepare(putFact("")).run(...factValues(key, next));
  } else
    db.prepare(
      "DELETE FROM position_metrics_facts WHERE address=? AND record_key=?",
    ).run(...params);
  projectHighlightLocal(db, key, source);
  db.prepare(
    "DELETE FROM position_metrics_queue WHERE address=? AND record_key=?",
  ).run(...params);
}
export function createLocalPositionMetrics(
  db: DatabaseSync,
  writable: () => Promise<void>,
): PositionMetricsStore {
  const source: ReadDb = {
    prefix: "",
    async rows<T>(sql: string, params = []) {
      return db.prepare(sql).all(...params) as T[];
    },
  };
  const read = reader(source);
  return {
    read,
    readMany: batchReader(source),
    async requestWallet(input) {
      const address = addressSchema.parse(input);
      await writable();
      db.prepare(requestWalletSql("")).run(Date.now(), address, address);
    },
    async tick(input = 500) {
      const limit = limitFor(input),
        focusedLimit = Math.min(250, Math.floor(limit / 2));
      await writable();
      let backfilled = 0,
        processed = 0;
      // Keep the entire bounded SQLite write synchronous; no await can allow
      // another collector transaction to interleave on this connection.
      db.exec("BEGIN IMMEDIATE");
      try {
        const served: string[] = [];
        while (
          served.length < 8 &&
          (backfilled < focusedLimit || processed < focusedLimit)
        ) {
          const wallet = (
            db.prepare(nextWallet("", served.length)).get(...served) as
              { address: string } | undefined
          )?.address;
          if (!wallet) break;
          served.push(wallet);
          db.prepare(
            "UPDATE position_metrics_wallet_state SET last_served_at=MAX(last_served_at+1,?) WHERE address=?",
          ).run(Date.now(), wallet);
          const state = db
            .prepare(
              "SELECT cursor_key FROM position_metrics_wallet_state WHERE address=?",
            )
            .get(wallet) as { cursor_key: string };
          for (; backfilled < focusedLimit; backfilled++) {
            const key = db
              .prepare(nextWalletKey(""))
              .get(wallet, state.cursor_key) as Key | undefined;
            if (!key) break;
            const mark = enqueuePositionMetrics(
              "",
              key.address,
              key.record_key,
            );
            db.prepare(mark.sql).run(...mark.params);
            state.cursor_key = key.record_key;
          }
          db.prepare(
            "UPDATE position_metrics_wallet_state SET cursor_key=? WHERE address=?",
          ).run(state.cursor_key, wallet);
          for (; processed < focusedLimit; processed++) {
            const key = db
              .prepare(
                "SELECT address,record_key FROM position_metrics_queue WHERE address=? ORDER BY record_key LIMIT 1",
              )
              .get(wallet) as Key | undefined;
            if (!key) break;
            projectLocal(db, key);
          }
          db.prepare(completeWallet("")).run(wallet);
        }
        const state = db
          .prepare("SELECT * FROM position_metrics_state WHERE id=2")
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
          db.prepare(advanceLegacy("")).run(
            state.cursor_address,
            state.cursor_key,
            state.cursor_address,
            state.cursor_key,
          );
          if (state.complete === 1)
            db.prepare(
              "UPDATE position_metrics_state SET complete=1 WHERE id IN (1,2)",
            ).run();
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
