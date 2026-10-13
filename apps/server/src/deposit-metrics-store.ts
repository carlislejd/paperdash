import type { DatabaseSync } from "node:sqlite";
import type { Pool } from "pg";
import { DeadlinePgClient, rollbackPg } from "./pg-deadline.js";

const DAY = 86400000;
export interface DepositMetricsRead {
  days: {
    time: number;
    depositVolumeRaw: string;
    depositCount: number;
    firstDepositors: number;
  }[];
  /** Earliest eligible retained deposit, not a promise of complete source history. */
  observedFrom: number | null;
  updatedAt: number | null;
  projectionBackfillComplete: boolean;
  pending: boolean;
  excludedRecords: number;
}
export interface DepositMetricsStore {
  /** UTC day boundaries, inclusive start and exclusive end; at most 366 days. */
  read(fromMs: number, toMs: number): Promise<DepositMetricsRead>;
  tick(limit?: number): Promise<{
    backfilled: number;
    processed: number;
    projectionBackfillComplete: boolean;
    pending: boolean;
  }>;
}
export function depositMetricsSchemaSql(prefix: string, postgres: boolean) {
  const int = postgres ? "bigint" : "INTEGER";
  return `
CREATE TABLE IF NOT EXISTS ${prefix}deposit_metrics_queue(address TEXT NOT NULL,record_key TEXT NOT NULL,queued_at ${int} NOT NULL,PRIMARY KEY(address,record_key));
CREATE INDEX IF NOT EXISTS ${prefix}deposit_metrics_queue_due ON ${prefix}deposit_metrics_queue(queued_at,address,record_key);
CREATE TABLE IF NOT EXISTS ${prefix}deposit_metrics_facts(address TEXT NOT NULL,record_key TEXT NOT NULL,payload_hash TEXT NOT NULL,source_at ${int} NOT NULL,received_at ${int} NOT NULL,amount_raw TEXT,excluded INTEGER NOT NULL,future INTEGER NOT NULL,PRIMARY KEY(address,record_key));
CREATE INDEX IF NOT EXISTS ${prefix}deposit_metrics_wallet_first ON ${prefix}deposit_metrics_facts(address,source_at,record_key) WHERE amount_raw IS NOT NULL;
CREATE INDEX IF NOT EXISTS ${prefix}deposit_metrics_observed_from ON ${prefix}deposit_metrics_facts(source_at) WHERE amount_raw IS NOT NULL;
CREATE TABLE IF NOT EXISTS ${prefix}deposit_metrics_wallets(address TEXT PRIMARY KEY,first_at ${int});
CREATE TABLE IF NOT EXISTS ${prefix}deposit_metrics_days(time ${int} PRIMARY KEY,volume_raw TEXT NOT NULL,deposit_count TEXT NOT NULL,first_depositors TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ${prefix}deposit_metrics_totals(id INTEGER PRIMARY KEY,excluded_count TEXT NOT NULL,updated_at ${int});
INSERT INTO ${prefix}deposit_metrics_totals VALUES(1,'0',NULL) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS ${prefix}deposit_metrics_state(id INTEGER PRIMARY KEY,cursor_address TEXT NOT NULL,cursor_key TEXT NOT NULL,complete INTEGER NOT NULL);
INSERT INTO ${prefix}deposit_metrics_state VALUES(1,'','',0) ON CONFLICT(id) DO NOTHING;
${postgres ? "" : `CREATE INDEX IF NOT EXISTS ${prefix}history_cashflows_projection ON ${prefix}history_records(address,record_key) WHERE kind='cashflows';`}
`;
}
const legacyIndex = "paperdash_history_cashflows_projection";
export const depositMetricsIndexStatusSql = `SELECT i.indisvalid AND i.indisready AS valid,
  i.indrelid=to_regclass('paperdash_history_records') AND i.indnatts=2 AND i.indnkeyatts=2
  AND NOT i.indisunique AND i.indexprs IS NULL AND am.amname='btree' AND i.indoption::text='0 0'
  AND pg_get_indexdef(i.indexrelid,1,true)='address'
  AND pg_get_indexdef(i.indexrelid,2,true)='record_key'
  AND pg_get_expr(i.indpred,i.indrelid)='(kind = ''cashflows''::text)' AS expected
  FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam WHERE i.indexrelid=to_regclass('${legacyIndex}')`;
/** Owner-only after the schema transaction; runtime connections only validate
 * the catalog. Share the existing concurrent-index migration advisory lock. */
