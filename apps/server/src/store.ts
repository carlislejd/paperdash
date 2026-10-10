import { DatabaseSync } from "node:sqlite";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import type {
  StreamMessage,
  TradeEvent,
} from "../../../packages/shared/src/types.js";
import { config } from "./config.js";
import {
  analyticsSchemaSql,
  createLocalAnalytics,
  createPgAnalytics,
  economicFingerprint,
  projectTradePg,
  projectTradeSqlite,
  type AnalyticsStore,
} from "./analytics-store.js";
import {
  createHistoryStore,
  historySchemaSql,
  type HistoryStore,
} from "./history-store.js";
import {
  createLocalPositionMetrics,
  createPgPositionMetrics,
  positionMetricsSchemaSql,
  type PositionMetricsStore,
} from "./position-metrics-store.js";

export interface Saved<T> {
  value: T;
  receivedAt: number;
}
export interface StreamRecord {
  id: string;
  message: StreamMessage;
}
export interface Store {
  kind: "postgres" | "local";
  history: HistoryStore;
  analytics: AnalyticsStore;
  positionMetrics: PositionMetricsStore;
  get<T>(key: string): Promise<Saved<T> | null>;
  put(key: string, value: unknown, receivedAt?: number): Promise<void>;
  trade(value: TradeEvent): Promise<boolean>;
  recordTrade(value: TradeEvent): Promise<boolean>;
  trades(limit?: number): Promise<TradeEvent[]>;
  sample(time: number, value: number): Promise<void>;
  samples(): Promise<{ time: number; value: number }[]>;
  event(message: StreamMessage): Promise<string>;
  events(after?: string, limit?: number): Promise<StreamRecord[]>;
  eventBounds(): Promise<{ oldest: string | null; latest: string | null }>;
  lease(): Promise<(() => Promise<void>) | null>;
  health(): Promise<boolean>;
  close(): Promise<void>;
}

