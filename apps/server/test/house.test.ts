import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalHouse, houseSchemaSql } from "../src/house-store.js";
import {
  normalizeHouse,
  readHouse,
  refreshHouse,
  retainHouseSource,
  signedSourceUsdRaw,
  thinHouseHistory,
} from "../src/house.js";

const at = 1800000000000;
const databases: DatabaseSync[] = [],
  dirs: string[] = [];
function memory(path = ":memory:") {
  const db = new DatabaseSync(path);
  databases.push(db);
  db.exec(houseSchemaSql("", false));
  const house = createLocalHouse(db, async () => {});
  const saved = new Map<string, { value: unknown; receivedAt: number }>();
  const store = {
    house,
    async get<T>(key: string) {
      return (
        (saved.get(key) as { value: T; receivedAt: number } | undefined) ?? null
      );
    },
    async put(key: string, value: unknown, receivedAt = Date.now()) {
      saved.set(key, { value, receivedAt });
    },
  };
  return { db, store };
}
const source = (
  time = at,
  lp = 100,
  pnl = 20,
  queue = 5,
  generation = "gen1",
) => ({
  ok: true,
  historyGeneration: generation,
  historyRevision: `revision:${time}`,
  sourceAsOfMs: time,
  head: [time, lp, pnl, queue, 10000000, 5000000, 1234, 4321],
});
const summary = (time = at) => ({
  ok: true,
  source: { at: time, block: "100" },
  balances: {
    tvl: "120000000000000000000000000",
    margin: "0",
    lp: "999999999999999999999",
    reserve: "0",
    queue: "0",
  },
  activity: { volume: "0", open: 0 },
  fees: { lifetime: "123456789012345678901234", pending: "20" },
  paper: {
    supply: "999999999999999999999999",
    staked: "77777777777777777777777",
    pendingRewards: "1000000000000000000",
    reserve: "888",
    accumulator: "111",
  },
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      /* Already closed for restart verification. */
    }
  }
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("coherent house normalization", () => {
  it("uses inverse trader PnL and queue debt, including negative funds", () => {
    expect(normalizeHouse(source(), at).house).toEqual({
      lpRaw: "100000000000000000000",
      openPnlRaw: "-20000000000000000000",
      queueDebtRaw: "5000000000000000000",
      fundsRaw: "75000000000000000000",
    });
    expect(normalizeHouse(source(at, 5, 30, 4), at).house.fundsRaw).toBe(
      "-29000000000000000000",
    );
    expect(normalizeHouse(source(at, -5, -20, 4), at).house.fundsRaw).toBe(
      "11000000000000000000",
    );
  });
  it("preserves supplied decimal representations and scientific notation without floating arithmetic", () => {
    const sample = normalizeHouse(
      source(at, 4874685.202861032, 1109648.8560198427, 0),
      at,
    );
    expect(sample.house.fundsRaw).toBe("3765036346841189300000000");
    expect(signedSourceUsdRaw(10000000000.125)).toBe(
      "10000000000125000000000000000",
    );
    expect(signedSourceUsdRaw(-1.25e-7)).toBe("-125000000000");
    expect(signedSourceUsdRaw(1e21)).toBe(
      "1000000000000000000000000000000000000000",
    );
    expect(signedSourceUsdRaw(-0)).toBe("0");
    expect(signedSourceUsdRaw(-1e-20)).toBe("0");
    expect(() => signedSourceUsdRaw(Infinity)).toThrow();
    expect(() => signedSourceUsdRaw(1e100)).toThrow();
  });
  it("never uses entry notionals or leverage to multiply House Funds", () => {
    const normal = source();
    const extreme = {
      ...normal,
      leverage: 1000,
      head: [...normal.head.slice(0, 4), 1e15, 2e15, 3e15, 4e15],
    };
    expect(normalizeHouse(extreme, at).house).toEqual(
      normalizeHouse(normal, at).house,
    );
  });
  it("rejects malformed, negative-queue and future-source publications", () => {
    for (const value of [
      source(at + 30001),
      source(at, 1, 1, -1),
      { ...source(), sourceAsOfMs: at + 1 },
      source(at, NaN),
      { ...source(), head: [at, 1, 2] },
    ])
      expect(() => normalizeHouse(value, at)).toThrow();
    for (const receivedAt of [-1, NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(() => normalizeHouse(source(), receivedAt)).toThrow();
  });
});

describe("durable minute house history", () => {
  it("updates one minute, rejects cross-minute regressions and permits later same-source corrections", async () => {
    const { store, db } = memory();
    await retainHouseSource(store, source(at + 1), at + 1);
    await retainHouseSource(store, source(at + 999, 200), at + 999);
    await expect(
      retainHouseSource(store, source(at + 998, 9999), at + 1000),
    ).rejects.toThrow("backward");
    await expect(
      retainHouseSource(store, source(at - 60000, 9999), at + 1001),
    ).rejects.toThrow("backward");
    await retainHouseSource(store, source(at + 999, 201), at + 1002);
    await expect(
      retainHouseSource(store, source(at + 999, 9999), at + 1000),
    ).rejects.toThrow("backward");
    const result = await store.house.read(at + 2000);
    expect(result.latest?.house.fundsRaw).toBe("176000000000000000000");
    expect(result.latest?.sourceAt).toBe(at + 999);
    expect(result.latest?.receivedAt).toBe(at + 1002);
    expect(result.history).toEqual([
      { time: at + 999, fundsRaw: "176000000000000000000" },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM house_samples").get()).toEqual(
      { n: 1 },
    );
  });
  it("survives database reopening without resetting samples", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paperdash-house-"));
    dirs.push(dir);
    const file = join(dir, "house.sqlite");
    const first = memory(file);
    await retainHouseSource(first.store, source(), at);
    first.db.close();
    databases.splice(databases.indexOf(first.db), 1);
    const second = memory(file);
    expect((await second.store.house.read(at)).latest?.house.fundsRaw).toBe(
      "75000000000000000000",
    );
  });
  it("bounds the last24h query, retains older data and marks discontinuities", async () => {
    const { store, db } = memory();
    for (let i = 0; i < 1500; i++)
      await retainHouseSource(
        store,
        source(at + i * 60000, i, 0, 0),
        at + i * 60000,
      );
    const current = at + 1499 * 60000;
    const result = await store.house.read(current);
    expect(result.history).toHaveLength(1441);
    expect(result.observedFrom).toBe(at);
    expect(result.history[0].time).toBe(current - 86400000);
    expect(db.prepare("SELECT COUNT(*) AS n FROM house_samples").get()).toEqual(
      { n: 1500 },
    );
    await retainHouseSource(
      store,
      source(current + 180000, 100, 0, 0),
      current + 180000,
    );
    await retainHouseSource(
      store,
      source(current + 240000, 101, 0, 0, "new-generation"),
      current + 240000,
    );
    const last = (await store.house.read(current + 240000)).history;
    expect(last.at(-2)?.gapBefore).toBe(true);
    expect(last.at(-1)?.gapBefore).toBe(true);
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM house_samples WHERE source_at>=? AND source_at<=? ORDER BY source_at DESC LIMIT 1441",
      )
      .all(current - 86400000, current);
    expect(JSON.stringify(plan)).toContain("house_source_time");
  });
  it("preserves a gap that lies between chosen chart points", () => {
    const points = Array.from({ length: 1441 }, (_, i) => ({
      time: at + i * 60000,
      fundsRaw: String(i),
      ...(i === 2 ? { gapBefore: true } : {}),
    }));
    const thinned = thinHouseHistory(points);
    expect(thinned).toHaveLength(300);
    expect(thinned[0]).toEqual(points[0]);
    expect(thinned.at(-1)).toEqual(points.at(-1));
    expect(thinned[1].gapBefore).toBe(true);
    expect(thinned.slice(2).some((point) => point.gapBefore)).toBe(false);
  });
  it("validates the store boundary and leaves valid data intact after failed writes", async () => {
    const { store, db } = memory();
    const value = normalizeHouse(source(), at);
    await store.house.sample(value);
    for (const invalid of [
      { ...value, receivedAt: -1 },
      { ...value, sourceAt: at + 30001 },
      { ...value, generation: "" },
      { ...value, house: { ...value.house, queueDebtRaw: "-1" } },
      { ...value, house: { ...value.house, fundsRaw: "999" } },
      { ...value, house: { ...value.house, lpRaw: "1.5" } },
    ])
      await expect(store.house.sample(invalid)).rejects.toThrow();
    db.exec(
      "CREATE TRIGGER reject_house BEFORE UPDATE ON house_samples BEGIN SELECT RAISE(ABORT,'write failed'); END",
    );
    await expect(
      store.house.sample(normalizeHouse(source(at + 1, 999), at + 1)),
    ).rejects.toThrow("write failed");
    expect((await store.house.read(at)).latest?.house).toEqual(value.house);
  });
});

describe("saved house response and independent freshness", () => {
  it("keeps summary fields exact and derives funds only from the coherent head", async () => {
    const { store } = memory();
    await retainHouseSource(store, source(), at);
    await store.put("summary", summary(at - 1000), at - 500);
    await store.put("collector-heartbeat", { at, errors: {} }, at);
    await refreshHouse(store, at);
    const read = vi.spyOn(store.house, "read");
    const result = await readHouse(store, at);
    expect(read).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      stale: false,
      sourceAt: at,
      receivedAt: at,
      sourceBlock: "100",
      summarySourceAt: at - 1000,
      house: { fundsRaw: "75000000000000000000" },
      paper: {
        supplyRaw: "999999999999999999999999",
        stakedRaw: "77777777777777777777777",
        stakerRewardsRaw: "123456789012345678901234",
        pendingRewardsRaw: "1000000000000000000",
      },
      coverage: { approximate: true, partial: true },
    });
    expect(result).not.toHaveProperty("summaryReceivedAt");
  });
  it("preserves missing data as null and does not call it zero", async () => {
    const { store } = memory();
    expect(await readHouse(store, at)).toMatchObject({
      stale: true,
      house: null,
      paper: { supplyRaw: null },
      history: [],
    });
    await retainHouseSource(store, source(), at);
    await refreshHouse(store, at);
    expect(await readHouse(store, at)).toMatchObject({
      stale: true,
      house: { fundsRaw: "75000000000000000000" },
      paper: { stakerRewardsRaw: null },
      sourceBlock: null,
    });
  });
  it("does not freshen old source data by repeatedly receiving or caching it", async () => {
    const { store } = memory();
    await retainHouseSource(store, source(at - 31000), at);
    await store.put("summary", summary(), at);
    await store.put("collector-heartbeat", { at, errors: {} }, at);
    await refreshHouse(store, at);
    expect(await readHouse(store, at)).toMatchObject({
      stale: true,
      sourceAt: at - 31000,
      error: "House observations are delayed.",
    });
    await retainHouseSource(store, source(), at);
    await store.put("summary", summary(at - 31000), at);
    await refreshHouse(store, at);
    expect(await readHouse(store, at)).toMatchObject({
      stale: true,
      error: "PAPER protocol summary is delayed.",
    });
    await store.put("summary", summary(at + 31000), at);
    await refreshHouse(store, at);
    expect((await readHouse(store, at)).stale).toBe(true);
  });
  it.each(["asset-market", "summary", "house"])(
    "marks fresh timestamps stale when %s loop fails",
    async (loop) => {
      const { store } = memory();
      await retainHouseSource(store, source(), at);
      await store.put("summary", summary(), at);
      await store.put(
        "collector-heartbeat",
        { at, errors: { [loop]: "unavailable" } },
        at,
      );
      await refreshHouse(store, at);
      expect((await readHouse(store, at)).stale).toBe(true);
      await store.put(
        "collector-heartbeat",
        { at, errors: { "wallet-indexer": "unrelated history task" } },
        at,
      );
      expect((await readHouse(store, at)).stale).toBe(false);
      expect((await readHouse(store, at + 15001)).stale).toBe(true);
    },
  );
});
