import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import type { TradeEvent } from "../../../packages/shared/src/types.js";
import { digest } from "./schemas.js";

const MINUTE = 60000;
const DAY = 86400000;
export interface AssetActivity {
  instrument: number;
  windowFrom: number;
  windowTo: number;
  counts: { total: number; long: number; short: number };
  notionalUsd: { total: number; long: number; short: number };
  recent: TradeEvent[];
  coverage: {
    /** Earliest/latest retained event timestamps, not a promise of gap-free collection. */
    observedFrom: number | null;
    latestObservedAt: number | null;
    projectionBackfillComplete: boolean;
    identityAmbiguous: true;
    source: "retained-public-observations";
  };
}
export interface AssetOiSample {
  instrument: number;
  time: number;
  longRaw: string;
  shortRaw: string;
  /** USD entry-notional quantities, scaled by 1e18; source has no indexed block. */
  sourceBlock: string | null;
  sourceAt: number;
  receivedAt: number;
}
export interface AnalyticsStore {
  activity(instruments: number[], now?: number): Promise<AssetActivity[]>;
  sample(
    value: Omit<AssetOiSample, "receivedAt"> & { receivedAt?: number },
  ): Promise<void>;
  samples(
    instrument: number,
    fromMs?: number,
    limit?: number,
  ): Promise<AssetOiSample[]>;
  backfill(limit?: number): Promise<{ processed: number; complete: boolean }>;
  walletActivity(
    sort?: "volume" | "trades",
    page?: number,
    q?: string,
    now?: number,
  ): Promise<WalletActivity>;
}
export interface WalletActivity {
  rows: { address: string; count: number; notionalUsd: number }[];
  count: number;
  page: number;
  pageSize: 25;
  windowFrom: number;
  windowTo: number;
  coverage: AssetActivity["coverage"];
}