const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS paperdash_snapshots (key text PRIMARY KEY, payload jsonb NOT NULL, received_at bigint NOT NULL);
CREATE TABLE IF NOT EXISTS paperdash_trade_observations (id text PRIMARY KEY, payload jsonb NOT NULL, source_at bigint NOT NULL, received_at bigint NOT NULL);
CREATE INDEX IF NOT EXISTS paperdash_trade_time ON paperdash_trade_observations (source_at DESC);
CREATE TABLE IF NOT EXISTS paperdash_samples (time bigint PRIMARY KEY, value double precision NOT NULL);
CREATE TABLE IF NOT EXISTS paperdash_stream_events (id bigserial PRIMARY KEY, payload jsonb NOT NULL);
`;
export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(74481231, 0)");
    await client.query(PG_SCHEMA);
    await client.query(historySchemaSql("paperdash_", true));
    await client.query(analyticsSchemaSql("paperdash_", true));
    await client.query(positionMetricsSchemaSql("paperdash_", true));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createStore(
  options: {
    databaseUrl?: string;
    dataDir?: string;
    maxBytes?: number;
    memory?: boolean;
    autoMigrate?: boolean;
  } = {},
): Promise<Store> {
  const databaseUrl = options.databaseUrl ?? config.databaseUrl;
  if (databaseUrl) {
    const pool = new Pool({
      connectionString: databaseUrl,
      max: 6,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      statement_timeout: 10000,
    });
    pool.on("error", (error) =>
      console.error("Database connection error:", error.message),
    );
    if (options.autoMigrate ?? config.autoMigrate) await migrate(pool);
    else
      await pool
        .query(
          "SELECT 1 FROM paperdash_snapshots LIMIT 0; SELECT 1 FROM paperdash_history_jobs LIMIT 0; SELECT 1 FROM paperdash_history_corrections LIMIT 0; SELECT 1 FROM paperdash_analytics_state LIMIT 0; SELECT 1 FROM paperdash_position_metrics_state LIMIT 0",
        )
        .catch(() => {
          throw new Error(
            "Database schema is unavailable; run npm run db:migrate with the schema owner.",
          );
        });
    let leaseClient: PoolClient | null = null;
    let leaseErrorListener: (() => void) | null = null;
    function releaseCollectorLease() {
      const client = leaseClient;
      if (!client) return;
      leaseClient = null;
      if (leaseErrorListener) {
        client.removeListener("error", leaseErrorListener);
        leaseErrorListener = null;
      }
      // Closing this dedicated session releases its advisory lock. Do not
      // return a possibly still-locked session to the pool after an unlock
      // query failure, or retain an old owner's fatal listener on a pool client.
      client.release(true);
    }
    const sql = (text: string) => {
      let i = 0;
      return text.replace(/\?/g, () => `$${++i}`);
    };
    const history = createHistoryStore({
      prefix: "paperdash_",
      async rows<T>(statement: string, params: unknown[] = []) {
        return (await pool.query(sql(statement), params)).rows as T[];
      },
      async batch(statements) {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          for (const statement of statements) {
            const result = await c.query(sql(statement.sql), statement.params);
            if (
              statement.requireChanges !== undefined &&
              result.rowCount !== statement.requireChanges
            )
              throw new Error("History job lease changed");
          }
          await c.query("COMMIT");
        } catch (error) {
          await c.query("ROLLBACK");
          throw error;
        } finally {
          c.release();
        }
      },
    });
    return {
      kind: "postgres",
      history,
      analytics: createPgAnalytics(pool),
      positionMetrics: createPgPositionMetrics(pool),
      async get<T>(key: string) {
        const r = await pool.query(
          "SELECT payload,received_at FROM paperdash_snapshots WHERE key=$1",
          [key],
        );
        return r.rows[0]
          ? {
              value: r.rows[0].payload as T,
              receivedAt: Number(r.rows[0].received_at),
            }
          : null;
      },
      async put(key, value, receivedAt = Date.now()) {
        await pool.query(
          "INSERT INTO paperdash_snapshots VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET payload=EXCLUDED.payload,received_at=EXCLUDED.received_at WHERE paperdash_snapshots.received_at <= EXCLUDED.received_at",
          [key, JSON.stringify(value), receivedAt],
        );
      },
      async trade(value) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const r = await client.query(
            "INSERT INTO paperdash_trade_observations VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
            [value.id, JSON.stringify(value), value.ts, Date.now()],
          );
          if (r.rowCount === 1) await projectTradePg(client, value);
          await client.query("COMMIT");
          return r.rowCount === 1;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
      async recordTrade(value) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const inserted = await client.query(
            "INSERT INTO paperdash_trade_observations VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
            [value.id, JSON.stringify(value), value.ts, Date.now()],
          );
          if (inserted.rowCount !== 1) {
            await client.query("COMMIT");
            return false;
          }
          await projectTradePg(client, value);
          const event = await client.query(
            "INSERT INTO paperdash_stream_events(payload) VALUES($1) RETURNING id",
            [JSON.stringify({ type: "trade", data: value })],
          );
          await client.query(
            "DELETE FROM paperdash_stream_events WHERE id <= $1::bigint - 1000",
            [event.rows[0].id],
          );
          await client.query("COMMIT");
          return true;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
      async trades(limit = 100) {
        const r = await pool.query(
          "SELECT payload FROM paperdash_trade_observations ORDER BY source_at DESC,id DESC LIMIT $1",
          [Math.min(limit, 500)],
        );
        return r.rows.map((r) => r.payload as TradeEvent);
      },
      async sample(time, value) {
        await pool.query(
          "INSERT INTO paperdash_samples VALUES($1,$2) ON CONFLICT (time) DO UPDATE SET value=EXCLUDED.value",
          [time, value],
        );
      },
      async samples() {
        const r = await pool.query(
          "SELECT time,value FROM paperdash_samples ORDER BY time DESC LIMIT 1440",
        );
        return r.rows
          .map((r) => ({ time: Number(r.time), value: Number(r.value) }))
          .reverse();
      },
      async event(message) {
        const r = await pool.query(
          "INSERT INTO paperdash_stream_events(payload) VALUES($1) RETURNING id",
          [JSON.stringify(message)],
        );
        // Only replay notifications expire. Financial observations above never do.
        await pool.query(
          "DELETE FROM paperdash_stream_events WHERE id <= $1::bigint - 1000",
          [r.rows[0].id],
        );
        return String(r.rows[0].id);
      },
      async events(after = "0", limit = 1000) {
        const r = await pool.query(
          "SELECT id,payload FROM paperdash_stream_events WHERE id > $1 ORDER BY id LIMIT $2",
          [after, Math.min(limit, 1000)],
        );
        return r.rows.map((r) => ({
          id: String(r.id),
          message: r.payload as StreamMessage,
        }));
      },
      async eventBounds() {
        const r = await pool.query(
          "SELECT min(id) oldest,max(id) latest FROM paperdash_stream_events",
        );
        return {
          oldest: r.rows[0].oldest && String(r.rows[0].oldest),
          latest: r.rows[0].latest && String(r.rows[0].latest),
        };
      },
      async lease() {
        const c = await pool.connect();
        let acquired: boolean;
        try {
          const r = await c.query(
            "SELECT pg_try_advisory_lock(74481231,1) acquired",
          );
          acquired = r.rows[0].acquired === true;
        } catch (error) {
          // A failed query can still have acquired the server-side lock before
          // its response was lost. Destroy the session and never leak checkout.
          c.release(true);
          throw error;
        }
        if (!acquired) {
          c.release();
          return null;
        }
        leaseClient = c;
        leaseErrorListener = () => {
          if (leaseClient !== c) return;
          console.error(
            "Collector database lease connection lost. Exiting to prevent concurrent ingestion.",
          );
          // PostgreSQL has already released ownership. Graceful draining here
          // would let old writes overlap a replacement collector's ingestion.
          process.exit(1);
        };
        c.on("error", leaseErrorListener);
        return async () => {
          if (leaseClient === c) releaseCollectorLease();
        };
      },
      async health() {
        try {
          await pool.query("SELECT 1");
          return true;
        } catch {
          return false;
        }
      },
      async close() {
        releaseCollectorLease();
        await pool.end();
      },
    };
  }
  const dataDir = options.dataDir ?? config.dataDir;
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, "paperdash.sqlite");
  const db = new DatabaseSync(options.memory ? ":memory:" : path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS snapshots (key TEXT PRIMARY KEY,payload TEXT NOT NULL,received_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS trade_observations (id TEXT PRIMARY KEY,payload TEXT NOT NULL,source_at INTEGER NOT NULL,received_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS trade_time ON trade_observations(source_at DESC);
    CREATE TABLE IF NOT EXISTS samples(time INTEGER PRIMARY KEY,value REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS stream_events(id INTEGER PRIMARY KEY AUTOINCREMENT,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS collector_lease(id INTEGER PRIMARY KEY,pid INTEGER NOT NULL);
  `);
  db.exec(historySchemaSql("", false));
  db.exec(analyticsSchemaSql("", false));
  db.exec(positionMetricsSchemaSql("", false));
  const maxBytes = options.maxBytes ?? config.localMaxBytes;
  let checkAt = 0;
  async function writable() {
    if (options.memory || Date.now() < checkAt) return;
    const bytes = (
      await Promise.all(
        [path, `${path}-wal`].map((p) =>
          stat(p)
            .then((s) => s.size)
            .catch(() => 0),
        ),
      )
    ).reduce((a, b) => a + b, 0);
    if (bytes >= maxBytes)
      throw new Error(
        "Local storage limit reached. Collection is paused; archive or increase LOCAL_MAX_BYTES. No durable trade observations were deleted.",
      );
    checkAt = Date.now() + 5000;
  }
  return {
    kind: "local",
    analytics: createLocalAnalytics(db, writable),
    positionMetrics: createLocalPositionMetrics(db, writable),
    history: createHistoryStore({
      prefix: "",
      async rows<T>(sql: string, params: unknown[] = []) {
        return db
          .prepare(sql)
          .all(...(params as (string | number | null)[])) as T[];
      },
      async batch(statements) {
        await writable();
        // No await inside this transaction: the synchronous SQLite connection
        // cannot interleave another collector write between these statements.
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const statement of statements) {
            const result = db
              .prepare(statement.sql)
              .run(...((statement.params ?? []) as (string | number | null)[]));
            if (
              statement.requireChanges !== undefined &&
              result.changes !== statement.requireChanges
            )
              throw new Error("History job lease changed");
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    }),
    async get<T>(key: string) {
      const r = db
        .prepare("SELECT payload,received_at FROM snapshots WHERE key=?")
        .get(key) as { payload: string; received_at: number } | undefined;
      return r
        ? { value: JSON.parse(r.payload) as T, receivedAt: r.received_at }
        : null;
    },
    async put(key, value, at = Date.now()) {
      await writable();
      db.prepare(
        "INSERT INTO snapshots VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,received_at=excluded.received_at WHERE snapshots.received_at <= excluded.received_at",
      ).run(key, JSON.stringify(value), at);
    },
    async trade(value) {
      await writable();
      db.exec("BEGIN IMMEDIATE");
      try {
        const inserted =
          db
            .prepare("INSERT OR IGNORE INTO trade_observations VALUES(?,?,?,?)")
            .run(value.id, JSON.stringify(value), value.ts, Date.now())
            .changes === 1;
        if (inserted) projectTradeSqlite(db, value);
        db.exec("COMMIT");
        return inserted;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async recordTrade(value) {
      await writable();
      db.exec("BEGIN IMMEDIATE");
      try {
        const inserted = db
          .prepare("INSERT OR IGNORE INTO trade_observations VALUES(?,?,?,?)")
          .run(value.id, JSON.stringify(value), value.ts, Date.now());
        if (inserted.changes !== 1) {
          db.exec("COMMIT");
          return false;
        }
        projectTradeSqlite(db, value);
        const event = db
          .prepare("INSERT INTO stream_events(payload) VALUES(?)")
          .run(JSON.stringify({ type: "trade", data: value }));
        db.prepare("DELETE FROM stream_events WHERE id <= ?").run(
          Number(event.lastInsertRowid) - 1000,
        );
        db.exec("COMMIT");
        return true;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async trades(limit = 100) {
      return (
        db
          .prepare(
            "SELECT payload FROM trade_observations ORDER BY source_at DESC,id DESC LIMIT ?",
          )
          .all(Math.min(limit, 500)) as { payload: string }[]
      ).map((r) => JSON.parse(r.payload));
    },
    async sample(time, value) {
      await writable();
      db.prepare(
        "INSERT INTO samples VALUES(?,?) ON CONFLICT(time) DO UPDATE SET value=excluded.value",
      ).run(time, value);
    },
    async samples() {
      return (
        db
          .prepare(
            "SELECT time,value FROM samples ORDER BY time DESC LIMIT 1440",
          )
          .all() as unknown as { time: number; value: number }[]
      ).reverse();
    },
    async event(message) {
      await writable();
      const r = db
        .prepare("INSERT INTO stream_events(payload) VALUES(?)")
        .run(JSON.stringify(message));
      db.prepare("DELETE FROM stream_events WHERE id <= ?").run(
        Number(r.lastInsertRowid) - 1000,
      );
      return String(r.lastInsertRowid);
    },
    async events(after = "0", limit = 1000) {
      return (
        db
          .prepare(
            "SELECT id,payload FROM stream_events WHERE id>? ORDER BY id LIMIT ?",
          )
          .all(Number(after), Math.min(limit, 1000)) as {
          id: number;
          payload: string;
        }[]
      ).map((r) => ({ id: String(r.id), message: JSON.parse(r.payload) }));
    },
    async eventBounds() {
      const r = db
        .prepare("SELECT min(id) oldest,max(id) latest FROM stream_events")
        .get() as { oldest: number | null; latest: number | null };
      return {
        oldest: r.oldest === null ? null : String(r.oldest),
        latest: r.latest === null ? null : String(r.latest),
      };
    },
    async lease() {
      db.exec("BEGIN IMMEDIATE");
      try {
        const r = db
          .prepare("SELECT pid FROM collector_lease WHERE id=1")
          .get() as { pid: number } | undefined;
        if (r) {
          let alive = true;
          try {
            process.kill(r.pid, 0);
          } catch {
            alive = false;
          }
          if (alive) {
            db.exec("ROLLBACK");
            return null;
          }
        }
        db.prepare("INSERT OR REPLACE INTO collector_lease VALUES(1,?)").run(
          process.pid,
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return async () => {
        db.prepare("DELETE FROM collector_lease WHERE id=1 AND pid=?").run(
          process.pid,
        );
      };
    },
    async health() {
      try {
        db.prepare("SELECT 1").get();
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      db.close();
    },
  };
}

export function tradeFingerprint(t: TradeEvent): string {
  return economicFingerprint(t);
}
export function visibleTrades(trades: TradeEvent[]): TradeEvent[] {
  const recent = new Map<string, number>();
  for (const trade of trades)
    if (trade.provenance === "recent-api") {
      const fingerprint = tradeFingerprint(trade);
      recent.set(fingerprint, (recent.get(fingerprint) ?? 0) + 1);
    }
  return trades
    .filter((trade) => {
      if (trade.provenance !== "public-stream") return true;
      const fingerprint = tradeFingerprint(trade),
        matches = recent.get(fingerprint) ?? 0;
      if (matches > 0) {
        recent.set(fingerprint, matches - 1);
        return false;
      }
      return true;
    })
    .slice(0, 50);
}
