import type { DatabaseSync } from "node:sqlite";
import type { Pool } from "pg";
import type {
  Account,
  TradeEvent,
  WalletBatchResponse,
} from "../../../packages/shared/src/types.js";
import { accountSchema, addressSchema } from "./schemas.js";
import { rollbackPg } from "./pg-deadline.js";

export const accountKey = (address: string) => `account-summary:${address}`;
export const WATCH_TTL = 120000;
export const WATCH_REFRESH = 60000;
export const WATCH_CAP = 1000;
export interface FollowingStore {
  retainAccounts(
    accounts: Account[],
    receivedAt: number,
    rescheduleWatches?: boolean,
  ): Promise<void>;
  touch(addresses: string[], now?: number): Promise<string[]>;
  nextWatch(
    now?: number,
  ): Promise<{ address: string; failures: number } | null>;
  failWatch(
    address: string,
    failures: number,
    now?: number,
    retryAt?: number,
  ): Promise<void>;
  completeWatch(address: string, receivedAt: number): Promise<void>;
  activity(
    addresses: string[],
    now?: number,
  ): Promise<WalletBatchResponse["activity"]>;
}
export function followingSchemaSql(prefix: string, pg: boolean): string {
  const int = pg ? "BIGINT" : "INTEGER";
  return `CREATE TABLE IF NOT EXISTS ${prefix}wallet_watches(address TEXT PRIMARY KEY,watch_until ${int} NOT NULL,next_run ${int} NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS ${prefix}wallet_watches_due ON ${prefix}wallet_watches(next_run,address);
    CREATE INDEX IF NOT EXISTS ${prefix}wallet_watches_expiry ON ${prefix}wallet_watches(watch_until,address);`;
}
const pgSql = (sql: string) => {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
};
const parsed = <T>(value: unknown): T =>
  (typeof value === "string" ? JSON.parse(value) : value) as T;
