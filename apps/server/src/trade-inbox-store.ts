import type { DatabaseSync } from "node:sqlite";
import type { Pool } from "pg";
import type { TradeEvent } from "../../../packages/shared/src/types.js";
import { rollbackPg } from "./pg-deadline.js";

export interface IntakeGap {
  firstAt: number;
  at: number;
  kind: "malformed" | "overflow" | "shutdown";
  /** Count for the latest incident, not a cumulative loss estimate. */
  count: number | null;
  reason: string;
}
export interface InboxStatus {
  pending: number;
  pendingCapped: boolean;
  pendingBytes: number;
  oldestAt: number | null;
  gap: IntakeGap | null;
}
export interface TradeInboxStore {
  append(values: TradeEvent[], receivedAt: number): Promise<void>;
  head(limit?: number): Promise<TradeEvent[]>;
  acknowledge(id: string): Promise<void>;
  recordGap(gap: IntakeGap): Promise<void>;
  status(): Promise<InboxStatus>;
}
export class InboxCapacityError extends Error {
  constructor() {
    super(
      "Durable trade inbox capacity reached; retained work must drain before admission resumes.",
    );
  }
}
export const INBOX_MAX_RECORDS = 100000;
export const INBOX_MAX_BYTES = 128 * 1024 * 1024;
export function tradeInboxSchemaSql(prefix: string, postgres: boolean): string {
  const seq = postgres
    ? "BIGSERIAL PRIMARY KEY"
    : "INTEGER PRIMARY KEY AUTOINCREMENT";
  const json = postgres ? "JSONB" : "TEXT";
  const integer = postgres ? "BIGINT" : "INTEGER";
  return `CREATE TABLE IF NOT EXISTS ${prefix}trade_inbox(seq ${seq},id TEXT UNIQUE NOT NULL,payload ${json} NOT NULL,received_at ${integer} NOT NULL,byte_size INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ${prefix}trade_inbox_totals(id INTEGER PRIMARY KEY,pending_rows ${integer} NOT NULL CHECK(pending_rows>=0),pending_bytes ${integer} NOT NULL CHECK(pending_bytes>=0));
INSERT INTO ${prefix}trade_inbox_totals SELECT 1,count(*),COALESCE(sum(byte_size),0) FROM ${prefix}trade_inbox WHERE true ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS ${prefix}trade_ingestion_gaps(id INTEGER PRIMARY KEY,first_at ${integer} NOT NULL,last_at ${integer} NOT NULL,kind TEXT NOT NULL,item_count INTEGER,reason TEXT NOT NULL);`;
}
export const INTAKE_MAX_RECORDS = 1000;
export const INTAKE_MAX_BYTES = 1024 * 1024;
export const INBOX_BATCH_SIZE = 50;
export function encodedTrade(value: TradeEvent): string {
  if (
    !value ||
    typeof value.id !== "string" ||
    !value.id.length ||
    value.id.length > 200
  )
    throw new Error("Invalid inbox observation ID");
  if (
    !Number.isSafeInteger(value.instrument) ||
    value.instrument < 0 ||
    !Number.isSafeInteger(value.ts) ||
    value.ts < 0 ||
    !/^0x[a-f0-9]{40}$/.test(value.wallet) ||
    !["long", "short"].includes(value.side) ||
    !["open", "close", "liq"].includes(value.kind) ||
    !["public-stream", "recent-api"].includes(value.provenance) ||
    !Number.isFinite(value.notionalUsd) ||
    value.notionalUsd < 0 ||
    !Number.isFinite(value.leverage) ||
    value.leverage <= 0 ||
    !(value.pnlUsd === null || Number.isFinite(value.pnlUsd))
  )
    throw new Error("Invalid inbox trade observation");
  const payload = JSON.stringify(value);
  if (Buffer.byteLength(payload) > 16384)
    throw new Error("Inbox observation is too large");
  return payload;
}
function prepare(values: TradeEvent[], at: number) {
  if (values.length > INBOX_BATCH_SIZE || !Number.isSafeInteger(at) || at < 0)
    throw new Error("Invalid inbox batch");
  return [...new Map(values.map((value) => [value.id, value])).values()].map(
    (value) => {
      const payload = encodedTrade(value);
      return [value.id, payload, at, Buffer.byteLength(payload)];
    },
  );
}
function gapQuery(prefix: string, gap: IntakeGap) {
  if (
    !Number.isSafeInteger(gap.firstAt) ||
    !Number.isSafeInteger(gap.at) ||
    gap.firstAt < 0 ||
    gap.at < gap.firstAt ||
    !["malformed", "overflow", "shutdown"].includes(gap.kind) ||
    !(gap.count === null || (Number.isSafeInteger(gap.count) && gap.count >= 0))
  )
    throw new Error("Invalid intake gap");
  const table = `${prefix}trade_ingestion_gaps`;
  return {
    sql: `INSERT INTO ${table}(id,first_at,last_at,kind,item_count,reason) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET first_at=CASE WHEN ${table}.first_at<excluded.first_at THEN ${table}.first_at ELSE excluded.first_at END,last_at=CASE WHEN ${table}.last_at>excluded.last_at THEN ${table}.last_at ELSE excluded.last_at END,kind=CASE WHEN ${table}.last_at>excluded.last_at THEN ${table}.kind ELSE excluded.kind END,item_count=CASE WHEN ${table}.last_at>excluded.last_at THEN ${table}.item_count ELSE excluded.item_count END,reason=CASE WHEN ${table}.last_at>excluded.last_at THEN ${table}.reason ELSE excluded.reason END`,
    args: [gap.firstAt, gap.at, gap.kind, gap.count, gap.reason.slice(0, 240)],
  };
}
function pgSql(sql: string) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}
type Rows = (
  sql: string,
  args?: unknown[],
) => Promise<Record<string, unknown>[]>;
function reader(prefix: string, rows: Rows) {
  return {
    async head(limit = INBOX_BATCH_SIZE): Promise<TradeEvent[]> {
      const count = Math.max(1, Math.min(INBOX_BATCH_SIZE, Math.floor(limit)));
      if (!Number.isSafeInteger(count))
        throw new Error("Invalid inbox read limit");
      return (
        await rows(
          `SELECT payload FROM ${prefix}trade_inbox ORDER BY seq LIMIT ?`,
          [count],
        )
      ).map(
        (row) =>
          (typeof row.payload === "string"
            ? JSON.parse(row.payload)
            : row.payload) as TradeEvent,
      );
    },
    async status(): Promise<InboxStatus> {
      const [count, first, gaps] = await Promise.all([
        rows(
          `SELECT pending_rows n,pending_bytes FROM ${prefix}trade_inbox_totals WHERE id=1`,
        ),
        rows(
          `SELECT received_at FROM ${prefix}trade_inbox ORDER BY seq LIMIT 1`,
        ),
        rows(`SELECT * FROM ${prefix}trade_ingestion_gaps WHERE id=1`),
      ]);
      const n = Number(count[0].n),
        gap = gaps[0];
      return {
        pending: Math.min(n, 10000),
        pendingCapped: n > 10000,
        pendingBytes: Number(count[0].pending_bytes),
        oldestAt: first.length ? Number(first[0].received_at) : null,
        gap: gap
          ? {
              firstAt: Number(gap.first_at),
              at: Number(gap.last_at),
              kind: gap.kind as IntakeGap["kind"],
              count: gap.item_count === null ? null : Number(gap.item_count),
              reason: String(gap.reason),
            }
          : null,
      };
    },
  };
}
export function createPgTradeInbox(
  pool: Pool,
  limits = { records: INBOX_MAX_RECORDS, bytes: INBOX_MAX_BYTES },
): TradeInboxStore {
  const prefix = "paperdash_";
  return {
    ...reader(
      prefix,
      async (sql, args = []) => (await pool.query(pgSql(sql), args)).rows,
    ),
    async append(values, at) {
      const entries = prepare(values, at);
      if (!entries.length) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const totals = (
          await client.query(
            `SELECT pending_rows,pending_bytes FROM ${prefix}trade_inbox_totals WHERE id=1 FOR UPDATE`,
          )
        ).rows[0];
        if (!totals) throw new Error("Trade inbox accounting is unavailable");
        // A completed inbox item already has a raw observation. Recent-window
        // polling must not repeatedly requeue it. If projection committed but
        // priority/ack failed, its original inbox row still exists for replay.
        const inserted = await client.query(
          pgSql(
            `INSERT INTO ${prefix}trade_inbox(id,payload,received_at,byte_size) SELECT v.id,v.payload::jsonb,v.received_at::bigint,v.byte_size::integer FROM (VALUES ${entries.map(() => "(?,?,?,?)").join(",")}) AS v(id,payload,received_at,byte_size) WHERE NOT EXISTS(SELECT 1 FROM ${prefix}trade_observations r WHERE r.id=v.id) ON CONFLICT(id) DO NOTHING RETURNING byte_size`,
          ),
          entries.flat(),
        );
        const count = inserted.rows.length,
          bytes = inserted.rows.reduce(
            (total, row) => total + Number(row.byte_size),
            0,
          );
        if (
          Number(totals.pending_rows) + count > limits.records ||
          Number(totals.pending_bytes) + bytes > limits.bytes
        )
          throw new InboxCapacityError();
        if (count)
          await client.query(
            `UPDATE ${prefix}trade_inbox_totals SET pending_rows=pending_rows+$1,pending_bytes=pending_bytes+$2 WHERE id=1`,
            [count, bytes],
          );
        await client.query("COMMIT");
      } catch (error) {
        await rollbackPg(client);
        throw error;
      } finally {
        client.release();
      }
    },
    async acknowledge(id) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (
          (
            await client.query(
              `SELECT id FROM ${prefix}trade_inbox_totals WHERE id=1 FOR UPDATE`,
            )
          ).rowCount !== 1
        )
          throw new Error("Trade inbox accounting is unavailable");
        const removed = (
          await client.query(
            `DELETE FROM ${prefix}trade_inbox WHERE id=$1 RETURNING byte_size`,
            [id],
          )
        ).rows[0];
        if (removed)
          await client.query(
            `UPDATE ${prefix}trade_inbox_totals SET pending_rows=pending_rows-1,pending_bytes=pending_bytes-$1 WHERE id=1`,
            [removed.byte_size],
          );
        await client.query("COMMIT");
      } catch (error) {
        await rollbackPg(client);
        throw error;
      } finally {
        client.release();
      }
    },
    async recordGap(gap) {
      const q = gapQuery(prefix, gap);
      await pool.query(pgSql(q.sql), q.args);
    },
  };
}
export function createLocalTradeInbox(
  db: DatabaseSync,
  writable: () => Promise<void>,
  limits = { records: INBOX_MAX_RECORDS, bytes: INBOX_MAX_BYTES },
): TradeInboxStore {
  return {
    ...reader("", async (sql, args = []) =>
      db.prepare(sql).all(...(args as (string | number | null)[])),
    ),
    async append(values, at) {
      const entries = prepare(values, at);
      if (!entries.length) return;
      await writable();
      db.exec("BEGIN IMMEDIATE");
      try {
        const totals = db
          .prepare(
            "SELECT pending_rows,pending_bytes FROM trade_inbox_totals WHERE id=1",
          )
          .get() as { pending_rows: number; pending_bytes: number };
        let count = 0,
          bytes = 0;
        const insert = db.prepare(
          "INSERT INTO trade_inbox(id,payload,received_at,byte_size) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM trade_observations WHERE id=?) ON CONFLICT(id) DO NOTHING",
        );
        for (const entry of entries)
          if (insert.run(...(entry as (string | number)[]), entry[0]).changes) {
            count++;
            bytes += Number(entry[3]);
          }
        if (
          totals.pending_rows + count > limits.records ||
          totals.pending_bytes + bytes > limits.bytes
        )
          throw new InboxCapacityError();
        if (count)
          db.prepare(
            "UPDATE trade_inbox_totals SET pending_rows=pending_rows+?,pending_bytes=pending_bytes+? WHERE id=1",
          ).run(count, bytes);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async acknowledge(id) {
      await writable();
      db.exec("BEGIN IMMEDIATE");
      try {
        const removed = db
          .prepare("DELETE FROM trade_inbox WHERE id=? RETURNING byte_size")
          .get(id) as { byte_size: number } | undefined;
        if (
          removed &&
          db
            .prepare(
              "UPDATE trade_inbox_totals SET pending_rows=pending_rows-1,pending_bytes=pending_bytes-? WHERE id=1",
            )
            .run(removed.byte_size).changes !== 1
        )
          throw new Error("Trade inbox accounting is unavailable");
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async recordGap(gap) {
      const q = gapQuery("", gap);
      await writable();
      db.prepare(q.sql).run(...q.args);
    },
  };
}
