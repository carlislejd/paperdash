import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  createLocalTradeInbox,
  createPgTradeInbox,
  encodedTrade,
  InboxCapacityError,
  tradeInboxSchemaSql,
} from "../src/trade-inbox-store.js";
import { normalizeTrade } from "../src/schemas.js";

const at = 1800000000000;
const trade = (n: number) =>
  normalizeTrade(
    {
      ts: at,
      wallet: `0x${"1".repeat(40)}`,
      instrument: "BTC",
      side: "long",
      leverage: 2,
      notionalUsd: n,
      kind: "open",
      pnlUsd: null,
    },
    "public-stream",
    `inbox-${n}`,
  );

it("bounds SQLite durable rows/bytes atomically, admits duplicates at capacity, and decrements accounting only once", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE trade_observations(id TEXT PRIMARY KEY)");
  db.exec(tradeInboxSchemaSql("", false));
  const inbox = createLocalTradeInbox(db, async () => {}, {
    records: 2,
    bytes: 1048576,
  });
  try {
    await inbox.append([trade(1), trade(2)], at);
    await inbox.append([trade(1), trade(1)], at);
    await expect(inbox.append([trade(3)], at)).rejects.toBeInstanceOf(
      InboxCapacityError,
    );
    expect((await inbox.head()).map((row) => row.id)).toEqual([
      trade(1).id,
      trade(2).id,
    ]);
    await inbox.acknowledge(trade(1).id);
    await inbox.acknowledge(trade(1).id);
    await inbox.append([trade(3)], at);
    expect((await inbox.status()).pending).toBe(2);
    expect(
      db
        .prepare("SELECT pending_rows,pending_bytes FROM trade_inbox_totals")
        .get(),
    ).toEqual({
      pending_rows: 2,
      pending_bytes:
        Buffer.byteLength(encodedTrade(trade(2))) +
        Buffer.byteLength(encodedTrade(trade(3))),
    });
    await inbox.acknowledge(trade(2).id);
    await inbox.acknowledge(trade(3).id);
    const byteBounded = createLocalTradeInbox(db, async () => {}, {
      records: 100,
      bytes: Buffer.byteLength(encodedTrade(trade(1))) + 1,
    });
    await expect(
      byteBounded.append([trade(1), trade(2)], at),
    ).rejects.toBeInstanceOf(InboxCapacityError);
    expect((await inbox.status()).pending).toBe(0);
    await byteBounded.append([trade(1)], at);
    expect((await inbox.status()).pending).toBe(1);
  } finally {
    db.close();
  }
});

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "PostgreSQL inbox capacity",
  () => {
    it("serializes competing admissions and keeps capacity counters atomic across rejected batches and repeated acknowledgements", async () => {
      const url = process.env.TEST_DATABASE_URL!;
      const admin = new Pool({ connectionString: url });
      const schema = `inbox_test_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`CREATE SCHEMA ${schema}`);
      const scopedUrl = new URL(url);
      scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
      const pool = new Pool({ connectionString: scopedUrl.toString(), max: 3 });
      try {
        await pool.query(
          "CREATE TABLE paperdash_trade_observations(id TEXT PRIMARY KEY)",
        );
        await pool.query(tradeInboxSchemaSql("paperdash_", true));
        const inbox = createPgTradeInbox(pool, { records: 3, bytes: 1048576 });
        const results = await Promise.allSettled([
          inbox.append([trade(1), trade(2)], at),
          inbox.append([trade(3), trade(4)], at),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([
          "fulfilled",
          "rejected",
        ]);
        expect(
          (
            results.find(
              (r) => r.status === "rejected",
            ) as PromiseRejectedResult
          ).reason,
        ).toBeInstanceOf(InboxCapacityError);
        const retained = await inbox.head();
        expect(retained).toHaveLength(2);
        await Promise.all([
          inbox.append(retained, at + 1),
          inbox.append(retained, at + 2),
        ]);
        expect((await inbox.status()).pending).toBe(2);
        await Promise.all([
          inbox.acknowledge(retained[0].id),
          inbox.acknowledge(retained[0].id),
        ]);
        expect((await inbox.status()).pending).toBe(1);
        const accounting = (
          await pool.query(
            "SELECT pending_rows,pending_bytes FROM paperdash_trade_inbox_totals",
          )
        ).rows[0];
        expect(Number(accounting.pending_rows)).toBe(1);
        expect(Number(accounting.pending_bytes)).toBe(
          Buffer.byteLength(encodedTrade(retained[1])),
        );
        await inbox.acknowledge(retained[1].id);
        const byteBounded = createPgTradeInbox(pool, {
          records: 100,
          bytes: Buffer.byteLength(encodedTrade(trade(1))) + 1,
        });
        await expect(
          byteBounded.append([trade(1), trade(2)], at),
        ).rejects.toBeInstanceOf(InboxCapacityError);
        expect((await inbox.status()).pending).toBe(0);
        await byteBounded.append([trade(1)], at);
        await expect(byteBounded.append([trade(2)], at)).rejects.toBeInstanceOf(
          InboxCapacityError,
        );
        expect((await inbox.status()).pending).toBe(1);
      } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    });
  },
);
