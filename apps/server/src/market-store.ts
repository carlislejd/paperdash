import { rollbackPg } from "./pg-deadline.js";
import type { DatabaseSync } from "node:sqlite";
import type { Pool } from "pg";
import { appendStreamEventPg } from "./stream-event-store.js";
import type {
  AssetPricePoint,
  MarketTradeSample,
  MarketSegment,
  MarketSegmentCoverage,
  MarketMinPnlUsd,
  MarketWindow,
  TradeEvent,
} from "../../../packages/shared/src/types.js";
import { marketMinPnlUsd } from "../../../packages/shared/src/types.js";

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
  chartSamples: Record<MarketWindow, MarketTradeSample>;
  profitable: ProfitableMarketData;
  profitableByMinPnl: Record<MarketMinPnlUsd, ProfitableMarketData>;
}
export interface ProfitableMarketData {
  rawTrades: TradeEvent[];
  chartSamples: Record<MarketWindow, MarketTradeSample>;
  coverage: MarketSegmentCoverage;
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
export const marketWindows = {
  "5m": { durationMs: 300000, bucketMs: 10000 },
  "15m": { durationMs: 900000, bucketMs: 30000 },
  "1h": { durationMs: 3600000, bucketMs: 120000 },
} as const;

export const PROFITABLE_ACCOUNT_MAX_AGE_MS = 300000;
export const PROFITABLE_SNAPSHOT_MAX_AGE_MS = 60000;

async function chartSamples(db: Reader, instrument: number, now: number) {
  const rawInstrument = db.postgres
    ? "(payload->>'instrument')"
    : "json_extract(payload,'$.instrument')";
  const price = db.postgres
    ? "CASE WHEN jsonb_typeof(r.payload->'priceUsd')='number' THEN (r.payload->>'priceUsd')::numeric END"
    : "CASE WHEN json_type(r.payload,'$.priceUsd') IN ('integer','real') THEN json_extract(r.payload,'$.priceUsd') END";
  // Drive both identity lookups from the bounded raw window. These join fences
  // prevent a low price-filter estimate from hashing the entire retained member
  // ledger. PostgreSQL uses indexed lateral lookups; SQLite preserves CROSS JOIN
  // order and uses the same existing primary keys.
  const identityJoins = db.postgres
    ? `FROM recent r
       JOIN LATERAL (SELECT fingerprint,provenance FROM ${db.prefix}analytics_members WHERE id=r.id OFFSET 0) m ON true
       JOIN LATERAL (SELECT fingerprint,source_at,notional,instrument FROM ${db.prefix}analytics_fingerprints WHERE fingerprint=m.fingerprint OFFSET 0) f ON true`
    : `FROM recent r CROSS JOIN ${db.prefix}analytics_members m CROSS JOIN ${db.prefix}analytics_fingerprints f`;
  // Indexed instrument/time restriction precedes source-overlap matching. Only
  // bounded selected payloads leave the query; API viewers read the saved result.
  // Price is excluded from economic identity. Count only genuinely priced
  // observations per source so unpriced REST rows cannot hide priced stream rows.
  const wallet = db.postgres
    ? "r.payload->>'wallet'"
    : "json_extract(r.payload,'$.wallet')";
  const kind = db.postgres
    ? "r.payload->>'kind'"
    : "json_extract(r.payload,'$.kind')";
  const accountPnl = db.postgres
    ? "s.payload->>'realizedPnl'"
    : "json_extract(s.payload,'$.realizedPnl')";
  const accountAddress = db.postgres
    ? "s.payload->>'address'"
    : "json_extract(s.payload,'$.address')";
  const pnlIsString = db.postgres
    ? "jsonb_typeof(s.payload->'realizedPnl')='string'"
    : "json_type(s.payload,'$.realizedPnl')='text'";
  // Check canonical signed raw integers as text: casting enormous 18-decimal
  // values to a SQL number would overflow or lose the sign near zero.
  const validPnl = db.postgres
    ? "pnl ~ '^(0|[1-9][0-9]*|-[1-9][0-9]*)$'"
    : "(pnl='0' OR (substr(pnl,1,1) BETWEEN '1' AND '9' AND pnl NOT GLOB '*[^0-9]*') OR (substr(pnl,1,1)='-' AND substr(pnl,2,1) BETWEEN '1' AND '9' AND substr(pnl,2) NOT GLOB '*[^0-9]*'))";
  // The distinct one-hour wallet cohort drives indexed primary-key lookups;
  // never scan every retained account or query an upstream source for viewers.
  const accountJoin = db.postgres
    ? `LEFT JOIN LATERAL (SELECT payload,received_at FROM ${db.prefix}snapshots WHERE key='account-summary:'||w.wallet OFFSET 0) s ON true`
    : `LEFT JOIN ${db.prefix}snapshots s ON s.key='account-summary:'||w.wallet`;
  // Canonical positive integers compare exactly by length then lexically. This
  // preserves all 18 decimals, including values immediately below a USD floor.
  const meetsFloor = `a.known=1 AND a.pnl<>'0' AND substr(a.pnl,1,1)<>'-'
    AND (length(a.pnl)>length(t.pnl_floor) OR (length(a.pnl)=length(t.pnl_floor) AND a.pnl>=t.pnl_floor))`;
  const thresholds = marketMinPnlUsd
    .map((floor) => `(${floor},'${BigInt(floor) * 10n ** 18n}')`)
    .join(",");
  const rows = await db.rows<{
    row_kind: "chart" | "feed" | "coverage";
    segment: MarketSegment;
    min_pnl_usd: MarketMinPnlUsd;
    window_name: MarketWindow | null;
    payload: unknown;
    observed_wallets: number | string | null;
    classified_wallets: number | string | null;
    profitable_wallets: number | string | null;
    oldest_received_at: number | string | null;
    newest_received_at: number | string | null;
  }>(
    `WITH recent AS MATERIALIZED (
      SELECT id,payload,source_at FROM ${db.prefix}trade_observations
      WHERE ${rawInstrument}=? AND source_at>=? AND source_at<=?
    ), wallets AS MATERIALIZED (
      SELECT DISTINCT ${wallet} AS wallet FROM recent r WHERE ${kind}='open'
    ), accounts AS MATERIALIZED (
      SELECT w.wallet,${accountPnl} AS pnl,${accountAddress} AS account_address,
        s.received_at,CASE WHEN ${pnlIsString} THEN 1 ELSE 0 END AS pnl_is_string
      FROM wallets w ${accountJoin}
    ), classified AS MATERIALIZED (
      SELECT wallet,pnl,received_at,
        CASE WHEN account_address=wallet AND pnl_is_string=1 AND length(pnl)<=79 AND ${validPnl}
          AND received_at>=? AND received_at<=? THEN 1 ELSE 0 END AS known
      FROM accounts
    ), eligible AS (
      SELECT f.fingerprint,f.source_at,f.notional,m.provenance,r.id,r.payload
      ${identityJoins}
      WHERE ${db.postgres ? "" : "m.id=r.id AND f.fingerprint=m.fingerprint AND "} f.instrument=? AND f.source_at>=? AND f.source_at<=?
        AND f.notional>=0 AND f.notional<=1.7976931348623157e308
        AND ${price}>0 AND ${price}<=1.7976931348623157e308
    ), priced AS (
      SELECT *,count(*) OVER(PARTITION BY fingerprint,provenance) AS priced_count,
      row_number() OVER(PARTITION BY fingerprint,provenance ORDER BY id DESC) AS source_rank FROM eligible
    ), source_choice AS (
      SELECT fingerprint,max(CASE WHEN provenance='recent-api' THEN priced_count ELSE 0 END) AS recent_count,
      max(CASE WHEN provenance='public-stream' THEN priced_count ELSE 0 END) AS stream_count FROM priced GROUP BY fingerprint
    ), candidates AS (
      SELECT p.* FROM priced p JOIN source_choice c ON c.fingerprint=p.fingerprint
      WHERE source_rank<=2 AND p.provenance=CASE WHEN c.recent_count>=c.stream_count THEN 'recent-api' ELSE 'public-stream' END
    ), thresholds(min_pnl_usd,pnl_floor) AS (VALUES ${thresholds}), segment_candidates AS (
      SELECT 'all' AS segment,0 AS min_pnl_usd,c.* FROM candidates c
      UNION ALL
      SELECT 'profitable' AS segment,t.min_pnl_usd,r.* FROM candidates r JOIN classified a ON a.wallet=${wallet}
      CROSS JOIN thresholds t WHERE ${kind}='open' AND ${meetsFloor}
    ), windows(window_name,window_from,bucket_ms) AS (VALUES ('5m',CAST(? AS BIGINT),10000),('15m',CAST(? AS BIGINT),30000),('1h',CAST(? AS BIGINT),120000)), ranked AS (
      SELECT c.segment,c.min_pnl_usd,w.window_name,c.payload,c.source_at,c.id,
      row_number() OVER(PARTITION BY c.segment,c.min_pnl_usd,w.window_name,c.source_at-(c.source_at%w.bucket_ms) ORDER BY c.notional DESC,c.source_at DESC,c.id DESC) AS bucket_rank
      FROM segment_candidates c JOIN windows w ON c.source_at>=w.window_from
    ), profitable_feed AS (
      SELECT t.min_pnl_usd,r.id,r.payload,r.source_at,
        row_number() OVER(PARTITION BY t.min_pnl_usd ORDER BY r.source_at DESC,r.id DESC) AS feed_rank
      FROM recent r JOIN classified a ON a.wallet=${wallet}
      CROSS JOIN thresholds t WHERE ${kind}='open' AND ${meetsFloor}
    ) SELECT 'chart' AS row_kind,segment,min_pnl_usd,window_name,payload,source_at,id,
        CAST(NULL AS BIGINT) AS observed_wallets,CAST(NULL AS BIGINT) AS classified_wallets,CAST(NULL AS BIGINT) AS profitable_wallets,CAST(NULL AS BIGINT) AS oldest_received_at,CAST(NULL AS BIGINT) AS newest_received_at
      FROM ranked WHERE bucket_rank<=2
    UNION ALL SELECT 'feed','profitable',min_pnl_usd,NULL,payload,source_at,id,NULL,NULL,NULL,NULL,NULL FROM profitable_feed WHERE feed_rank<=400
    UNION ALL SELECT 'coverage','profitable',t.min_pnl_usd,NULL,NULL,NULL,NULL,count(a.wallet),coalesce(sum(a.known),0),
      coalesce(sum(CASE WHEN ${meetsFloor} THEN 1 ELSE 0 END),0),
      min(CASE WHEN a.known=1 THEN a.received_at END),max(CASE WHEN a.known=1 THEN a.received_at END)
      FROM thresholds t LEFT JOIN classified a ON true GROUP BY t.min_pnl_usd
    ORDER BY row_kind,segment,min_pnl_usd,window_name,source_at DESC,id DESC`,
    [
      db.postgres ? String(instrument) : instrument,
      Math.max(0, now - 3600000),
      now,
      Math.max(0, now - PROFITABLE_ACCOUNT_MAX_AGE_MS),
      now,
      instrument,
      Math.max(0, now - 3600000),
      now,
      ...Object.values(marketWindows).map((window) =>
        Math.max(0, now - window.durationMs),
      ),
    ],
  );
  const sampleFor = (window: MarketWindow): MarketTradeSample => ({
    windowFrom: Math.max(0, now - marketWindows[window].durationMs),
    windowTo: now,
    bucketMs: marketWindows[window].bucketMs,
    perBucket: 2,
    trades: [],
    selection: "largest-notional-per-time-bucket",
    partial: true,
  });
  const samples = (): Record<MarketWindow, MarketTradeSample> => ({
    "5m": sampleFor("5m"),
    "15m": sampleFor("15m"),
    "1h": sampleFor("1h"),
  });
  const all = samples();
  const coverage: MarketSegmentCoverage = {
    basis: "positive-lifetime-realized-trading-pnl",
    classifiedAt: now,
    maxAccountAgeMs: PROFITABLE_ACCOUNT_MAX_AGE_MS,
    observedWallets: 0,
    classifiedWallets: 0,
    profitableWallets: 0,
    unknownWallets: 0,
    oldestAccountReceivedAt: null,
    newestAccountReceivedAt: null,
  };
  const profitableByMinPnl = Object.fromEntries(
    marketMinPnlUsd.map((minPnlUsd) => [minPnlUsd, {
      rawTrades: [],
      chartSamples: samples(),
      coverage: { ...coverage, minPnlUsd },
      tradesCapped: false,
    }]),
  ) as unknown as Record<MarketMinPnlUsd, ProfitableMarketData>;
  for (const row of rows) {
    const cohort = profitableByMinPnl[row.min_pnl_usd];
    if (row.row_kind === "coverage") {
      cohort.coverage = {
        ...cohort.coverage,
        observedWallets: Number(row.observed_wallets),
        classifiedWallets: Number(row.classified_wallets),
        profitableWallets: Number(row.profitable_wallets),
        unknownWallets:
          Number(row.observed_wallets) - Number(row.classified_wallets),
        oldestAccountReceivedAt:
          row.oldest_received_at === null ? null : Number(row.oldest_received_at),
        newestAccountReceivedAt:
          row.newest_received_at === null ? null : Number(row.newest_received_at),
      };
      continue;
    }
    const trade = (
      typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload
    ) as TradeEvent;
    if (row.row_kind === "feed") {
      cohort.rawTrades.push(trade);
      continue;
    }
    const sample = row.window_name
      ? (row.segment === "all" ? all : cohort.chartSamples)[row.window_name]
      : undefined;
    if (
      sample &&
      trade.instrument === instrument &&
      Number.isSafeInteger(trade.ts) &&
      trade.ts >= sample.windowFrom &&
      trade.ts <= now &&
      Number.isFinite(trade.notionalUsd) &&
      trade.notionalUsd >= 0 &&
      typeof trade.priceUsd === "number" &&
      Number.isFinite(trade.priceUsd) &&
      trade.priceUsd > 0
    )
      sample.trades.push(trade);
  }
  for (const cohort of Object.values(profitableByMinPnl))
    cohort.tradesCapped = cohort.rawTrades.length === 400;
  return {
    chartSamples: all,
    profitable: profitableByMinPnl[0],
    profitableByMinPnl,
  };
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
    const [latest, first, points, trades, samples] = await Promise.all([
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
      chartSamples(db, instrument, now),
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
      points: points.reverse().map((p) => ({
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
      ...samples,
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
        await rollbackPg(client);
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
          { gap_before: number } | undefined;
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