export function batchAddresses(addresses: string[]): string[] {
  if (!addresses.length || addresses.length > 25)
    throw new Error("Expected 1 to 25 wallet addresses");
  return [...new Set(addresses.map((a) => addressSchema.parse(a)))].sort();
}
function time(now: number) {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error("Invalid wallet observation time");
}
interface Db {
  prefix: string;
  pg: boolean;
  rows<T>(sql: string, args?: (string | number)[]): Promise<T[]>;
  transaction<T>(run: (db: Db) => Promise<T>): Promise<T>;
}
function createFollowing(db: Db): FollowingStore {
  const watches = `${db.prefix}wallet_watches`,
    snapshots = `${db.prefix}snapshots`;
  return {
    async retainAccounts(input, receivedAt, rescheduleWatches = false) {
      time(receivedAt);
      if (input.length > 200) throw new Error("Too many account summaries");
      const accounts = input.map((a) => accountSchema.parse(a));
      if (!accounts.length) return;
      // Original source receipt time is never replaced by a later cache read time.
      const values = accounts.map(() => "(?,?,?)").join(",");
      await db.transaction(async (tx) => {
        const changed = await tx.rows<{ key: string }>(
          `INSERT INTO ${snapshots}(key,payload,received_at) VALUES ${values} ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,received_at=excluded.received_at WHERE ${snapshots}.received_at<excluded.received_at RETURNING key`,
          accounts.flatMap((a) => [
            accountKey(a.address),
            JSON.stringify(a),
            receivedAt,
          ]),
        );
        const changedAddresses = changed.map((r) =>
          r.key.slice("account-summary:".length),
        );
        if (rescheduleWatches && changedAddresses.length)
          await tx.rows(
            `UPDATE ${watches} SET next_run=CASE WHEN next_run>? THEN next_run ELSE ? END,failures=0 WHERE address IN (${changedAddresses.map(() => "?").join(",")})`,
            [
              receivedAt + WATCH_REFRESH,
              receivedAt + WATCH_REFRESH,
              ...changedAddresses,
            ],
          );
      });
    },
    async touch(input, now = Date.now()) {
      const addresses = batchAddresses(input);
      time(now);
      return db.transaction(async (tx) => {
        const warm = await tx.rows<{
          address: string;
          watch_until: string | number;
        }>(
          `SELECT address,watch_until FROM ${watches} WHERE address IN (${addresses.map(() => "?").join(",")})`,
          addresses,
        );
        // Polls sharing already-active wallets do not contend on admission or
        // rewrite their expiry. The collector cannot expire this cohort now.
        if (
          warm.length === addresses.length &&
          warm.every((r) => Number(r.watch_until) >= now + WATCH_TTL - 30000)
        )
          return warm.map((r) => r.address);
        // Separate namespace from migrations, the collector lease and event append.
        if (db.pg) await tx.rows("SELECT pg_advisory_xact_lock(74481235,0)");
        const existing = await tx.rows<{ address: string }>(
          `SELECT address FROM ${watches} WHERE address IN (${addresses.map(() => "?").join(",")})`,
          addresses,
        );
        const count = await tx.rows<{ n: string | number }>(
          `SELECT count(*) AS n FROM (SELECT address FROM ${watches} LIMIT ${WATCH_CAP}) bounded`,
        );
        const remaining = Math.max(0, WATCH_CAP - Number(count[0].n));
        const old = new Set(existing.map((r) => r.address));
        const requested = addresses.map(() => "(?)").join(",");
        const known = await tx.rows<{ address: string }>(
          `WITH requested(address) AS (VALUES ${requested}) SELECT address FROM requested WHERE EXISTS(SELECT 1 FROM ${db.prefix}history_wallets h WHERE h.address=requested.address) OR EXISTS(SELECT 1 FROM ${snapshots} s WHERE s.key='account-summary:'||requested.address) ORDER BY address`,
          addresses,
        );
        const admitted = [
          ...known.filter((r) => old.has(r.address)),
          ...known.filter((r) => !old.has(r.address)).slice(0, remaining),
        ].map((r) => r.address);
        if (admitted.length)
          await tx.rows(
            `INSERT INTO ${watches}(address,watch_until) VALUES ${admitted.map(() => "(?,?)").join(",")} ON CONFLICT(address) DO UPDATE SET watch_until=excluded.watch_until WHERE ${watches}.watch_until<?`,
            [
              ...admitted.flatMap((a) => [a, now + WATCH_TTL]),
              now + WATCH_TTL - 30000,
            ],
          );
        return admitted;
      });
    },
    async nextWatch(now = Date.now()) {
      time(now);
      return db.transaction(async (tx) => {
        await tx.rows(
          `DELETE FROM ${watches} WHERE address IN (SELECT address FROM ${watches} WHERE watch_until<=? ORDER BY watch_until,address LIMIT ${WATCH_CAP})`,
          [now],
        );
        // Collector ownership permits one consumer. Durable next_run also bounds retries after restart.
        const rows = await tx.rows<{ address: string; failures: number }>(
          `UPDATE ${watches} SET next_run=? WHERE address=(SELECT address FROM ${watches} WHERE watch_until>? AND next_run<=? ORDER BY next_run,address LIMIT 1) RETURNING address,failures`,
          [now + WATCH_REFRESH, now, now],
        );
        return rows[0] ?? null;
      });
    },
    async failWatch(address, failures, now = Date.now(), retryAt = 0) {
      address = addressSchema.parse(address);
      time(now);
      const next = Math.max(
        now + Math.min(300000, 15000 * 2 ** Math.min(5, failures)),
        Number.isSafeInteger(retryAt) ? retryAt : 0,
      );
      await db.rows(
        `UPDATE ${watches} SET next_run=CASE WHEN next_run>? THEN next_run ELSE ? END,failures=? WHERE address=?`,
        [next, next, Math.min(100, failures + 1), address],
      );
    },
    async completeWatch(address, receivedAt) {
      address = addressSchema.parse(address);
      time(receivedAt);
      await db.rows(
        `UPDATE ${watches} SET next_run=CASE WHEN next_run>? THEN next_run ELSE ? END,failures=0 WHERE address=?`,
        [receivedAt + WATCH_REFRESH, receivedAt + WATCH_REFRESH, address],
      );
    },
    async activity(input, now = Date.now()) {
      const addresses = batchAddresses(input);
      time(now);
      const from = Math.max(0, now - 86400000);
      const wf = `${db.prefix}analytics_wallet_fingerprints`,
        f = `${db.prefix}analytics_fingerprints`,
        m = `${db.prefix}analytics_members`;
      // At most 51 indexed fingerprints per wallet and 51 members per fingerprint.
      // Select the final 51 IDs before joining large immutable raw payloads.
      const branches = addresses.map(
        () => `SELECT * FROM (
        SELECT w.source_at,w.fingerprint,m.id,
          CASE WHEN f.stream_count>f.recent_count THEN f.stream_count ELSE f.recent_count END AS effective_count,
          row_number() OVER(PARTITION BY w.fingerprint ORDER BY m.id DESC) AS descending_ordinal
        FROM (SELECT fingerprint,source_at FROM ${wf} WHERE wallet=? AND source_at>=? AND source_at<=? AND effective_count>0 ORDER BY source_at DESC,fingerprint DESC LIMIT 51) w
        ${
          db.pg
            ? `JOIN LATERAL (SELECT stream_count,recent_count FROM ${f} WHERE fingerprint=w.fingerprint OFFSET 0) f ON true
        JOIN LATERAL (SELECT id FROM ${m} WHERE fingerprint=w.fingerprint AND provenance=CASE WHEN f.stream_count>f.recent_count THEN 'public-stream' ELSE 'recent-api' END ORDER BY id DESC LIMIT 51) m ON true`
            : `CROSS JOIN ${f} f CROSS JOIN ${m} m WHERE f.fingerprint=w.fingerprint AND m.fingerprint=w.fingerprint AND m.provenance=CASE WHEN f.stream_count>f.recent_count THEN 'public-stream' ELSE 'recent-api' END AND m.id IN (SELECT id FROM ${m} chosen WHERE chosen.fingerprint=w.fingerprint AND chosen.provenance=m.provenance ORDER BY id DESC LIMIT 51)`
        }
        ORDER BY w.source_at DESC,w.fingerprint DESC,m.id DESC LIMIT 51) wallet_events`,
      );
      const rows = await db.rows<{
        payload: unknown;
        fingerprint: string;
        effective_count: string | number;
        descending_ordinal: string | number;
      }>(
        `WITH candidates AS (${branches.join(" UNION ALL ")}), selected AS (SELECT * FROM candidates ORDER BY source_at DESC,fingerprint DESC,id DESC LIMIT 51) SELECT r.payload,s.fingerprint,s.effective_count,s.descending_ordinal FROM selected s ${db.pg ? `JOIN LATERAL (SELECT payload FROM ${db.prefix}trade_observations WHERE id=s.id OFFSET 0) r ON true` : `CROSS JOIN ${db.prefix}trade_observations r WHERE r.id=s.id`} ORDER BY s.source_at DESC,s.fingerprint DESC,s.id DESC`,
        addresses.flatMap((address) => [address, from, now]),
      );
      const coverage = (
        await db.rows<{
          complete: number | null;
          observed_from: string | number | null;
        }>(
          `SELECT (SELECT complete FROM ${db.prefix}analytics_state WHERE id=2) AS complete,(SELECT source_at FROM ${wf} WHERE source_at<=? ORDER BY source_at LIMIT 1) AS observed_from`,
          [now],
        )
      )[0];
      return {
        items: rows.slice(0, 50).map((row) => {
          const ordinal =
            Number(row.effective_count) - Number(row.descending_ordinal) + 1;
          if (!Number.isSafeInteger(ordinal) || ordinal < 1)
            throw new Error("Invalid activity multiplicity");
          return {
            ...parsed<TradeEvent>(row.payload),
            id: `activity:${row.fingerprint}:${ordinal}`,
          };
        }),
        windowFrom: from,
        windowTo: now,
        receivedAt: now,
        stale: false,
        coverage: {
          source: "retained-public-observations",
          partial: true,
          identityAmbiguous: true,
          observedFrom:
            coverage.observed_from === null
              ? null
              : Number(coverage.observed_from),
          projectionBackfillComplete: Number(coverage.complete) === 1,
          truncated: rows.length > 50,
        },
      };
    },
  };
}
export function createPgFollowing(pool: Pool): FollowingStore {
  const db: Db = {
    prefix: "paperdash_",
    pg: true,
    async rows<T>(sql: string, args: (string | number)[] = []) {
      return (await pool.query(pgSql(sql), args)).rows as T[];
    },
    async transaction<T>(run: (db: Db) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await run({
          ...db,
          async rows<R>(sql: string, args: (string | number)[] = []) {
            return (await client.query(pgSql(sql), args)).rows as R[];
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await rollbackPg(client);
        throw error;
      } finally {
        client.release();
      }
    },
  };
  return createFollowing(db);
}
export function createLocalFollowing(
  db: DatabaseSync,
  writable: () => Promise<void>,
): FollowingStore {
  // Serialize watch admission on this local process. Each SQLite statement is
  // atomic; no open SQLite transaction crosses an await on the shared connection.
  // Cache upsert and queue deferral may commit separately; a retry is harmless.
  let pending: Promise<unknown> = Promise.resolve();
  const adapter: Db = {
    prefix: "",
    pg: false,
    async rows<T>(sql: string, args: (string | number)[] = []) {
      return db.prepare(sql).all(...args) as T[];
    },
    async transaction<T>(run: (db: Db) => Promise<T>) {
      const result = pending.then(async () => {
        await writable();
        return run(adapter);
      });
      pending = result.catch(() => {});
      return result;
    },
  };
  return createFollowing(adapter);
}
