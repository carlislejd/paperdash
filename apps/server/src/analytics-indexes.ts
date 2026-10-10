import type { Pool } from "pg";
import { DeadlinePgClient } from "./pg-deadline.js";

const name = "paperdash_analytics_wallet_fingerprint_wallet_time";
const table = "paperdash_analytics_wallet_fingerprints";

export const walletAssetIndexStatusSql = `SELECT i.indisvalid AND i.indisready AS valid,
  i.indrelid=to_regclass('${table}') AND i.indnatts=3 AND i.indnkeyatts=3
  AND NOT i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL
  AND am.amname='btree' AND i.indoption::text='0 0 0'
  AND pg_get_indexdef(i.indexrelid,1,true)='wallet'
  AND pg_get_indexdef(i.indexrelid,2,true)='source_at'
  AND pg_get_indexdef(i.indexrelid,3,true)='fingerprint' AS expected
  FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam WHERE i.indexrelid=to_regclass('${name}')`;

/** Owner-only, deliberately outside the schema transaction. Runtime readers
 * only inspect the catalog; they never attempt this DDL. Query deadlines still
 * apply, and an interrupted concurrent build is repaired on the next run. */
export async function migratePgAnalyticsIndexes(pool: Pool): Promise<void> {
  // Only this owner migration session gets a longer bounded build budget.
  // No pooled API/collector connection has its configuration changed.
  const client = new DeadlinePgClient(
    {
      ...pool.options,
      connectionTimeoutMillis: 10000,
      statement_timeout: 120000,
      query_timeout: 130000,
    },
    130000,
  );
  client.on("error", () => {}); // active queries still reject; no unhandled idle error
  try {
    await client.connect();
    await client.query("SELECT pg_advisory_lock(74481231, 1)");
    const current = (await client.query(walletAssetIndexStatusSql)).rows[0];
    if (current && !current.expected)
      throw new Error(
        "Wallet asset index has an unexpected definition; migration stopped.",
      );
    if (current?.valid) return;
    if (current) await client.query(`DROP INDEX CONCURRENTLY ${name}`);
    await client.query(
      `CREATE INDEX CONCURRENTLY ${name} ON ${table}(wallet,source_at,fingerprint)`,
    );
    const result = (await client.query(walletAssetIndexStatusSql)).rows[0];
    if (!result?.valid || !result.expected)
      throw new Error(
        "Wallet asset index did not become valid; retry the owner migration.",
      );
  } finally {
    // Closing the dedicated session also releases the migration lock, even
    // when a cancelled CREATE leaves an invalid index for the next retry.
    await client.end();
  }
}
