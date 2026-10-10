import type { DatabaseSync } from "node:sqlite";
import type { Pool } from "pg";
import { appendStreamEventPg } from "./stream-event-store.js";
import type {
  AssetPricePoint,
  TradeEvent,
} from "../../../packages/shared/src/types.js";

export interface MarketQuote {
  instrument: number;
  priceUsd: number;
  sourceAt: number;
  receivedAt: number;
  gapBefore?: boolean;
}
export interface MarketData {
  price: MarketQuote | null;
  points: AssetPricePoint[];
  rawTrades: TradeEvent[];
  observedFrom: number | null;
  tradesCapped: boolean;
}
export interface MarketStore {
  /** Saves the latest genuine quote per five-second bucket and its SSE notification atomically. */
  quote(value: MarketQuote): Promise<boolean>;
  read(instrument: number, now?: number): Promise<MarketData>;
}
export function marketSchemaSql(prefix: string, postgres: boolean) {
  const integer = postgres ? "bigint" : "INTEGER",
    real = postgres ? "double precision" : "REAL";
  const instrument = postgres
    ? "(payload->>'instrument')"
    : "json_extract(payload,'$.instrument')";
  return `CREATE TABLE IF NOT EXISTS ${prefix}market_prices(instrument INTEGER NOT NULL,time ${integer} NOT NULL,price_usd ${real} NOT NULL,source_at ${integer} NOT NULL,received_at ${integer} NOT NULL,gap_before INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(instrument,time));
${postgres ? `ALTER TABLE ${prefix}market_prices ADD COLUMN IF NOT EXISTS gap_before INTEGER NOT NULL DEFAULT 0;` : ""}
CREATE INDEX IF NOT EXISTS ${prefix}market_price_source ON ${prefix}market_prices(instrument,source_at DESC);
CREATE INDEX IF NOT EXISTS ${prefix}trade_instrument_time ON ${prefix}trade_observations(${instrument},source_at DESC,id DESC);`;
}
export function migrateLocalMarket(db: DatabaseSync) {
  db.exec(marketSchemaSql("", false));
  if (
    !(
      db.prepare("PRAGMA table_info(market_prices)").all() as { name: string }[]
    ).some((column) => column.name === "gap_before")
  )
    db.exec(
      "ALTER TABLE market_prices ADD COLUMN gap_before INTEGER NOT NULL DEFAULT 0",
    );
}
const sqlPg = (sql: string) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};
function quoteStatement(prefix: string, value: MarketQuote) {
  if (
    ![0, 1].includes(value.instrument) ||
    !Number.isSafeInteger(value.sourceAt) ||
    value.sourceAt < 0 ||
    !Number.isSafeInteger(value.receivedAt) ||
    value.receivedAt < 0 ||
    value.sourceAt - value.receivedAt > 30000 ||
    !Number.isFinite(value.priceUsd) ||
    value.priceUsd <= 0
  )
    throw new Error("Invalid market quote");
  const table = `${prefix}market_prices`,
    time = Math.floor(value.sourceAt / 5000) * 5000;
  return {
    sql: `INSERT INTO ${table}(instrument,time,price_usd,source_at,received_at,gap_before) SELECT ?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM ${table} WHERE instrument=? AND source_at>=?) ON CONFLICT(instrument,time) DO UPDATE SET price_usd=excluded.price_usd,source_at=excluded.source_at,received_at=excluded.received_at,gap_before=CASE WHEN ${table}.gap_before=1 OR excluded.gap_before=1 THEN 1 ELSE 0 END WHERE ${table}.source_at<excluded.source_at RETURNING gap_before`,
    params: [
      value.instrument,
      time,
      value.priceUsd,
      value.sourceAt,
      value.receivedAt,
      value.gapBefore ? 1 : 0,
      value.instrument,
      value.sourceAt,
    ],
    event: (gapBefore: boolean) =>
      JSON.stringify({
        type: "asset-price",
        data: {
          instrument: value.instrument,
          point: {
            time: value.sourceAt,
            priceUsd: value.priceUsd,
            ...(gapBefore ? { gapBefore: true } : {}),
          },
          receivedAt: value.receivedAt,
        },
      }),
  };
}
type PriceRow = {
  instrument: number;
  time: number | string;
  price_usd: number;
  source_at: number | string;
  received_at: number | string;
  gap_before: number;
};
interface Reader {
  prefix: string;
  postgres: boolean;
  rows<T>(sql: string, args: (number | string)[]): Promise<T[]>;
}
function reader(db: Reader): MarketStore["read"] {
  return async (instrument, now = Date.now()) => {
    if (
      !Number.isSafeInteger(instrument) ||
      instrument < 0 ||
      !Number.isSafeInteger(now) ||
      now < 0
    )
      throw new Error("Invalid market query");
    const from = Math.max(0, now - 3600000),
      table = `${db.prefix}market_prices`;
    const [latest, first, points, trades] = await Promise.all([
      db.rows<PriceRow>(
        `SELECT * FROM ${table} WHERE instrument=? ORDER BY source_at DESC LIMIT 1`,
        [instrument],
      ),
      db.rows<PriceRow>(
        `SELECT * FROM ${table} WHERE instrument=? ORDER BY time LIMIT 1`,
        [instrument],
      ),
      db.rows<PriceRow>(
        `SELECT * FROM ${table} WHERE instrument=? AND source_at>=? AND source_at<=? ORDER BY source_at DESC LIMIT 720`,
        [instrument, from, now],
      ),
      db.rows<{ payload: unknown }>(
        `SELECT payload FROM ${db.prefix}trade_observations WHERE ${db.postgres ? "(payload->>'instrument')" : "json_extract(payload,'$.instrument')"}=? AND source_at>=? AND source_at<=? ORDER BY source_at DESC,id DESC LIMIT 400`,
        [db.postgres ? String(instrument) : instrument, from, now],
      ),
    ]);
    const row = latest[0];
    return {
      price: row
        ? {
            instrument,
            priceUsd: row.price_usd,
            sourceAt: Number(row.source_at),
            receivedAt: Number(row.received_at),
          }
        : null,
      points: points
        .reverse()
        .map((p) => ({
          time: Number(p.source_at),
          priceUsd: p.price_usd,
          ...(p.gap_before === 1 ? { gapBefore: true } : {}),
        })),
      rawTrades: trades.map(
        (r) =>
          (typeof r.payload === "string"
            ? JSON.parse(r.payload)
            : r.payload) as TradeEvent,
      ),
      observedFrom: first[0] ? Number(first[0].source_at) : null,
      tradesCapped: trades.length === 400,
    };
  };
}
export function createPgMarket(pool: Pool): MarketStore {
  return {
    read: reader({
      prefix: "paperdash_",
      postgres: true,
      async rows<T>(sql: string, args: (number | string)[]) {
        return (await pool.query(sqlPg(sql), args)).rows as T[];
      },
    }),
    async quote(value) {
      const q = quoteStatement("paperdash_", value),
        client = await pool.connect();
      try {
        await client.query("BEGIN");
        // One retained stream owns ingestion; the lock also serializes accidental
        // overlapping quote writers so cross-bucket regression checks stay valid.
        await client.query("SELECT pg_advisory_xact_lock(74481232,$1)", [
          value.instrument,
        ]);
        const saved = await client.query(sqlPg(q.sql), q.params);
        if (saved.rowCount) {
          await appendStreamEventPg(
            client,
            q.event(saved.rows[0].gap_before === 1),
          );
        }
        await client.query("COMMIT");
        return saved.rowCount === 1;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
export function createLocalMarket(
  db: DatabaseSync,
  writable: () => Promise<void>,
): MarketStore {
  return {
    read: reader({
      prefix: "",
      postgres: false,
      async rows<T>(sql: string, args: (number | string)[]) {
        return db.prepare(sql).all(...args) as T[];
      },
    }),
    async quote(value) {
      const q = quoteStatement("", value);
      await writable();
      db.exec("BEGIN IMMEDIATE");
      try {
        const saved = db.prepare(q.sql).get(...q.params) as
          | { gap_before: number }
          | undefined;
        if (saved) {
          const event = db
            .prepare("INSERT INTO stream_events(payload) VALUES(?)")
            .run(q.event(saved.gap_before === 1));
          db.prepare("DELETE FROM stream_events WHERE id<=?").run(
            Number(event.lastInsertRowid) - 1000,
          );
        }
        db.exec("COMMIT");
        return Boolean(saved);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