export function analyticsSchemaSql(prefix: string, postgres: boolean): string {
  const int = postgres ? "bigint" : "INTEGER",
    real = postgres ? "double precision" : "REAL";
  return `
CREATE TABLE IF NOT EXISTS ${prefix}analytics_members(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,provenance TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ${prefix}analytics_members_fingerprint ON ${prefix}analytics_members(fingerprint,provenance,id DESC);
CREATE TABLE IF NOT EXISTS ${prefix}analytics_fingerprints(fingerprint TEXT PRIMARY KEY,instrument INTEGER NOT NULL,source_at ${int} NOT NULL,side TEXT NOT NULL,notional ${real} NOT NULL,stream_count ${int} NOT NULL,recent_count ${int} NOT NULL);
CREATE INDEX IF NOT EXISTS ${prefix}analytics_fingerprint_time ON ${prefix}analytics_fingerprints(instrument,source_at DESC,fingerprint DESC);
CREATE TABLE IF NOT EXISTS ${prefix}analytics_minutes(instrument INTEGER NOT NULL,time ${int} NOT NULL,event_count ${int} NOT NULL,long_count ${int} NOT NULL,short_count ${int} NOT NULL,notional ${real} NOT NULL,long_notional ${real} NOT NULL,short_notional ${real} NOT NULL,PRIMARY KEY(instrument,time));
CREATE TABLE IF NOT EXISTS ${prefix}analytics_oi_samples(instrument INTEGER NOT NULL,time ${int} NOT NULL,long_raw TEXT NOT NULL,short_raw TEXT NOT NULL,source_block TEXT,source_at ${int} NOT NULL,received_at ${int} NOT NULL,PRIMARY KEY(instrument,time));
CREATE TABLE IF NOT EXISTS ${prefix}analytics_wallet_fingerprints(fingerprint TEXT PRIMARY KEY,wallet TEXT NOT NULL,source_at ${int} NOT NULL,notional ${real} NOT NULL,effective_count ${int} NOT NULL);
CREATE INDEX IF NOT EXISTS ${prefix}analytics_wallet_fingerprint_time ON ${prefix}analytics_wallet_fingerprints(source_at,wallet);
CREATE TABLE IF NOT EXISTS ${prefix}analytics_wallet_minutes(wallet TEXT NOT NULL,time ${int} NOT NULL,event_count ${int} NOT NULL,notional ${real} NOT NULL,PRIMARY KEY(wallet,time));
CREATE INDEX IF NOT EXISTS ${prefix}analytics_wallet_minute_time ON ${prefix}analytics_wallet_minutes(time,wallet);
CREATE TABLE IF NOT EXISTS ${prefix}analytics_state(id INTEGER PRIMARY KEY,cursor TEXT NOT NULL,complete INTEGER NOT NULL);
INSERT INTO ${prefix}analytics_state VALUES(2,'',0) ON CONFLICT(id) DO NOTHING;
`;
}
export function economicFingerprint(value: TradeEvent): string {
  return digest({
    ts: value.ts,
    wallet: value.wallet,
    instrument: value.instrument,
    side: value.side,
    leverage: value.leverage,
    notionalUsd: value.notionalUsd,
    kind: value.kind,
    pnlUsd: value.pnlUsd,
  });
}
function validateTrade(value: TradeEvent) {
  if (
    !Number.isSafeInteger(value.instrument) ||
    value.instrument < 0 ||
    !Number.isSafeInteger(value.ts) ||
    value.ts < 0 ||
    !Number.isFinite(value.notionalUsd) ||
    value.notionalUsd < 0 ||
    !["long", "short"].includes(value.side) ||
    !["public-stream", "recent-api"].includes(value.provenance)
  )
    throw new Error("Invalid activity observation");
}
const pgSql = (sql: string) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};
interface Query {
  sql: string;
  params: (string | number | null)[];
}
function membership(
  prefix: string,
  value: TradeEvent,
  fingerprint: string,
): Query {
  return {
    sql: `INSERT INTO ${prefix}analytics_members VALUES(?,?,?) ON CONFLICT(id) DO NOTHING`,
    params: [value.id, fingerprint, value.provenance],
  };
}
function fingerprintUpdate(
  prefix: string,
  value: TradeEvent,
  fingerprint: string,
): Query {
  const table = `${prefix}analytics_fingerprints`,
    stream = value.provenance === "public-stream";
  return {
    sql: `INSERT INTO ${table} VALUES(?,?,?,?,?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET stream_count=${table}.stream_count+excluded.stream_count,recent_count=${table}.recent_count+excluded.recent_count RETURNING CASE WHEN ${stream ? "stream_count>recent_count" : "recent_count>stream_count"} THEN 1 ELSE 0 END AS delta`,
    params: [
      fingerprint,
      value.instrument,
      value.ts,
      value.side,
      value.notionalUsd,
      stream ? 1 : 0,
      stream ? 0 : 1,
    ],
  };
}
function minuteUpdate(prefix: string, value: TradeEvent): Query {
  const table = `${prefix}analytics_minutes`,
    long = value.side === "long";
  return {
    sql: `INSERT INTO ${table} VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(instrument,time) DO UPDATE SET event_count=${table}.event_count+excluded.event_count,long_count=${table}.long_count+excluded.long_count,short_count=${table}.short_count+excluded.short_count,notional=${table}.notional+excluded.notional,long_notional=${table}.long_notional+excluded.long_notional,short_notional=${table}.short_notional+excluded.short_notional`,
    params: [
      value.instrument,
      Math.floor(value.ts / MINUTE) * MINUTE,
      1,
      long ? 1 : 0,
      long ? 0 : 1,
      value.notionalUsd,
      long ? value.notionalUsd : 0,
      long ? 0 : value.notionalUsd,
    ],
  };
}

