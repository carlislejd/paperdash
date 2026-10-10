import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TradeEvent } from "../../../packages/shared/src/types.js";
import { createStore, visibleTrades, type Store } from "../src/store.js";

const stores: Store[] = [],
  dirs: string[] = [];
const now = 2 * 86400000 + 30000;
const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
function event(id: string, fields: Partial<TradeEvent> = {}): TradeEvent {
  return {
    id,
    ts: now - 1000,
    wallet: wallet(1),
    instrument: 0,
    side: "long",
    leverage: 10,
    notionalUsd: 100,
    kind: "open",
    pnlUsd: null,
    provenance: "public-stream",
    ...fields,
  };
}
async function memory() {
  const store = await createStore({ memory: true, databaseUrl: "" });
  stores.push(store);
  return store;
}
async function disk() {
  const dir = await mkdtemp(join(tmpdir(), "paperdash-analytics-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("retained observed asset activity", () => {
  it("is idempotent by observation ID and preserves max multiplicity across public sources", async () => {
    const store = await memory();
    const streamA = event("stream-a"),
      streamB = event("stream-b");
    expect(await store.recordTrade(streamA)).toBe(true);
    expect(await store.recordTrade(streamA)).toBe(false);
    await store.recordTrade(streamB);
    await store.recordTrade(event("recent-a", { provenance: "recent-api" }));
    let [activity] = await store.analytics.activity([0], now);
    expect(activity.counts).toEqual({ total: 2, long: 2, short: 0 });
    expect(activity.notionalUsd.total).toBe(200);
    expect(activity.recent).toHaveLength(2);
    expect(visibleTrades(await store.trades())).toHaveLength(2);
    await store.recordTrade(event("recent-b", { provenance: "recent-api" }));
    await store.recordTrade(event("recent-c", { provenance: "recent-api" }));
    [activity] = await store.analytics.activity([0], now);
    expect(activity.counts.total).toBe(3);
    expect(activity.notionalUsd.total).toBe(300);
    expect(activity.recent).toHaveLength(3);
    expect(activity.recent.every((r) => r.provenance === "recent-api")).toBe(
      true,
    );
    expect(await store.trades()).toHaveLength(5);
    expect(await store.events()).toHaveLength(5);
    expect(
      (await store.analytics.walletActivity("trades", 0, "", now)).rows[0],
    ).toEqual({ address: wallet(1), count: 3, notionalUsd: 300 });
  });
  it("uses exact rolling edges around minute buckets and includes opens, closes and liquidations", async () => {
    const store = await memory(),
      start = now - 86400000;
    for (const trade of [
      event("too-old", { ts: start - 1, notionalUsd: 1000 }),
      event("boundary", {
        ts: start,
        side: "short",
        notionalUsd: 10,
        kind: "close",
      }),
      event("edge", { ts: start + 20000, notionalUsd: 20 }),
      event("interior", { ts: start + 30000, notionalUsd: 30, kind: "liq" }),
      event("now", { ts: now, side: "short", notionalUsd: 40 }),
      event("future", { ts: now + 1, notionalUsd: 1000 }),
      event("another-asset", { instrument: 7, notionalUsd: 50 }),
    ])
      await store.recordTrade(trade);
    const [activity, other] = await store.analytics.activity([0, 7], now);
    expect(activity.counts).toEqual({ total: 4, long: 2, short: 2 });
    expect(activity.notionalUsd).toEqual({ total: 100, long: 50, short: 50 });
    expect(activity.recent.map((r) => r.id)).toEqual([
      "now",
      "interior",
      "edge",
      "boundary",
    ]);
    expect(other.notionalUsd.total).toBe(50);
    expect(
      (await store.analytics.activity([0], now + 1))[0].notionalUsd.total,
    ).toBe(1090);
  });
  it("rolls raw observation, projection and live notification back together", async () => {
    const dir = await disk(),
      store = await createStore({ dataDir: dir, databaseUrl: "" });
    stores.push(store);
    await store.recordTrade(event("good"));
    const fault = new DatabaseSync(join(dir, "paperdash.sqlite"));
    fault.exec("DROP TABLE stream_events");
    fault.close();
    await expect(
      store.recordTrade(event("rollback", { side: "short" })),
    ).rejects.toThrow();
    expect((await store.analytics.activity([0], now))[0].counts.total).toBe(1);
    expect(
      (await store.analytics.walletActivity("volume", 0, "", now)).rows[0]
        .count,
    ).toBe(1);
    expect((await store.trades()).map((r) => r.id)).toEqual(["good"]);
  });
  it("resumes bounded legacy backfill across restarts and persists its completion marker", async () => {
    const dir = await disk();
    let store = await createStore({ dataDir: dir, databaseUrl: "" });
    await store.close();
    const raw = new DatabaseSync(join(dir, "paperdash.sqlite"));
    for (const trade of [
      event("a"),
      event("b", { provenance: "recent-api" }),
      event("c", { side: "short" }),
    ])
      raw
        .prepare("INSERT INTO trade_observations VALUES(?,?,?,?)")
        .run(trade.id, JSON.stringify(trade), trade.ts, now);
    raw.close();
    store = await createStore({ dataDir: dir, databaseUrl: "" });
    expect(await store.analytics.backfill(1)).toEqual({
      processed: 1,
      complete: false,
    });
    expect(
      (await store.analytics.activity([0], now))[0].coverage
        .projectionBackfillComplete,
    ).toBe(false);
    await store.close();
    store = await createStore({ dataDir: dir, databaseUrl: "" });
    stores.push(store);
    expect(await store.analytics.backfill(1)).toEqual({
      processed: 1,
      complete: false,
    });
    expect(await store.analytics.backfill(1)).toEqual({
      processed: 1,
      complete: false,
    });
    expect(await store.analytics.backfill(1)).toEqual({
      processed: 0,
      complete: true,
    });
    expect((await store.analytics.activity([0], now))[0]).toMatchObject({
      counts: { total: 2 },
      coverage: { projectionBackfillComplete: true, identityAmbiguous: true },
    });
    await store.recordTrade(event("d", { instrument: 4 }));
    expect(await store.analytics.backfill(1)).toEqual({
      processed: 0,
      complete: true,
    });
    expect((await store.analytics.activity([4], now))[0].counts.total).toBe(1);
    expect(
      (await store.analytics.walletActivity("trades", 0, "", now)).rows[0]
        .count,
    ).toBe(3);
  });
  it("rebuilds wallet aggregates from previously projected asset rows without inflating asset totals", async () => {
    const dir = await disk();
    let store = await createStore({ dataDir: dir, databaseUrl: "" });
    await store.recordTrade(event("a"));
    await store.recordTrade(event("b"));
    await store.close();
    const raw = new DatabaseSync(join(dir, "paperdash.sqlite"));
    raw.exec(
      "DELETE FROM analytics_wallet_minutes; DELETE FROM analytics_wallet_fingerprints; INSERT INTO analytics_state VALUES(1,'z',1); UPDATE analytics_state SET cursor='',complete=0 WHERE id=2",
    );
    raw.close();
    store = await createStore({ dataDir: dir, databaseUrl: "" });
    stores.push(store);
    expect(await store.analytics.backfill()).toEqual({
      processed: 2,
      complete: true,
    });
    expect((await store.analytics.activity([0], now))[0].counts.total).toBe(2);
    expect(
      (await store.analytics.walletActivity("trades", 0, "", now)).rows[0]
        .count,
    ).toBe(2);
  });
  it("retains exact OI raw strings and refuses an older source timestamp within a minute", async () => {
    const store = await memory();
    const raw = "900719925474099312345678901234567890";
    const base = {
      instrument: 17,
      time: 65000,
      sourceAt: 65000,
      longRaw: raw,
      shortRaw: "7",
      sourceBlock: null,
      receivedAt: 100,
    };
    await store.analytics.sample(base);
    await store.analytics.sample({
      ...base,
      sourceAt: 64000,
      longRaw: "1",
      receivedAt: 200,
    });
    await store.analytics.sample({ ...base, longRaw: "2", receivedAt: 99 });
    expect((await store.analytics.samples(17, 0))[0]).toMatchObject({
      time: 60000,
      longRaw: raw,
      sourceAt: 65000,
      sourceBlock: null,
    });
    await store.analytics.sample({
      ...base,
      sourceAt: 66000,
      shortRaw: "8",
      receivedAt: 1,
    });
    expect((await store.analytics.samples(17, 0))[0]).toMatchObject({
      longRaw: raw,
      shortRaw: "8",
      sourceAt: 66000,
    });
  });
  it("ranks observed wallets by volume or count, with deterministic pagination and address prefix search", async () => {
    const store = await memory();
    await store.recordTrade(
      event("large", { wallet: wallet(1), notionalUsd: 100 }),
    );
    for (let i = 0; i < 3; i++)
      await store.recordTrade(
        event(`frequent-${i}`, {
          wallet: wallet(2),
          notionalUsd: 10,
          ts: now - i,
        }),
      );
    for (let i = 3; i < 30; i++)
      await store.recordTrade(
        event(`wallet-${i}`, { wallet: wallet(i), notionalUsd: 1 }),
      );
    const volume = await store.analytics.walletActivity("volume", 0, "", now);
    expect(volume.count).toBe(29);
    expect(volume.rows).toHaveLength(25);
    expect(volume.rows[0].address).toBe(wallet(1));
    expect(
      (await store.analytics.walletActivity("trades", 0, "", now)).rows[0]
        .address,
    ).toBe(wallet(2));
    expect(
      (await store.analytics.walletActivity("volume", 1, "", now)).rows,
    ).toHaveLength(4);
    expect(
      await store.analytics.walletActivity("volume", 5, "", now),
    ).toMatchObject({ count: 29, rows: [] });
    expect(
      (await store.analytics.walletActivity("volume", 0, wallet(2), now)).rows,
    ).toEqual([{ address: wallet(2), count: 3, notionalUsd: 30 }]);
    expect((await store.analytics.activity([0], now))[0].recent).toHaveLength(
      8,
    );
    await expect(
      store.analytics.walletActivity("volume", 0, "%", now),
    ).rejects.toThrow("Invalid observed-wallet");
  });
});
