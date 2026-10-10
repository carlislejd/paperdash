import type { DatabaseSync } from "node:sqlite";
import type { Pool } from "pg";

export interface HouseAmounts {
  fundsRaw: string;
  lpRaw: string;
  openPnlRaw: string;
  queueDebtRaw: string;
}
export interface HouseSample {
  sourceAt: number;
  receivedAt: number;
  generation: string;
  revision: string;
  house: HouseAmounts;
}
export interface HousePoint {
  time: number;
  fundsRaw: string;
  gapBefore?: boolean;
}
export interface HouseStore {
  /** Newer receipt may correct an equal source timestamp; older source time cannot replace the head. */
  sample(value: HouseSample): Promise<boolean>;
  read(now?: number): Promise<{
    latest: HouseSample | null;
    history: HousePoint[];
    observedFrom: number | null;
  }>;
}
export function houseSchemaSql(prefix: string, postgres: boolean): string {
  const integer = postgres ? "bigint" : "INTEGER";
  return `CREATE TABLE IF NOT EXISTS ${prefix}house_samples(time ${integer} PRIMARY KEY,source_at ${integer} NOT NULL,received_at ${integer} NOT NULL,generation TEXT NOT NULL,revision TEXT NOT NULL,funds_raw TEXT NOT NULL,lp_raw TEXT NOT NULL,open_pnl_raw TEXT NOT NULL,queue_debt_raw TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ${prefix}house_source_time ON ${prefix}house_samples(source_at DESC);`;
}
const postgresSql = (sql: string) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};
const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0;
const validRaw = (value: string) =>
  typeof value === "string" &&
  value.length <= 79 &&
  /^(?:0|-?[1-9]\d*)$/.test(value);
function sampleStatement(prefix: string, value: HouseSample) {
  if (
    !validTime(value.sourceAt) ||
    !validTime(value.receivedAt) ||
    value.sourceAt > value.receivedAt + 30000 ||
    typeof value.generation !== "string" ||
    !value.generation.length ||
    value.generation.length > 500 ||
    typeof value.revision !== "string" ||
    !value.revision.length ||
    value.revision.length > 1000 ||
    !Object.values(value.house).every(validRaw) ||
    !["fundsRaw", "lpRaw", "openPnlRaw", "queueDebtRaw"].every((key) =>
      validRaw(value.house[key as keyof HouseAmounts]),
    ) ||
    BigInt(value.house.queueDebtRaw) < 0n ||
    BigInt(value.house.fundsRaw) !==
      BigInt(value.house.lpRaw) +
        BigInt(value.house.openPnlRaw) -
        BigInt(value.house.queueDebtRaw)
  )
    throw new Error("Invalid coherent house sample");
  const table = `${prefix}house_samples`;
  return {
    sql: `INSERT INTO ${table}(time,source_at,received_at,generation,revision,funds_raw,lp_raw,open_pnl_raw,queue_debt_raw) SELECT ?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM ${table} WHERE source_at>? OR (source_at=? AND received_at>?)) ON CONFLICT(time) DO UPDATE SET source_at=excluded.source_at,received_at=excluded.received_at,generation=excluded.generation,revision=excluded.revision,funds_raw=excluded.funds_raw,lp_raw=excluded.lp_raw,open_pnl_raw=excluded.open_pnl_raw,queue_debt_raw=excluded.queue_debt_raw WHERE ${table}.source_at<=excluded.source_at AND ${table}.received_at<=excluded.received_at RETURNING time`,
    params: [
      Math.floor(value.sourceAt / 60000) * 60000,
      value.sourceAt,
      value.receivedAt,
      value.generation,
      value.revision,
      value.house.fundsRaw,
      value.house.lpRaw,
      value.house.openPnlRaw,
      value.house.queueDebtRaw,
      value.sourceAt,
      value.sourceAt,
      value.receivedAt,
    ],
  };
}
interface Row {
  source_at: string | number;
  received_at: string | number;
  generation: string;
  revision: string;
  funds_raw: string;
  lp_raw: string;
  open_pnl_raw: string;
  queue_debt_raw: string;
}
function sampleFromRow(row: Row): HouseSample {
  return {
    sourceAt: Number(row.source_at),
    receivedAt: Number(row.received_at),
    generation: row.generation,
    revision: row.revision,
    house: {
      fundsRaw: row.funds_raw,
      lpRaw: row.lp_raw,
      openPnlRaw: row.open_pnl_raw,
      queueDebtRaw: row.queue_debt_raw,
    },
  };
}
function reader(
  prefix: string,
  rows: (sql: string, params: number[]) => Promise<Row[]>,
): HouseStore["read"] {
  return async (now = Date.now()) => {
    if (!validTime(now)) throw new Error("Invalid house history time");
    const table = `${prefix}house_samples`;
    const [latest, first, points] = await Promise.all([
      rows(`SELECT * FROM ${table} ORDER BY source_at DESC LIMIT 1`, []),
      rows(`SELECT * FROM ${table} ORDER BY time LIMIT 1`, []),
      rows(
        `SELECT * FROM ${table} WHERE source_at>=? AND source_at<=? ORDER BY source_at DESC LIMIT 1441`,
        [Math.max(0, now - 86400000), now],
      ),
    ]);
    const ordered = points.reverse();
    return {
      latest: latest[0] ? sampleFromRow(latest[0]) : null,
      history: ordered.map((point, i) => ({
        time: Number(point.source_at),
        fundsRaw: point.funds_raw,
        ...(i > 0 &&
        (Number(point.source_at) - Number(ordered[i - 1].source_at) > 120000 ||
          point.generation !== ordered[i - 1].generation)
          ? { gapBefore: true }
          : {}),
      })),
      observedFrom: first[0] ? Number(first[0].source_at) : null,
    };
  };
}
export function createPgHouse(pool: Pool): HouseStore {
  return {
    read: reader(
      "paperdash_",
      async (sql, params) =>
        (await pool.query(postgresSql(sql), params)).rows as Row[],
    ),
    async sample(value) {
      const statement = sampleStatement("paperdash_", value);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Also protect cross-bucket ordering if collector handoffs overlap unexpectedly.
        await client.query("SELECT pg_advisory_xact_lock(74481233,0)");
        const result = await client.query(
          postgresSql(statement.sql),
          statement.params,
        );
        await client.query("COMMIT");
        return result.rowCount === 1;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
export function createLocalHouse(
  db: DatabaseSync,
  writable: () => Promise<void>,
): HouseStore {
  return {
    read: reader(
      "",
      async (sql, params) => db.prepare(sql).all(...params) as unknown as Row[],
    ),
    async sample(value) {
      const statement = sampleStatement("", value);
      await writable();
      // One SQLite statement performs the global guard and upsert atomically.
      return Boolean(db.prepare(statement.sql).get(...statement.params));
    },
  };
}