/** Invoke inside the same transaction as the durable raw observation. */
export async function projectTradePg(
  client: Pick<PoolClient, "query">,
  value: TradeEvent,
): Promise<void> {
  validateTrade(value);
  const fingerprint = economicFingerprint(value);
  const member = membership("paperdash_", value, fingerprint);
  if ((await client.query(pgSql(member.sql), member.params)).rowCount === 1) {
    const update = fingerprintUpdate("paperdash_", value, fingerprint);
    const result = await client.query(pgSql(update.sql), update.params);
    if (Number(result.rows[0].delta) === 1) {
      const minute = minuteUpdate("paperdash_", value);
      await client.query(pgSql(minute.sql), minute.params);
    }
  }
  // A separate applied-count checkpoint lets v2 wallet projection catch up
  // previously projected asset observations without counting them twice.
  await client.query(
    "INSERT INTO paperdash_analytics_wallet_fingerprints VALUES($1,$2,$3,$4,0) ON CONFLICT(fingerprint) DO NOTHING",
    [fingerprint, value.wallet, value.ts, value.notionalUsd],
  );
  const prior = (
    await client.query(
      "SELECT effective_count FROM paperdash_analytics_wallet_fingerprints WHERE fingerprint=$1 FOR UPDATE",
      [fingerprint],
    )
  ).rows[0];
  const current = (
    await client.query(
      "SELECT CASE WHEN stream_count>recent_count THEN stream_count ELSE recent_count END AS count FROM paperdash_analytics_fingerprints WHERE fingerprint=$1",
      [fingerprint],
    )
  ).rows[0];
  const delta = Number(current.count) - Number(prior.effective_count);
  if (delta > 0) {
    const update = walletMinute("paperdash_", value, delta);
    await client.query(pgSql(update.sql), update.params);
    await client.query(
      "UPDATE paperdash_analytics_wallet_fingerprints SET effective_count=$1 WHERE fingerprint=$2",
      [current.count, fingerprint],
    );
  }
}
/** Synchronous, so another SQLite write cannot interleave this transaction. */
export function projectTradeSqlite(db: DatabaseSync, value: TradeEvent): void {
  validateTrade(value);
  const fingerprint = economicFingerprint(value);
  const member = membership("", value, fingerprint);
  if (db.prepare(member.sql).run(...member.params).changes === 1) {
    const update = fingerprintUpdate("", value, fingerprint);
    const result = db.prepare(update.sql).get(...update.params) as {
      delta: number;
    };
    if (result.delta === 1) {
      const minute = minuteUpdate("", value);
      db.prepare(minute.sql).run(...minute.params);
    }
  }
  db.prepare(
    "INSERT INTO analytics_wallet_fingerprints VALUES(?,?,?,?,0) ON CONFLICT(fingerprint) DO NOTHING",
  ).run(fingerprint, value.wallet, value.ts, value.notionalUsd);
  const prior = db
    .prepare(
      "SELECT effective_count FROM analytics_wallet_fingerprints WHERE fingerprint=?",
    )
    .get(fingerprint) as { effective_count: number };
  const current = db
    .prepare(
      "SELECT CASE WHEN stream_count>recent_count THEN stream_count ELSE recent_count END AS count FROM analytics_fingerprints WHERE fingerprint=?",
    )
    .get(fingerprint) as { count: number };
  const delta = current.count - prior.effective_count;
  if (delta > 0) {
    const update = walletMinute("", value, delta);
    db.prepare(update.sql).run(...update.params);
    db.prepare(
      "UPDATE analytics_wallet_fingerprints SET effective_count=? WHERE fingerprint=?",
    ).run(current.count, fingerprint);
  }
}
function walletMinute(prefix: string, value: TradeEvent, delta: number): Query {
  const table = `${prefix}analytics_wallet_minutes`;
  return {
    sql: `INSERT INTO ${table} VALUES(?,?,?,?) ON CONFLICT(wallet,time) DO UPDATE SET event_count=${table}.event_count+excluded.event_count,notional=${table}.notional+excluded.notional`,
    params: [
      value.wallet,
      Math.floor(value.ts / MINUTE) * MINUTE,
      delta,
      value.notionalUsd * delta,
    ],
  };
}
interface ReadDb {
  prefix: string;
  rows<T>(sql: string, params?: (string | number)[]): Promise<T[]>;
}
function oiUpdate(
  prefix: string,
  input: Omit<AssetOiSample, "receivedAt"> & { receivedAt?: number },
): Query {
  if (
    !Number.isSafeInteger(input.instrument) ||
    input.instrument < 0 ||
    !Number.isSafeInteger(input.time) ||
    input.time < 0 ||
    !Number.isSafeInteger(input.sourceAt) ||
    input.sourceAt < 0 ||
    ![input.longRaw, input.shortRaw].every((v) => /^(0|[1-9]\d*)$/.test(v)) ||
    (input.sourceBlock !== null && !/^(0|[1-9]\d*)$/.test(input.sourceBlock))
  )
    throw new Error("Invalid open-interest sample");
  const table = `${prefix}analytics_oi_samples`;
  return {
    sql: `INSERT INTO ${table} VALUES(?,?,?,?,?,?,?) ON CONFLICT(instrument,time) DO UPDATE SET long_raw=excluded.long_raw,short_raw=excluded.short_raw,source_block=excluded.source_block,source_at=excluded.source_at,received_at=excluded.received_at WHERE ${table}.source_at<excluded.source_at OR (${table}.source_at=excluded.source_at AND ${table}.received_at<=excluded.received_at)`,
    params: [
      input.instrument,
      Math.floor(input.time / MINUTE) * MINUTE,
      input.longRaw,
      input.shortRaw,
      input.sourceBlock,
      input.sourceAt,
      input.receivedAt ?? Date.now(),
    ],
  };
}
const parsed = <T>(value: unknown): T =>
  (typeof value === "string" ? JSON.parse(value) : value) as T;
