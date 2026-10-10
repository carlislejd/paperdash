import { rollbackPg } from "./pg-deadline.js";
import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import type {
  LiquidationTotals,
  LiquidationsResponse,
  TradeEvent,
} from "../../../packages/shared/src/types.js";
import { economicFingerprint } from "./analytics-store.js";

const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const MAX_ASSETS = 32;
const PAGE_SIZE = 50;
type Coverage = LiquidationsResponse["coverage"];
export interface LiquidationsStore {
  backfill(limit?: number): Promise<{ processed: number; complete: boolean }>;
  stats(
    instrument?: number,
    now?: number,
  ): Promise<{
    hour: LiquidationTotals;
    day: LiquidationTotals;
    coverage: Coverage;
    hourly: NonNullable<LiquidationsResponse["hourly"]>;
  }>;
  page(
    instrument?: number,
    cursor?: string,
    now?: number,
  ): Promise<{ items: TradeEvent[]; nextCursor: string | null }>;
}
export class LiquidationCursorError extends Error {
  readonly statusCode = 400;
  constructor() {
    super("Invalid liquidation cursor.");
    this.name = "LiquidationCursorError";
  }
}
export function liquidationsSchemaSql(
  prefix: string,
  postgres: boolean,
): string {
  const int = postgres ? "bigint" : "INTEGER",
    real = postgres ? "double precision" : "REAL",
    json = postgres ? "jsonb" : "TEXT";
  const kind = postgres ? "payload->>'kind'" : "json_extract(payload,'$.kind')";
  return `
CREATE TABLE IF NOT EXISTS ${prefix}liquidation_members(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ${prefix}liquidation_fingerprints(fingerprint TEXT PRIMARY KEY,instrument INTEGER NOT NULL,source_at ${int} NOT NULL,side TEXT NOT NULL,notional ${real} NOT NULL,stream_count ${int} NOT NULL,recent_count ${int} NOT NULL);
CREATE INDEX IF NOT EXISTS ${prefix}liquidation_fingerprint_time ON ${prefix}liquidation_fingerprints(source_at,fingerprint);
CREATE INDEX IF NOT EXISTS ${prefix}liquidation_fingerprint_instrument ON ${prefix}liquidation_fingerprints(instrument,source_at,fingerprint);
CREATE TABLE IF NOT EXISTS ${prefix}liquidation_minutes(instrument INTEGER NOT NULL,time ${int} NOT NULL,event_count ${int} NOT NULL,long_count ${int} NOT NULL,short_count ${int} NOT NULL,notional ${real} NOT NULL,PRIMARY KEY(instrument,time));
CREATE INDEX IF NOT EXISTS ${prefix}liquidation_minute_time ON ${prefix}liquidation_minutes(time,instrument);
CREATE TABLE IF NOT EXISTS ${prefix}liquidation_events(id TEXT PRIMARY KEY,instrument INTEGER NOT NULL,source_at ${int} NOT NULL,payload ${json} NOT NULL);
CREATE INDEX IF NOT EXISTS ${prefix}liquidation_event_time ON ${prefix}liquidation_events(source_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS ${prefix}liquidation_event_instrument ON ${prefix}liquidation_events(instrument,source_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS ${prefix}liquidation_state(id INTEGER PRIMARY KEY,cursor TEXT NOT NULL,complete INTEGER NOT NULL);
INSERT INTO ${prefix}liquidation_state VALUES(1,'',0) ON CONFLICT(id) DO NOTHING;
CREATE INDEX IF NOT EXISTS ${prefix}liquidation_raw_ids ON ${prefix}trade_observations(id) WHERE ${kind}='liq';`;
}
const pgSql = (sql: string) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};
const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0;
const parsePayload = (value: unknown): TradeEvent =>
  (typeof value === "string" ? JSON.parse(value) : value) as TradeEvent;