export async function migratePgDepositMetricsIndexes(
  pool: Pool,
): Promise<void> {
  const client = new DeadlinePgClient(
    {
      ...pool.options,
      connectionTimeoutMillis: 10000,
      statement_timeout: 120000,
      query_timeout: 130000,
    },
    130000,
  );
  client.on("error", () => {});
  try {
    await client.connect();
    await client.query("SELECT pg_advisory_lock(74481231, 2)");
    const current = (await client.query(depositMetricsIndexStatusSql)).rows[0];
    if (current && !current.expected)
      throw new Error(
        "Deposit history index has an unexpected definition; migration stopped.",
      );
    if (current?.valid) return;
    if (current) await client.query(`DROP INDEX CONCURRENTLY ${legacyIndex}`);
    await client.query(
      `CREATE INDEX CONCURRENTLY ${legacyIndex} ON paperdash_history_records(address,record_key) WHERE kind='cashflows'`,
    );
    const result = (await client.query(depositMetricsIndexStatusSql)).rows[0];
    if (!result?.valid || !result.expected)
      throw new Error(
        "Deposit history index did not become valid; retry the owner migration.",
      );
  } finally {
    await client.end();
  }
}
/** Source upsert/deletion and mark share the producer's fenced transaction.
 * Receipt-only replays do no work unless a formerly future deposit is now valid.
 * A producer that deletes a retained row can use the same mark to retract it. */
export function enqueueDepositMetrics(
  prefix: string,
  address: string,
  key: string,
) {
  const queue = `${prefix}deposit_metrics_queue`,
    facts = `${prefix}deposit_metrics_facts`,
    records = `${prefix}history_records`;
  return {
    sql: `INSERT INTO ${queue}(address,record_key,queued_at)
      SELECT r.address,r.record_key,r.received_at FROM ${records} r
      WHERE r.address=? AND r.kind='cashflows' AND r.record_key=? AND (EXISTS (
        SELECT 1 FROM ${queue} q WHERE q.address=r.address AND q.record_key=r.record_key) OR NOT EXISTS (
        SELECT 1 FROM ${facts} f WHERE f.address=r.address AND f.record_key=r.record_key AND f.payload_hash=r.payload_hash AND f.source_at=r.source_at AND NOT (f.future=1 AND r.source_at<=r.received_at+30000)))
      UNION ALL SELECT f.address,f.record_key,f.received_at FROM ${facts} f
      WHERE f.address=? AND f.record_key=? AND NOT EXISTS (
        SELECT 1 FROM ${records} r WHERE r.address=f.address AND r.kind='cashflows' AND r.record_key=f.record_key)
      UNION ALL SELECT q.address,q.record_key,q.queued_at FROM ${queue} q
      WHERE q.address=? AND q.record_key=? AND NOT EXISTS (
        SELECT 1 FROM ${facts} f WHERE f.address=q.address AND f.record_key=q.record_key) AND NOT EXISTS (
        SELECT 1 FROM ${records} r WHERE r.address=q.address AND r.kind='cashflows' AND r.record_key=q.record_key)
      ON CONFLICT(address,record_key) DO UPDATE SET queued_at=CASE WHEN ${queue}.queued_at<excluded.queued_at THEN ${queue}.queued_at ELSE excluded.queued_at END`,
    params: [address, key, address, key, address, key],
  };
}
type Key = { address: string; record_key: string };
type Source = {
  payload: unknown;
  payload_hash: string;
  source_at: string | number;
  received_at: string | number;
};
type Fact = {
  payload_hash: string;
  source_at: string | number;
  received_at: string | number;
  amount_raw: string | null;
  excluded: number;
  future: number;
};
type Checkpoint = {
  cursor_address: string;
  cursor_key: string;
  complete: number;
};
type Daily = {
  time: string | number;
  volume_raw: string;
  deposit_count: string;
  first_depositors: string;
};
type Query = { sql: string; params?: (string | number | null)[] };
const table = (prefix: string, suffix: string) =>
  `${prefix}deposit_metrics_${suffix}`;