type Totals = {
  event_count: string | number | null;
  long_count: string | number | null;
  short_count: string | number | null;
  notional: string | number | null;
  long_notional: string | number | null;
  short_notional: string | number | null;
};
function readAnalytics(
  db: ReadDb,
): Pick<AnalyticsStore, "activity" | "samples" | "walletActivity"> {
  const f = `${db.prefix}analytics_fingerprints`,
    m = `${db.prefix}analytics_minutes`;
  const effective =
    "CASE WHEN stream_count>recent_count THEN stream_count ELSE recent_count END";
  return {
    async activity(instruments, now = Date.now()) {
      if (
        !Number.isSafeInteger(now) ||
        now < 0 ||
        instruments.some((i) => !Number.isSafeInteger(i) || i < 0)
      )
        throw new Error("Invalid activity window");
      const from = Math.max(0, now - DAY),
        fullFrom = Math.ceil(from / MINUTE) * MINUTE,
        fullTo = Math.floor(now / MINUTE) * MINUTE;
      const [{ complete }] = await db.rows<{ complete: number }>(
        `SELECT complete FROM ${db.prefix}analytics_state WHERE id=2`,
      );
      return Promise.all(
        [...new Set(instruments)].map(async (instrument) => {
          const [bucket] = await db.rows<Totals>(
            `SELECT sum(event_count) AS event_count,sum(long_count) AS long_count,sum(short_count) AS short_count,sum(notional) AS notional,sum(long_notional) AS long_notional,sum(short_notional) AS short_notional FROM ${m} WHERE instrument=? AND time>=? AND time<?`,
            [instrument, fullFrom, fullTo],
          );
          const [edge] = await db.rows<Totals>(
            `SELECT sum(n) AS event_count,sum(CASE WHEN side='long' THEN n ELSE 0 END) AS long_count,sum(CASE WHEN side='short' THEN n ELSE 0 END) AS short_count,sum(notional*n) AS notional,sum(CASE WHEN side='long' THEN notional*n ELSE 0 END) AS long_notional,sum(CASE WHEN side='short' THEN notional*n ELSE 0 END) AS short_notional FROM (SELECT side,notional,${effective} AS n FROM ${f} WHERE instrument=? AND ((source_at>=? AND source_at<?) OR (source_at>=? AND source_at<=?))) boundary`,
            [instrument, from, fullFrom, fullTo, now],
          );
          const first = await db.rows<{ source_at: number | string }>(
            `SELECT source_at FROM ${f} WHERE instrument=? ORDER BY source_at LIMIT 1`,
            [instrument],
          );
          const last = await db.rows<{ source_at: number | string }>(
            `SELECT source_at FROM ${f} WHERE instrument=? ORDER BY source_at DESC LIMIT 1`,
            [instrument],
          );
          const groups = await db.rows<{
            fingerprint: string;
            stream_count: string | number;
            recent_count: string | number;
          }>(
            `SELECT fingerprint,stream_count,recent_count FROM ${f} WHERE instrument=? AND source_at>=? AND source_at<=? ORDER BY source_at DESC,fingerprint DESC LIMIT 8`,
            [instrument, from, now],
          );
          const recent: TradeEvent[] = [];
          for (const group of groups) {
            if (recent.length === 8) break;
            const provenance =
              Number(group.recent_count) >= Number(group.stream_count)
                ? "recent-api"
                : "public-stream";
            const rows = await db.rows<{ payload: unknown }>(
              `SELECT r.payload FROM ${db.prefix}analytics_members a JOIN ${db.prefix}trade_observations r ON r.id=a.id WHERE a.fingerprint=? AND a.provenance=? ORDER BY a.id DESC LIMIT ?`,
              [group.fingerprint, provenance, 8 - recent.length],
            );
            recent.push(...rows.map((r) => parsed<TradeEvent>(r.payload)));
          }
          const total = (key: keyof Totals) =>
            Number(bucket[key] ?? 0) + Number(edge[key] ?? 0);
          return {
            instrument,
            windowFrom: from,
            windowTo: now,
            counts: {
              total: total("event_count"),
              long: total("long_count"),
              short: total("short_count"),
            },
            notionalUsd: {
              total: total("notional"),
              long: total("long_notional"),
              short: total("short_notional"),
            },
            recent,
            coverage: {
              observedFrom: first.length ? Number(first[0].source_at) : null,
              latestObservedAt: last.length ? Number(last[0].source_at) : null,
              projectionBackfillComplete: Number(complete) === 1,
              identityAmbiguous: true as const,
              source: "retained-public-observations" as const,
            },
          };
        }),
      );
    },
    async samples(instrument, fromMs = Date.now() - DAY, limit = 1440) {
      if (
        !Number.isSafeInteger(instrument) ||
        instrument < 0 ||
        !Number.isSafeInteger(fromMs)
      )
        throw new Error("Invalid open-interest history query");
      return (
        await db.rows<{
          instrument: number;
          time: string | number;
          long_raw: string;
          short_raw: string;
          source_block: string | null;
          source_at: string | number;
          received_at: string | number;
        }>(
          `SELECT * FROM ${db.prefix}analytics_oi_samples WHERE instrument=? AND time>=? ORDER BY time DESC LIMIT ?`,
          [instrument, fromMs, Math.max(1, Math.min(10000, Math.floor(limit)))],
        )
      )
        .reverse()
        .map((r) => ({
          instrument: r.instrument,
          time: Number(r.time),
          longRaw: r.long_raw,
          shortRaw: r.short_raw,
          sourceBlock: r.source_block,
          sourceAt: Number(r.source_at),
          receivedAt: Number(r.received_at),
        }));
    },
    async walletActivity(sort = "volume", page = 0, q = "", now = Date.now()) {
      if (
        !["volume", "trades"].includes(sort) ||
        !Number.isSafeInteger(page) ||
        page < 0 ||
        page > 1000000 ||
        !/^(?:0x)?[a-f0-9]{0,40}$/i.test(q) ||
        !Number.isSafeInteger(now) ||
        now < 0
      )
        throw new Error("Invalid observed-wallet ranking query");
      const from = Math.max(0, now - DAY),
        fullFrom = Math.ceil(from / MINUTE) * MINUTE,
        fullTo = Math.floor(now / MINUTE) * MINUTE;
      const match = q
        ? `${q.toLowerCase().startsWith("0x") ? q.toLowerCase() : `0x${q.toLowerCase()}`}%`
        : "%";
      const cte = `WITH parts AS (SELECT wallet,event_count,notional FROM ${db.prefix}analytics_wallet_minutes WHERE time>=? AND time<? AND wallet LIKE ? UNION ALL SELECT wallet,effective_count AS event_count,notional*effective_count AS notional FROM ${db.prefix}analytics_wallet_fingerprints WHERE ((source_at>=? AND source_at<?) OR (source_at>=? AND source_at<=?)) AND wallet LIKE ?), totals AS (SELECT wallet,sum(event_count) AS event_count,sum(notional) AS notional FROM parts GROUP BY wallet)`;
      const args = [
        fullFrom,
        fullTo,
        match,
        from,
        fullFrom,
        fullTo,
        now,
        match,
      ];
      const rows = await db.rows<{
        wallet: string;
        event_count: string | number;
        notional: string | number;
        total: string | number;
      }>(
        `${cte} SELECT wallet,event_count,notional,count(*) OVER() AS total FROM totals ORDER BY ${sort === "volume" ? "notional" : "event_count"} DESC,wallet LIMIT 25 OFFSET ?`,
        [...args, page * 25],
      );
      const count = rows.length
        ? Number(rows[0].total)
        : page
          ? Number(
              (
                await db.rows<{ count: number | string }>(
                  `${cte} SELECT count(*) AS count FROM totals`,
                  args,
                )
              )[0].count,
            )
          : 0;
      const [{ complete }] = await db.rows<{ complete: number }>(
        `SELECT complete FROM ${db.prefix}analytics_state WHERE id=2`,
      );
      const first = await db.rows<{ source_at: number | string }>(
        `SELECT source_at FROM ${db.prefix}analytics_wallet_fingerprints ORDER BY source_at LIMIT 1`,
      );
      const last = await db.rows<{ source_at: number | string }>(
        `SELECT source_at FROM ${db.prefix}analytics_wallet_fingerprints ORDER BY source_at DESC LIMIT 1`,
      );
      return {
        rows: rows.map((r) => ({
          address: r.wallet,
          count: Number(r.event_count),
          notionalUsd: Number(r.notional),
        })),
        count,
        page,
        pageSize: 25,
        windowFrom: from,
        windowTo: now,
        coverage: {
          observedFrom: first.length ? Number(first[0].source_at) : null,
          latestObservedAt: last.length ? Number(last[0].source_at) : null,
          projectionBackfillComplete: Number(complete) === 1,
          identityAmbiguous: true,
          source: "retained-public-observations",
        },
      };
    },
  };
}

