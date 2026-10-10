import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore, type Store } from "../src/store.js";
import { refreshMarkets, readMarket } from "../src/market.js";
import { buildApi } from "../src/api.js";
import { normalizeTrade } from "../src/schemas.js";

const stores: Store[] = [],
  dirs: string[] = [];
const at = 1800000000000;
async function memory() {
  const store = await createStore({ memory: true, databaseUrl: "" });
  stores.push(store);
  return store;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
const quote = (time = at, instrument = 0, priceUsd = 100) => ({
  instrument,
  priceUsd,
  sourceAt: time,
  receivedAt: time,
});
const trade = (seq: string, fields: Record<string, unknown> = {}) =>
  normalizeTrade(
    {
      seq,
      ts: at - 1000,
      wallet: `0x${"1".repeat(40)}`,
      instrument: 0,
      side: "long",
      leverage: 2,
      notionalUsd: 100,
      kind: "open",
      pnlUsd: null,
      entry: 100,
      ...fields,
    },
    "recent-api",
  );
describe("retained live market data", () => {
  it("preserves a reconnect gap through later updates in the same bucket and its durable notifications", async () => {
    const store = await memory();
    await store.market.quote({ ...quote(at + 1), gapBefore: true });
    await store.market.quote(quote(at + 900));
    await store.market.quote(quote(at + 5000));
    expect((await store.market.read(0, at + 6000)).points).toEqual([
      { time: at + 900, priceUsd: 100, gapBefore: true },
      { time: at + 5000, priceUsd: 100 },
    ]);
    expect((await store.events())[1].message).toMatchObject({
      type: "asset-price",
      data: { point: { time: at + 900, gapBefore: true } },
    });
  });
  it("retains exact source times, replaces five-second buckets and rejects old/replayed quotes", async () => {
    const store = await memory();
    expect(await store.market.quote(quote(at + 1))).toBe(true);
    expect(await store.market.quote(quote(at + 900, 0, 102))).toBe(true);
    expect(await store.market.quote(quote(at + 500, 0, 999))).toBe(false);
    expect(await store.market.quote(quote(at - 5000, 0, 999))).toBe(false);
    expect(await store.market.quote(quote(at + 900, 0, 999))).toBe(false);
    const data = await store.market.read(0, at + 1000);
    expect(data.points).toEqual([{ time: at + 900, priceUsd: 102 }]);
    expect(data.price).toMatchObject({ sourceAt: at + 900, priceUsd: 102 });
    expect((await store.events()).map((e) => e.message)).toEqual([
      {
        type: "asset-price",
        data: {
          instrument: 0,
          point: { time: at + 1, priceUsd: 100 },
          receivedAt: at + 1,
        },
      },
      {
        type: "asset-price",
        data: {
          instrument: 0,
          point: { time: at + 900, priceUsd: 102 },
          receivedAt: at + 900,
        },
      },
    ]);
  });
  it("preserves observations across restart and rolls back a price when its durable notification fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paperdash-market-"));
    dirs.push(dir);
    const store = await createStore({ dataDir: dir, databaseUrl: "" });
    stores.push(store);
    const db = new DatabaseSync(join(dir, "paperdash.sqlite"));
    try {
      db.exec(
        "CREATE TRIGGER reject_market BEFORE INSERT ON stream_events BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
      );
      await expect(store.market.quote(quote())).rejects.toThrow(
        "fixture failure",
      );
      expect((await store.market.read(0, at)).points).toEqual([]);
      db.exec("DROP TRIGGER reject_market");
      await store.market.quote(quote());
    } finally {
      db.close();
    }
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = await createStore({ dataDir: dir, databaseUrl: "" });
    stores.push(restarted);
    expect((await restarted.market.read(0, at)).points).toEqual([
      { time: at, priceUsd: 100 },
    ]);
  });
  it("bounds price and trade reads, isolates instruments, deduplicates overlap, and reports truncation", async () => {
    const store = await memory();
    for (let i = 0; i < 725; i++)
      await store.market.quote(quote(at - 3620000 + i * 5000));
    await store.recordTrade(trade("9999", { instrument: 1 }));
    await store.recordTrade(trade("9998", { ts: at - 3600001 }));
    for (let i = 0; i < 205; i++)
      await store.recordTrade(trade(String(i), { notionalUsd: i + 1 }));
    const duplicate = {
      ...trade("0", { notionalUsd: 1 }),
      id: "stream:copy",
      provenance: "public-stream" as const,
    };
    await store.recordTrade(duplicate);
    await store.put("market-connection", { connected: true }, at);
    await refreshMarkets(store, at);
    const data = await readMarket(store, 0, at);
    expect(data.points.length).toBeLessThanOrEqual(720);
    expect(data.trades).toHaveLength(200);
    expect(
      data.trades.every((t) => t.instrument === 0 && t.ts >= at - 3600000),
    ).toBe(true);
    expect(data.coverage.tradesCapped).toBe(true);
    expect(
      data.trades.filter((t) => t.notionalUsd === 1).length,
    ).toBeLessThanOrEqual(1);
  });
  it("serves only saved snapshots and marks stale/disconnected data without rewriting source timestamps", async () => {
    const store = await memory();
    await store.market.quote(quote());
    await store.put("collector-heartbeat", { at, errors: {} }, at);
    await store.put("overview", { status: { stream: "connected" } }, at);
    await store.put("market-connection", { connected: true }, at);
    await refreshMarkets(store, at);
    expect((await readMarket(store, 0, at)).stale).toBe(false);
    const spy = vi.spyOn(store.market, "read");
    const app = await buildApi(store, undefined, undefined, { logger: false });
    try {
      const response = await app.inject("/api/assets/0/market");
      expect(response.statusCode).toBe(200);
      expect(response.json().price.sourceAt).toBe(at);
      expect(spy).not.toHaveBeenCalled();
      expect((await app.inject("/api/assets/3/market")).statusCode).toBe(400);
      expect(
        (await app.inject("/api/assets/0/market?ignored=1")).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
    await store.put("market-connection", { connected: false }, at + 1);
    expect((await readMarket(store, 0, at + 1)).stale).toBe(true);
    await store.put("market-connection", { connected: true }, at + 2);
    await store.put("overview", { status: { stream: "disconnected" } }, at + 2);
    expect((await readMarket(store, 0, at + 2)).stale).toBe(true);
    await store.put("overview", { status: { stream: "connected" } }, at + 3);
    await store.put(
      "collector-heartbeat",
      { at: at + 3, errors: { recent: "delayed" } },
      at + 3,
    );
    expect((await readMarket(store, 0, at + 3)).stale).toBe(true);
    expect((await readMarket(store, 0, at + 31000)).stale).toBe(true);
    expect((await readMarket(store, 0, at + 31000)).price?.sourceAt).toBe(at);
  });
  it("rejects invalid quote boundaries without writing a sample or notification", async () => {
    const store = await memory();
    for (const bad of [
      { receivedAt: -1 },
      { receivedAt: NaN },
      { receivedAt: Number.MAX_SAFE_INTEGER + 1 },
      { sourceAt: -1 },
      { sourceAt: at + 30001 },
      { instrument: 2 },
      { priceUsd: 0 },
      { priceUsd: Infinity },
    ])
      await expect(store.market.quote({ ...quote(), ...bad })).rejects.toThrow(
        "Invalid market quote",
      );
    expect((await store.market.read(0, at)).points).toEqual([]);
    expect(await store.events()).toEqual([]);
  });
});