const pgSql = (sql: string) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};
const day = (at: number) => Math.floor(at / DAY) * DAY;
function limitFor(input: number) {
  if (!Number.isSafeInteger(input) || input < 1)
    throw new Error("Invalid deposit projection limit");
  return Math.min(input, 1000);
}
function count(raw: string | number): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("Deposit count is out of range");
  return n;
}
function factFrom(source: Source): Fact {
  const raw =
    typeof source.payload === "string"
      ? JSON.parse(source.payload)
      : source.payload;
  const value =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const at = Number(source.source_at),
    receivedAt = Number(source.received_at);
  const timestamp =
    Number.isSafeInteger(at) &&
    at >= 0 &&
    value.timestampMs === at &&
    Number.isSafeInteger(receivedAt) &&
    receivedAt >= 0;
  const future = timestamp && at - receivedAt > 30000;
  const amount =
    typeof value.amountRaw === "string" && /^\d+$/.test(value.amountRaw)
      ? BigInt(value.amountRaw)
      : null;
  const deposit = value.kind === "Deposit";
  const valid =
    deposit && timestamp && !future && amount !== null && amount > 0n;
  return {
    payload_hash: source.payload_hash,
    source_at: source.source_at,
    received_at: source.received_at,
    amount_raw: valid ? amount.toString() : null,
    excluded: deposit && (!timestamp || future || amount === null) ? 1 : 0,
    future: deposit && future && amount !== null && amount > 0n ? 1 : 0,
  };
}
const nextLegacy = (prefix: string) =>
  `SELECT address,record_key FROM ${prefix}history_records WHERE kind='cashflows' AND (address,record_key)>(?,?) ORDER BY address,record_key LIMIT 1`;
const loadSource = (prefix: string) =>
  `SELECT payload,payload_hash,source_at,received_at FROM ${prefix}history_records WHERE address=? AND kind='cashflows' AND record_key=?`;

/** One shared query program; SQLite runs it synchronously inside its transaction.
 * PG locks the queue, then totals, then wallet. Source rows are MVCC reads so a
 * producer holding history_records while awaiting our queue cannot deadlock. */