export function createPgAnalytics(pool: Pool): AnalyticsStore {
  return {
    ...readAnalytics({
      prefix: "paperdash_",
      async rows<T>(sql: string, params: (string | number)[] = []) {
        return (await pool.query(pgSql(sql), params)).rows as T[];
      },
    }),
    async sample(value) {
      const q = oiUpdate("paperdash_", value);
      await pool.query(pgSql(q.sql), q.params);
    },
    async backfill(limit = 500) {
      const client = await pool.connect();
      let processed = 0;
      try {
        limit = Math.max(1, Math.min(5000, Math.floor(limit)));
        // One observation per transaction avoids holding minute-bucket locks
        // while waiting for another fingerprint a live writer already owns.
        // The projection and resume cursor still commit together each time.
        while (processed < limit) {
          await client.query("BEGIN");
          const state = (
            await client.query(
              "SELECT cursor,complete FROM paperdash_analytics_state WHERE id=2 FOR UPDATE",
            )
          ).rows[0];
          if (state.complete === 1) {
            await client.query("COMMIT");
            return { processed, complete: true };
          }
          const row = (
            await client.query(
              "SELECT id,payload FROM paperdash_trade_observations WHERE id>$1 ORDER BY id LIMIT 1",
              [state.cursor],
            )
          ).rows[0];
          if (!row) {
            await client.query(
              "UPDATE paperdash_analytics_state SET complete=1 WHERE id=2",
            );
            await client.query("COMMIT");
            return { processed, complete: true };
          }
          await projectTradePg(client, row.payload as TradeEvent);
          await client.query(
            "UPDATE paperdash_analytics_state SET cursor=$1 WHERE id=2",
            [row.id],
          );
          await client.query("COMMIT");
          processed++;
        }
        return { processed, complete: false };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
export function createLocalAnalytics(
  db: DatabaseSync,
  writable: () => Promise<void>,
): AnalyticsStore {
  return {
    ...readAnalytics({
      prefix: "",
      async rows<T>(sql: string, params: (string | number)[] = []) {
        return db.prepare(sql).all(...params) as T[];
      },
    }),
    async sample(value) {
      await writable();
      const q = oiUpdate("", value);
      db.prepare(q.sql).run(...q.params);
    },
    async backfill(limit = 500) {
      await writable();
      db.exec("BEGIN IMMEDIATE");
      try {
        const state = db
          .prepare("SELECT cursor,complete FROM analytics_state WHERE id=2")
          .get() as { cursor: string; complete: number };
        if (state.complete === 1) {
          db.exec("COMMIT");
          return { processed: 0, complete: true };
        }
        limit = Math.max(1, Math.min(5000, Math.floor(limit)));
        const rows = db
          .prepare(
            "SELECT id,payload FROM trade_observations WHERE id>? ORDER BY id LIMIT ?",
          )
          .all(state.cursor, limit) as { id: string; payload: string }[];
        for (const row of rows)
          projectTradeSqlite(db, JSON.parse(row.payload) as TradeEvent);
        const complete = rows.length < limit;
        db.prepare(
          "UPDATE analytics_state SET cursor=?,complete=? WHERE id=2",
        ).run(rows.at(-1)?.id ?? state.cursor, complete ? 1 : 0);
        db.exec("COMMIT");
        return { processed: rows.length, complete };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