function validate(value: TradeEvent): void {
  if (
    typeof value.id !== "string" ||
    !value.id.length ||
    value.id.length > 500 ||
    !validTime(value.ts) ||
    !Number.isSafeInteger(value.instrument) ||
    value.instrument < 0 ||
    !/^0x[0-9a-f]{40}$/i.test(value.wallet) ||
    !["long", "short"].includes(value.side) ||
    !Number.isFinite(value.notionalUsd) ||
    value.notionalUsd < 0 ||
    !Number.isFinite(value.leverage) ||
    value.leverage <= 0 ||
    !(value.pnlUsd === null || Number.isFinite(value.pnlUsd)) ||
    !["public-stream", "recent-api"].includes(value.provenance)
  )
    throw new Error("Invalid liquidation observation");
}
function statements(prefix: string, value: TradeEvent) {
  validate(value);
  const fingerprint = economicFingerprint(value),
    table = `${prefix}liquidation_fingerprints`,
    stream = value.provenance === "public-stream";
  return {
    fingerprint,
    member: {
      sql: `INSERT INTO ${prefix}liquidation_members(id,fingerprint) VALUES(?,?) ON CONFLICT(id) DO NOTHING`,
      args: [value.id, fingerprint],
    },
    fingerprintUpdate: {
      sql: `INSERT INTO ${table}(fingerprint,instrument,source_at,side,notional,stream_count,recent_count) VALUES(?,?,?,?,?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET stream_count=${table}.stream_count+excluded.stream_count,recent_count=${table}.recent_count+excluded.recent_count RETURNING stream_count,recent_count,CASE WHEN ${stream ? "stream_count>recent_count" : "recent_count>stream_count"} THEN 1 ELSE 0 END AS delta`,
      args: [
        fingerprint,
        value.instrument,
        value.ts,
        value.side,
        value.notionalUsd,
        stream ? 1 : 0,
        stream ? 0 : 1,
      ],
    },
    minute: {
      sql: `INSERT INTO ${prefix}liquidation_minutes(instrument,time,event_count,long_count,short_count,notional) VALUES(?,?,?,?,?,?) ON CONFLICT(instrument,time) DO UPDATE SET event_count=${prefix}liquidation_minutes.event_count+excluded.event_count,long_count=${prefix}liquidation_minutes.long_count+excluded.long_count,short_count=${prefix}liquidation_minutes.short_count+excluded.short_count,notional=${prefix}liquidation_minutes.notional+excluded.notional`,
      args: [
        value.instrument,
        Math.floor(value.ts / MINUTE) * MINUTE,
        1,
        value.side === "long" ? 1 : 0,
        value.side === "short" ? 1 : 0,
        value.notionalUsd,
      ],
    },
  };
}
interface Counts {
  stream_count: number | string;
  recent_count: number | string;
  delta: number | string;
}
function projectedEvent(
  value: TradeEvent,
  fingerprint: string,
  counts: Counts,
): TradeEvent {
  const ordinal =
    value.provenance === "public-stream"
      ? counts.stream_count
      : counts.recent_count;
  // Identity stays stable when the overlapping source arrives later. The original
  // observation is retained in trade_observations; this is an explicitly partial projection.
  return { ...value, id: `liq:${fingerprint}:${ordinal}` };
}
/** Run inside the transaction inserting the durable raw trade. No effect for opens/closes. */
export async function projectLiquidationPg(
  client: Pick<PoolClient, "query">,
  value: TradeEvent,
): Promise<void> {
  if (value.kind !== "liq") return;
  const q = statements("paperdash_", value);
  if ((await client.query(pgSql(q.member.sql), q.member.args)).rowCount !== 1)
    return;
  const counts = (
    await client.query(pgSql(q.fingerprintUpdate.sql), q.fingerprintUpdate.args)
  ).rows[0] as Counts;
  const event = projectedEvent(value, q.fingerprint, counts);
  if (Number(counts.delta) === 1) {
    await client.query(pgSql(q.minute.sql), q.minute.args);
    await client.query(
      "INSERT INTO paperdash_liquidation_events(id,instrument,source_at,payload) VALUES($1,$2,$3,$4)",
      [event.id, event.instrument, event.ts, JSON.stringify(event)],
    );
  } else if (
    typeof value.priceUsd === "number" &&
    Number.isFinite(value.priceUsd) &&
    value.priceUsd > 0
  ) {
    await client.query(
      "UPDATE paperdash_liquidation_events SET payload=$1 WHERE id=$2 AND (payload->>'priceUsd' IS NULL)",
      [JSON.stringify(event), event.id],
    );
  }
}
/** Synchronous and invoked in the same transaction as raw SQLite observations. */
export function projectLiquidationSqlite(
  db: DatabaseSync,
  value: TradeEvent,
): void {
  if (value.kind !== "liq") return;
  const q = statements("", value);
  if (db.prepare(q.member.sql).run(...q.member.args).changes !== 1) return;
  const counts = db
    .prepare(q.fingerprintUpdate.sql)
    .get(...q.fingerprintUpdate.args) as unknown as Counts;
  const event = projectedEvent(value, q.fingerprint, counts);
  if (Number(counts.delta) === 1) {
    db.prepare(q.minute.sql).run(...q.minute.args);
    db.prepare(
      "INSERT INTO liquidation_events(id,instrument,source_at,payload) VALUES(?,?,?,?)",
    ).run(event.id, event.instrument, event.ts, JSON.stringify(event));
  } else if (
    typeof value.priceUsd === "number" &&
    Number.isFinite(value.priceUsd) &&
    value.priceUsd > 0
  ) {
    db.prepare(
      "UPDATE liquidation_events SET payload=? WHERE id=? AND json_extract(payload,'$.priceUsd') IS NULL",
    ).run(JSON.stringify(event), event.id);
  }
}
interface Reader {
  prefix: string;
  rows<T>(sql: string, args?: (string | number)[]): Promise<T[]>;
}
function checkQuery(instrument: number | undefined, now: number) {
  if (
    (instrument !== undefined &&
      (!Number.isSafeInteger(instrument) || instrument < 0)) ||
    !validTime(now)
  )
    throw new Error("Invalid liquidation query");
}
type Cursor = [1, number | null, number, string, number];
function decodeCursor(value: string, instrument: number | undefined): Cursor {
  try {
    if (!value.length || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value))
      throw new Error();
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error();
    const cursor = JSON.parse(bytes.toString("utf8"));
    if (
      !Array.isArray(cursor) ||
      cursor.length !== 5 ||
      cursor[0] !== 1 ||
      cursor[1] !== (instrument ?? null) ||
      !validTime(cursor[2]) ||
      !validTime(cursor[4]) ||
      cursor[2] > cursor[4] ||
      typeof cursor[3] !== "string" ||
      !/^liq:[a-f0-9]{64}:[1-9]\d{0,15}$/.test(cursor[3])
    )
      throw new Error();
    return cursor as Cursor;
  } catch {
    throw new LiquidationCursorError();
  }
}
type TotalRow = {
  count: number | string | null;
  long_count: number | string | null;
  short_count: number | string | null;
  notional: number | string | null;
};
const zeroTotals = (): LiquidationTotals => ({
  count: 0,
  longCount: 0,
  shortCount: 0,
  notionalUsd: 0,
});
function checkTotals(value: LiquidationTotals): LiquidationTotals {
  if (
    ![value.count, value.longCount, value.shortCount].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    !Number.isFinite(value.notionalUsd) ||
    value.notionalUsd < 0
  )
    throw new Error("Liquidation aggregate exceeds supported range");
  return value;
}
function readers(db: Reader): Pick<LiquidationsStore, "stats" | "page"> {
  const f = `${db.prefix}liquidation_fingerprints`,
    m = `${db.prefix}liquidation_minutes`,
    e = `${db.prefix}liquidation_events`;
  const effective =
    "CASE WHEN stream_count>recent_count THEN stream_count ELSE recent_count END";
  return {
    async stats(instrument, now = Date.now()) {
      checkQuery(instrument, now);
      const filter = instrument === undefined ? "" : "instrument=? AND ";
      const args = instrument === undefined ? [] : [instrument];
      const parts = (span: number) => {
        const from = Math.max(0, now - span),
          fullFrom = Math.ceil(from / MINUTE) * MINUTE,
          fullTo = Math.floor(now / MINUTE) * MINUTE;
        return {
          sql: `SELECT instrument,time AS source_at,event_count AS n,long_count,short_count,notional FROM ${m} WHERE ${filter}time>=? AND time<? UNION ALL SELECT instrument,source_at,n,CASE WHEN side='long' THEN n ELSE 0 END AS long_count,CASE WHEN side='short' THEN n ELSE 0 END AS short_count,notional*n AS notional FROM (SELECT instrument,source_at,side,notional,${effective} AS n FROM ${f} WHERE ${filter}((source_at>=? AND source_at<?) OR (source_at>=? AND source_at<=?))) boundary`,
          args: [
            ...args,
            fullFrom,
            fullTo,
            ...args,
            from,
            fullFrom,
            fullTo,
            now,
          ],
        };
      };
      const dayParts = parts(DAY),
        hourParts = parts(HOUR);
      // One database snapshot keeps the hourly segments and day/hour totals
      // coherent while the worker concurrently admits new observations.
      // Only indexed minute totals and exact boundary-minute fingerprints are read.
      const rows = await db.rows<
        TotalRow & {
          kind: "bucket" | "hour";
          instrument: number | null;
          time: string | number | null;
          observed_from: string | number | null;
          latest_at: string | number | null;
          complete: number | null;
        }
      >(
        `WITH day_parts AS (${dayParts.sql}), hour_parts AS (${hourParts.sql}), grouped AS (SELECT 'bucket' AS kind,instrument,source_at-(source_at%${HOUR}) AS time,sum(n) AS count,sum(long_count) AS long_count,sum(short_count) AS short_count,sum(notional) AS notional FROM day_parts GROUP BY instrument,source_at-(source_at%${HOUR}) UNION ALL SELECT 'hour' AS kind,NULL AS instrument,NULL AS time,sum(n) AS count,sum(long_count) AS long_count,sum(short_count) AS short_count,sum(notional) AS notional FROM hour_parts), coverage AS (SELECT (SELECT source_at FROM ${f} WHERE ${filter}source_at<=? ORDER BY source_at LIMIT 1) AS observed_from,(SELECT source_at FROM ${f} WHERE ${filter}source_at<=? ORDER BY source_at DESC LIMIT 1) AS latest_at,(SELECT complete FROM ${db.prefix}liquidation_state WHERE id=1) AS complete) SELECT kind,instrument,time,CAST(count AS TEXT) AS count,CAST(long_count AS TEXT) AS long_count,CAST(short_count AS TEXT) AS short_count,notional,observed_from,latest_at,complete FROM grouped CROSS JOIN coverage ORDER BY kind,time,instrument LIMIT ${25 * MAX_ASSETS + 2}`,
        [...dayParts.args, ...hourParts.args, ...args, now, ...args, now],
      );
      if (rows.length > 25 * MAX_ASSETS + 1)
        throw new Error("Liquidation hourly aggregate exceeds supported range");
      const instruments = new Set(
        instrument === undefined ? [0, 1] : [instrument],
      );
      const values = new Map<
        string,
        { instrument: number; count: number; notionalUsd: number }
      >();
      const day = zeroTotals();
      let hour = zeroTotals();
      for (const row of rows) {
        const total = checkTotals({
          count: Number(row.count ?? 0),
          longCount: Number(row.long_count ?? 0),
          shortCount: Number(row.short_count ?? 0),
          notionalUsd: Number(row.notional ?? 0),
        });
        if (row.kind === "hour") {
          hour = total;
          continue;
        }
        const asset = Number(row.instrument),
          time = Number(row.time);
        if (
          !Number.isSafeInteger(asset) ||
          asset < 0 ||
          !validTime(time) ||
          time % HOUR
        )
          throw new Error("Invalid liquidation hourly aggregate");
        instruments.add(asset);
        values.set(`${time}:${asset}`, {
          instrument: asset,
          count: total.count,
          notionalUsd: total.notionalUsd,
        });
        day.count += total.count;
        day.longCount += total.longCount;
        day.shortCount += total.shortCount;
        day.notionalUsd += total.notionalUsd;
      }
      if (instruments.size > MAX_ASSETS)
        throw new Error("Too many liquidation instruments");
      checkTotals(day);
      const from = Math.max(0, now - DAY),
        start = Math.floor(from / HOUR) * HOUR;
      const lastHour = Math.floor(now / HOUR) * HOUR;
      const assets = [...instruments].sort((a, b) => a - b);
      const hourly: NonNullable<LiquidationsResponse["hourly"]> = {
        intervalMs: HOUR,
        from,
        to: now,
        buckets: Array.from(
          { length: Math.floor((lastHour - start) / HOUR) + 1 },
          (_, i) => {
            const time = start + i * HOUR;
            return {
              time,
              partial: time < from || time === lastHour,
              assets: assets.map(
                (asset) =>
                  values.get(`${time}:${asset}`) ?? {
                    instrument: asset,
                    count: 0,
                    notionalUsd: 0,
                  },
              ),
            };
          },
        ),
      };
      return {
        hour,
        day,
        hourly,
        coverage: {
          source: "retained-public-observations",
          partial: true,
          identityAmbiguous: true,
          projectionBackfillComplete: Number(rows[0]?.complete) === 1,
          observedFrom:
            rows[0]?.observed_from == null
              ? null
              : Number(rows[0].observed_from),
          latestObservedAt:
            rows[0]?.latest_at == null ? null : Number(rows[0].latest_at),
        },
      };
    },
    async page(instrument, cursor, now = Date.now()) {
      checkQuery(instrument, now);
      const decoded = cursor ? decodeCursor(cursor, instrument) : null;
      const ceiling = Math.min(now, decoded?.[4] ?? now);
      const instrumentFilter =
        instrument === undefined ? "" : "instrument=? AND ";
      const args: (number | string)[] =
        instrument === undefined ? [] : [instrument];
      args.push(ceiling);
      const keyset = decoded ? " AND (source_at,id)<(?,?)" : "";
      if (decoded) args.push(decoded[2], decoded[3]);
      const rows = await db.rows<{
        id: string;
        source_at: number | string;
        payload: unknown;
      }>(
        `SELECT id,source_at,payload FROM ${e} WHERE ${instrumentFilter}source_at<=?${keyset} ORDER BY source_at DESC,id DESC LIMIT ${PAGE_SIZE + 1}`,
        args,
      );
      const visible = rows.slice(0, PAGE_SIZE),
        last = visible.at(-1);
      const nextCursor =
        rows.length > PAGE_SIZE && last
          ? Buffer.from(
              JSON.stringify([
                1,
                instrument ?? null,
                Number(last.source_at),
                last.id,
                ceiling,
              ] satisfies Cursor),
            ).toString("base64url")
          : null;
      return {
        items: visible.map((row) => parsePayload(row.payload)),
        nextCursor,
      };
    },
  };
}
function backfillLimit(limit: number): number {
  if (!Number.isFinite(limit))
    throw new Error("Invalid liquidation backfill limit");
  return Math.max(1, Math.min(5000, Math.floor(limit)));
}
export function createPgLiquidations(pool: Pool): LiquidationsStore {
  return {
    ...readers({
      prefix: "paperdash_",
      async rows<T>(sql: string, args: (string | number)[] = []) {
        return (await pool.query(pgSql(sql), args)).rows as T[];
      },
    }),
    async backfill(limit = 500) {
      limit = backfillLimit(limit);
      const client = await pool.connect();
      let processed = 0;
      const deadline = performance.now() + 3000;
      try {
        // One observation per transaction avoids holding multiple fingerprint or minute
        // locks while another live writer waits in the opposite order.
        while (processed < limit && performance.now() < deadline) {
          await client.query("BEGIN");
          const state = (
            await client.query(
              "SELECT cursor,complete FROM paperdash_liquidation_state WHERE id=1 FOR UPDATE",
            )
          ).rows[0];
          if (state.complete === 1) {
            await client.query("COMMIT");
            return { processed, complete: true };
          }
          const row = (
            await client.query(
              "SELECT id,payload FROM paperdash_trade_observations WHERE id>$1 AND payload->>'kind'='liq' ORDER BY id LIMIT 1",
              [state.cursor],
            )
          ).rows[0];
          if (!row) {
            await client.query(
              "UPDATE paperdash_liquidation_state SET complete=1 WHERE id=1",
            );
            await client.query("COMMIT");
            return { processed, complete: true };
          }
          await projectLiquidationPg(client, parsePayload(row.payload));
          await client.query(
            "UPDATE paperdash_liquidation_state SET cursor=$1 WHERE id=1",
            [row.id],
          );
          await client.query("COMMIT");
          processed++;
        }
        return { processed, complete: false };
      } catch (error) {
        await rollbackPg(client);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
export function createLocalLiquidations(
  db: DatabaseSync,
  writable: () => Promise<void>,
): LiquidationsStore {
  return {
    ...readers({
      prefix: "",
      async rows<T>(sql: string, args: (string | number)[] = []) {
        return db.prepare(sql).all(...args) as T[];
      },
    }),
    async backfill(limit = 500) {
      limit = backfillLimit(limit);
      await writable();
      db.exec("BEGIN IMMEDIATE");
      try {
        const state = db
          .prepare("SELECT cursor,complete FROM liquidation_state WHERE id=1")
          .get() as { cursor: string; complete: number };
        if (state.complete === 1) {
          db.exec("COMMIT");
          return { processed: 0, complete: true };
        }
        const rows = db
          .prepare(
            "SELECT id,payload FROM trade_observations WHERE id>? AND json_extract(payload,'$.kind')='liq' ORDER BY id LIMIT ?",
          )
          .all(state.cursor, limit) as { id: string; payload: string }[];
        const deadline = performance.now() + 3000;
        let processed = 0;
        for (const row of rows) {
          if (performance.now() >= deadline) break;
          projectLiquidationSqlite(db, parsePayload(row.payload));
          processed++;
        }
        const complete = processed === rows.length && rows.length < limit;
        db.prepare(
          "UPDATE liquidation_state SET cursor=?,complete=? WHERE id=1",
        ).run(
          processed ? rows[processed - 1].id : state.cursor,
          complete ? 1 : 0,
        );
        db.exec("COMMIT");
        return { processed, complete };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