function* project(
  prefix: string,
  key: Key,
  postgres: boolean,
): Generator<Query, void, unknown[]> {
  const t = (name: string) => table(prefix, name),
    params = [key.address, key.record_key];
  const locked = postgres ? " FOR UPDATE" : "";
  const totals = (yield {
    sql: `SELECT excluded_count FROM ${t("totals")} WHERE id=1${locked}`,
  })[0] as { excluded_count: string };
  yield {
    sql: `INSERT INTO ${t("wallets")} VALUES(?,NULL) ON CONFLICT(address) DO NOTHING`,
    params: [key.address],
  };
  const wallet = (yield {
    sql: `SELECT first_at FROM ${t("wallets")} WHERE address=?${locked}`,
    params: [key.address],
  })[0] as { first_at: string | number | null };
  const source = (yield { sql: loadSource(prefix), params })[0] as
    Source | undefined;
  const prior = (yield {
    sql: `SELECT * FROM ${t("facts")} WHERE address=? AND record_key=?`,
    params,
  })[0] as Fact | undefined;
  const next = source ? factFrom(source) : undefined;
  if (next)
    yield {
      sql: `INSERT INTO ${t("facts")} VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(address,record_key) DO UPDATE SET payload_hash=excluded.payload_hash,source_at=excluded.source_at,received_at=excluded.received_at,amount_raw=excluded.amount_raw,excluded=excluded.excluded,future=excluded.future`,
      params: [
        ...params,
        next.payload_hash,
        next.source_at,
        next.received_at,
        next.amount_raw,
        next.excluded,
        next.future,
      ],
    };
  else
    yield {
      sql: `DELETE FROM ${t("facts")} WHERE address=? AND record_key=?`,
      params,
    };
  const first = (yield {
    sql: `SELECT source_at FROM ${t("facts")} WHERE address=? AND amount_raw IS NOT NULL ORDER BY source_at,record_key LIMIT 1`,
    params: [key.address],
  })[0] as { source_at: string | number } | undefined;
  const firstAt = first ? Number(first.source_at) : null;
  const previousFirst =
    wallet.first_at === null ? null : Number(wallet.first_at);
  const changes = new Map<
    number,
    { volume: bigint; deposits: bigint; first: bigint }
  >();
  let changed = previousFirst !== firstAt;
  const change = (
    at: number,
    volume: bigint,
    deposits: bigint,
    first: bigint,
  ) => {
    const time = day(at),
      prior = changes.get(time) ?? { volume: 0n, deposits: 0n, first: 0n };
    changes.set(time, {
      volume: prior.volume + volume,
      deposits: prior.deposits + deposits,
      first: prior.first + first,
    });
  };
  if (prior?.amount_raw !== null && prior?.amount_raw !== undefined)
    change(Number(prior.source_at), -BigInt(prior.amount_raw), -1n, 0n);
  if (next?.amount_raw !== null && next?.amount_raw !== undefined)
    change(Number(next.source_at), BigInt(next.amount_raw), 1n, 0n);
  if (previousFirst !== null) change(previousFirst, 0n, 0n, -1n);
  if (firstAt !== null) change(firstAt, 0n, 0n, 1n);
  for (const [time, delta] of [...changes].sort(([a], [b]) => a - b)) {
    if (delta.volume === 0n && delta.deposits === 0n && delta.first === 0n)
      continue;
    changed = true;
    yield {
      sql: `INSERT INTO ${t("days")} VALUES(?,'0','0','0') ON CONFLICT(time) DO NOTHING`,
      params: [time],
    };
    const current = (yield {
      sql: `SELECT * FROM ${t("days")} WHERE time=?`,
      params: [time],
    })[0] as Daily;
    const values = [
      BigInt(current.volume_raw) + delta.volume,
      BigInt(current.deposit_count) + delta.deposits,
      BigInt(current.first_depositors) + delta.first,
    ];
    if (values.some((value) => value < 0n))
      throw new Error("Deposit projection contribution is inconsistent");
    yield {
      sql: `UPDATE ${t("days")} SET volume_raw=?,deposit_count=?,first_depositors=? WHERE time=?`,
      params: [...values.map(String), time],
    };
  }
  if (previousFirst !== firstAt)
    yield {
      sql: `UPDATE ${t("wallets")} SET first_at=? WHERE address=?`,
      params: [firstAt, key.address],
    };
  const excluded =
    BigInt(totals.excluded_count) +
    BigInt(next?.excluded ?? 0) -
    BigInt(prior?.excluded ?? 0);
  if (excluded < 0n) throw new Error("Deposit exclusion count is inconsistent");
  if (changed || excluded !== BigInt(totals.excluded_count))
    yield {
      sql: `UPDATE ${t("totals")} SET excluded_count=?,updated_at=? WHERE id=1`,
      params: [String(excluded), Date.now()],
    };
  yield {
    sql: `DELETE FROM ${t("queue")} WHERE address=? AND record_key=?`,
    params,
  };
}
interface ReadDb {
  prefix: string;
  rows<T>(sql: string, params?: (string | number | null)[]): Promise<T[]>;
}
function reader(db: ReadDb): DepositMetricsStore["read"] {
  return async (fromMs, toMs) => {
    if (
      ![fromMs, toMs].every(
        (value) =>
          Number.isSafeInteger(value) && value >= 0 && value % DAY === 0,
      ) ||
      toMs <= fromMs ||
      toMs - fromMs > 366 * DAY
    )
      throw new Error("Invalid deposit chart range");
    const t = (name: string) => table(db.prefix, name);
    // One snapshot for coverage and rows. Range PK and partial earliest index
    // bound this read; no raw ledger access or per-day/per-wallet query loop.
    const rows = await db.rows<
      Daily & {
        complete: number;
        pending: boolean | number;
        excluded_count: string;
        updated_at: string | number | null;
        observed_from: string | number | null;
      }
    >(
      `SELECT d.time,d.volume_raw,d.deposit_count,d.first_depositors,s.complete,t.excluded_count,t.updated_at,
        EXISTS(SELECT 1 FROM ${t("queue")}) AS pending,
        (SELECT source_at FROM ${t("facts")} WHERE amount_raw IS NOT NULL ORDER BY source_at LIMIT 1) AS observed_from
      FROM ${t("state")} s JOIN ${t("totals")} t ON t.id=s.id
      LEFT JOIN ${t("days")} d ON d.time>=? AND d.time<? WHERE s.id=1 ORDER BY d.time`,
      [fromMs, toMs],
    );
    const state = rows[0],
      complete = Number(state?.complete) === 1;
    return {
      days: rows
        .filter((row) => row.time !== null)
        .map((row) => ({
          time: Number(row.time),
          depositVolumeRaw: row.volume_raw,
          depositCount: count(row.deposit_count),
          firstDepositors: count(row.first_depositors),
        })),
      observedFrom:
        state?.observed_from == null ? null : Number(state.observed_from),
      updatedAt: state?.updated_at == null ? null : Number(state.updated_at),
      projectionBackfillComplete: complete,
      pending: !complete || Boolean(state?.pending),
      excludedRecords: count(state?.excluded_count ?? "0"),
    };
  };
}
export function createPgDepositMetrics(pool: Pool): DepositMetricsStore {
  const prefix = "paperdash_",
    t = (name: string) => table(prefix, name);
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
      // Split the elapsed budget so legacy discovery cannot starve projection.
      // A transaction already admitted always finishes or rolls back normally.
      const started = performance.now();
      let backfilled = 0,
        processed = 0;
      try {
        // Advance one legacy key per transaction; no inversion against a source
        // producer which queues several cashflows in its page transaction.
        for (
          ;
          backfilled < limit && performance.now() - started < 1000;
          backfilled++
        ) {
          await client.query("BEGIN");
          const state = (
            await client.query(
              `SELECT * FROM ${t("state")} WHERE id=1 FOR UPDATE`,
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
              `UPDATE ${t("state")} SET complete=1 WHERE id=1`,
            );
            await client.query("COMMIT");
            break;
          }
          const mark = enqueueDepositMetrics(
            prefix,
            key.address,
            key.record_key,
          );
          await client.query(pgSql(mark.sql), mark.params);
          await client.query(
            `UPDATE ${t("state")} SET cursor_address=$1,cursor_key=$2 WHERE id=1`,
            [key.address, key.record_key],
          );
          await client.query("COMMIT");
        }
        for (
          ;
          processed < limit && performance.now() - started < 2000;
          processed++
        ) {
          await client.query("BEGIN");
          const key = (
            await client.query(
              `SELECT address,record_key FROM ${t("queue")} ORDER BY queued_at,address,record_key LIMIT 1 FOR UPDATE SKIP LOCKED`,
            )
          ).rows[0] as Key | undefined;
          if (!key) {
            await client.query("COMMIT");
            break;
          }
          const steps = project(prefix, key, true);
          let step = steps.next();
          while (!step.done) {
            const result = await client.query(
              pgSql(step.value.sql),
              step.value.params,
            );
            step = steps.next(result.rows);
          }
          await client.query("COMMIT");
        }
      } catch (error) {
        await rollbackPg(client);
        throw error;
      } finally {
        client.release();
      }
      const state = (
        await pool.query(
          `SELECT complete,EXISTS(SELECT 1 FROM ${t("queue")}) AS pending FROM ${t("state")} WHERE id=1`,
        )
      ).rows[0];
      const complete = Number(state?.complete) === 1;
      return {
        backfilled,
        processed,
        projectionBackfillComplete: complete,
        pending: !complete || Boolean(state?.pending),
      };
    },
  };
}
export function createLocalDepositMetrics(
  db: DatabaseSync,
  writable: () => Promise<void>,
): DepositMetricsStore {
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
      const started = performance.now();
      let backfilled = 0,
        processed = 0;
      db.exec("BEGIN IMMEDIATE");
      try {
        const state = db
          .prepare("SELECT * FROM deposit_metrics_state WHERE id=1")
          .get() as Checkpoint;
        if (state.complete !== 1) {
          for (
            ;
            backfilled < limit && performance.now() - started < 1000;
            backfilled++
          ) {
            const key = db
              .prepare(nextLegacy(""))
              .get(state.cursor_address, state.cursor_key) as Key | undefined;
            if (!key) {
              state.complete = 1;
              break;
            }
            const mark = enqueueDepositMetrics("", key.address, key.record_key);
            db.prepare(mark.sql).run(...mark.params);
            state.cursor_address = key.address;
            state.cursor_key = key.record_key;
          }
          db.prepare(
            "UPDATE deposit_metrics_state SET cursor_address=?,cursor_key=?,complete=? WHERE id=1",
          ).run(state.cursor_address, state.cursor_key, state.complete);
        }
        for (
          ;
          processed < limit && performance.now() - started < 2000;
          processed++
        ) {
          const key = db
            .prepare(
              "SELECT address,record_key FROM deposit_metrics_queue ORDER BY queued_at,address,record_key LIMIT 1",
            )
            .get() as Key | undefined;
          if (!key) break;
          const steps = project("", key, false);
          let step = steps.next();
          while (!step.done) {
            const result = db
              .prepare(step.value.sql)
              .all(...(step.value.params ?? []));
            step = steps.next(result);
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      const state = db
        .prepare(
          "SELECT complete,EXISTS(SELECT 1 FROM deposit_metrics_queue) AS pending FROM deposit_metrics_state WHERE id=1",
        )
        .get() as { complete: number; pending: number };
      return {
        backfilled,
        processed,
        projectionBackfillComplete: state.complete === 1,
        pending: state.complete !== 1 || Boolean(state.pending),
      };
    },
  };
}
