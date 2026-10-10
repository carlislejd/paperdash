import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TradeEvent } from "../../../packages/shared/src/types.js";
import type { Store } from "../src/store.js";
import {
  createLocalLiquidations,
  liquidationsSchemaSql,
  projectLiquidationSqlite,
} from "../src/liquidations-store.js";
import { refreshLiquidations, readLiquidations } from "../src/liquidations.js";

const at = 1800000000000 + 12345;
const dbs: DatabaseSync[] = [],
  dirs: string[] = [];
function setup(path = ":memory:") {
  const db = new DatabaseSync(path);
  dbs.push(db);
  db.exec(
    "CREATE TABLE IF NOT EXISTS trade_observations(id TEXT PRIMARY KEY,payload TEXT NOT NULL)",
  );
  db.exec(liquidationsSchemaSql("", false));
  const liquidations = createLocalLiquidations(db, async () => {});
  const saved = new Map<string, { value: unknown; receivedAt: number }>();
  const store = {
    liquidations,
    async get<T>(key: string) {
      return (
        (saved.get(key) as { value: T; receivedAt: number } | undefined) ?? null
      );
    },
    async put(key: string, value: unknown, receivedAt = Date.now()) {
      saved.set(key, { value, receivedAt });
    },
  } as Store;
  function insert(value: TradeEvent, project = true) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = db
        .prepare(
          "INSERT INTO trade_observations VALUES(?,?) ON CONFLICT(id) DO NOTHING",
        )
        .run(value.id, JSON.stringify(value));
      if (project && inserted.changes === 1)
        projectLiquidationSqlite(db, value);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return { db, store, insert, liquidations };
}
const event = (id: string, fields: Partial<TradeEvent> = {}): TradeEvent => ({
  id,
  ts: at - 1000,
  wallet: `0x${"a".repeat(40)}`,
  instrument: 0,
  side: "long",
  leverage: 1000,
  notionalUsd: 10000000000,
  kind: "liq",
  pnlUsd: -10000000,
  provenance: "public-stream",
  ...fields,
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* Restart case closes early. */
    }
  }
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("incremental observed liquidations", () => {
  it("counts max(source multiplicities), excludes opens/closes and keeps stable feed IDs", async () => {
    const { insert, liquidations } = setup();
    insert(event("stream:1"));
    const first = (await liquidations.page(undefined, undefined, at)).items[0];
    insert(event("recent:1", { provenance: "recent-api", priceUsd: 81234.5 }));
    insert(event("recent:1", { provenance: "recent-api", priceUsd: 81234.5 }));
    expect((await liquidations.stats(undefined, at)).day.count).toBe(1);
    const enriched = (await liquidations.page(undefined, undefined, at))
      .items[0];
    expect(enriched.id).toBe(first.id);
    expect(enriched.priceUsd).toBe(81234.5);
    insert(event("stream:2"));
    insert(event("recent:2", { provenance: "recent-api" }));
    insert(event("recent:3", { provenance: "recent-api" }));
    insert(event("open:1", { kind: "open" }));
    insert(event("close:1", { kind: "close" }));
    const stats = await liquidations.stats(undefined, at);
    expect(stats.day).toEqual({
      count: 3,
      longCount: 3,
      shortCount: 0,
      notionalUsd: 30000000000,
    });
    const items = (await liquidations.page(undefined, undefined, at)).items;
    expect(items).toHaveLength(3);
    expect(new Set(items.map((e) => e.id)).size).toBe(3);
    expect(
      items.every((e) => e.kind === "liq" && e.id.startsWith("liq:")),
    ).toBe(true);
  });
  it("computes inclusive exact rolling boundaries without double counting boundary minutes", async () => {
    const { insert, liquidations } = setup();
    const times = [
      at - 86400001,
      at - 86400000,
      at - 3600001,
      at - 3600000,
      at - 60000,
      at,
      at + 1,
    ];
    times.forEach((ts, i) =>
      insert(
        event(String(i), {
          ts,
          side: i % 2 ? "short" : "long",
          notionalUsd: 100,
        }),
      ),
    );
    const stats = await liquidations.stats(undefined, at);
    expect(stats.day).toEqual({
      count: 5,
      longCount: 2,
      shortCount: 3,
      notionalUsd: 500,
    });
    expect(stats.hour).toEqual({
      count: 3,
      longCount: 1,
      shortCount: 2,
      notionalUsd: 300,
    });
    expect(stats.coverage.observedFrom).toBe(at - 86400001);
    expect(stats.coverage.latestObservedAt).toBe(at);
    expect(
      (await liquidations.page(undefined, undefined, at)).items.some(
        (e) => e.ts > at,
      ),
    ).toBe(false);
  });
  it("isolates assets and handles a fresh genuinely empty observed dataset", async () => {
    const { insert, liquidations } = setup();
    expect((await liquidations.stats(undefined, at)).day.count).toBe(0);
    expect(
      (await liquidations.stats(undefined, at)).coverage.observedFrom,
    ).toBeNull();
    insert(event("btc"));
    insert(event("eth", { instrument: 1, side: "short", notionalUsd: 7 }));
    expect((await liquidations.stats(0, at)).day).toMatchObject({
      count: 1,
      longCount: 1,
      notionalUsd: 10000000000,
    });
    expect((await liquidations.stats(1, at)).day).toEqual({
      count: 1,
      longCount: 0,
      shortCount: 1,
      notionalUsd: 7,
    });
    expect((await liquidations.stats(undefined, at)).day.count).toBe(2);
    expect(
      (await liquidations.page(1, undefined, at)).items.map(
        (e) => e.instrument,
      ),
    ).toEqual([1]);
  });
  it("segments exact rolling-day hourly buckets by asset, including clipped first/current boundaries", async () => {
    const { insert, liquidations } = setup();
    const from = at - 86400000;
    for (const value of [
      event("outside-left", { ts: from - 1 }),
      event("left-btc", { ts: from }),
      event("left-eth", { ts: from + 1, instrument: 1, notionalUsd: 7 }),
      event("interior-btc", { ts: at - 60000, notionalUsd: 0.125 }),
      event("right-btc", { ts: at, notionalUsd: 10000000000.5 }),
      event("right-eth", { ts: at - 1, instrument: 1, notionalUsd: 3 }),
      event("future-eth", { ts: at + 1, instrument: 1 }),
    ])
      insert(value);
    const all = await liquidations.stats(undefined, at);
    expect(all.hourly).toMatchObject({ intervalMs: 3600000, from, to: at });
    expect(all.hourly.buckets).toHaveLength(25);
    expect(all.hourly.buckets[0]).toEqual({
      time: Math.floor(from / 3600000) * 3600000,
      partial: true,
      assets: [
        { instrument: 0, count: 1, notionalUsd: 10000000000 },
        { instrument: 1, count: 1, notionalUsd: 7 },
      ],
    });
    expect(all.hourly.buckets.at(-1)).toMatchObject({
      partial: true,
      assets: [
        { instrument: 0, count: 1, notionalUsd: 10000000000.5 },
        { instrument: 1, count: 1, notionalUsd: 3 },
      ],
    });
    expect(all.hourly.buckets.slice(1, -1).every((b) => !b.partial)).toBe(true);
    const segments = all.hourly.buckets.flatMap((b) => b.assets);
    expect(segments.reduce((n, a) => n + a.count, 0)).toBe(all.day.count);
    expect(segments.reduce((n, a) => n + a.notionalUsd, 0)).toBe(
      all.day.notionalUsd,
    );
    expect(all.day.count).toBe(5);
    const eth = await liquidations.stats(1, at);
    expect(
      eth.hourly.buckets.every(
        (b) => b.assets.length === 1 && b.assets[0].instrument === 1,
      ),
    ).toBe(true);
    expect(eth.hourly.buckets.reduce((n, b) => n + b.assets[0].count, 0)).toBe(
      2,
    );
    expect(eth.day.notionalUsd).toBe(10);
  });
  it("retains cross-source multiplicity and additional observed asset IDs in the hourly totals", async () => {
    const { insert, liquidations } = setup();
    for (const instrument of [0, 1, 7]) {
      for (let i = 0; i < 2; i++)
        insert(event(`stream:${instrument}:${i}`, { instrument }));
      for (let i = 0; i < 3; i++)
        insert(
          event(`recent:${instrument}:${i}`, {
            instrument,
            provenance: "recent-api",
          }),
        );
    }
    const stats = await liquidations.stats(undefined, at);
    expect(stats.hourly.buckets.at(-1)?.assets).toEqual(
      [0, 1, 7].map((instrument) => ({
        instrument,
        count: 3,
        notionalUsd: 30000000000,
      })),
    );
    expect(stats.day.count).toBe(9);
    expect(
      stats.hourly.buckets
        .flatMap((b) => b.assets)
        .reduce((sum, a) => sum + a.notionalUsd, 0),
    ).toBe(stats.day.notionalUsd);
  });
  it("keeps minute/hour-aligned endpoints inclusive and distinguishes first-full from current-partial buckets", async () => {
    const { insert, liquidations } = setup();
    const end = Math.floor(at / 3600000) * 3600000;
    for (const ts of [
      end - 86400001,
      end - 86400000,
      end - 3600000,
      end,
      end + 1,
    ])
      insert(event(`boundary:${ts}`, { ts, notionalUsd: 1 }));
    const stats = await liquidations.stats(undefined, end);
    expect(stats.day.count).toBe(3);
    expect(stats.hour.count).toBe(2);
    expect(stats.hourly.buckets[0]).toMatchObject({
      partial: false,
      assets: [
        { instrument: 0, count: 1, notionalUsd: 1 },
        { instrument: 1, count: 0, notionalUsd: 0 },
      ],
    });
    expect(stats.hourly.buckets.at(-1)).toMatchObject({
      partial: true,
      assets: [
        { instrument: 0, count: 1, notionalUsd: 1 },
        { instrument: 1, count: 0, notionalUsd: 0 },
      ],
    });
  });
  it("keeps pre-observation buckets as observed zeros and rejects unsafe count/notional aggregates", async () => {
    const { db, liquidations } = setup();
    const empty = await liquidations.stats(undefined, at);
    expect(empty.coverage).toMatchObject({ partial: true, observedFrom: null });
    expect(
      empty.hourly.buckets.every((b) =>
        b.assets.every((a) => a.count === 0 && a.notionalUsd === 0),
      ),
    ).toBe(true);
    const minute = Math.floor(at / 60000) * 60000 - 60000;
    db.prepare("INSERT INTO liquidation_minutes VALUES(?,?,?,?,?,?)").run(
      0,
      minute,
      9007199254740993n,
      9007199254740993n,
      0,
      1,
    );
    await expect(liquidations.stats(undefined, at)).rejects.toThrow(
      "supported range",
    );
    db.prepare(
      "UPDATE liquidation_minutes SET event_count=1,long_count=1,notional=?",
    ).run(Infinity);
    await expect(liquidations.stats(undefined, at)).rejects.toThrow(
      "supported range",
    );
  });
  it("paginates bounded stable keys without repeating ties or including new head rows", async () => {
    const { insert, liquidations, db } = setup();
    for (let i = 0; i < 107; i++)
      insert(event(`stream:${i}`, { ts: at - 1000, notionalUsd: i + 1 }));
    const first = await liquidations.page(0, undefined, at);
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toBeTruthy();
    insert(event("newhead", { ts: at + 100, notionalUsd: 777 }));
    const second = await liquidations.page(0, first.nextCursor!, at + 1000);
    const third = await liquidations.page(0, second.nextCursor!, at + 1000);
    expect(second.items).toHaveLength(50);
    expect(third.items).toHaveLength(7);
    expect(third.nextCursor).toBeNull();
    const rows = [...first.items, ...second.items, ...third.items];
    expect(new Set(rows.map((row) => row.id)).size).toBe(107);
    expect(rows.some((row) => row.notionalUsd === 777)).toBe(false);
    await expect(
      liquidations.page(1, first.nextCursor!, at),
    ).rejects.toMatchObject({ statusCode: 400 });
    for (const cursor of [
      "bad",
      "a".repeat(1025),
      Buffer.from(JSON.stringify([1, 0, -1, "bad", at])).toString("base64url"),
    ])
      await expect(liquidations.page(0, cursor, at)).rejects.toMatchObject({
        statusCode: 400,
      });
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id,payload FROM liquidation_events WHERE instrument=? AND source_at<=? ORDER BY source_at DESC,id DESC LIMIT 51",
      )
      .all(0, at);
    expect(JSON.stringify(plan)).toContain("liquidation_event_instrument");
  });
  it("backfills once in bounded chunks and persists checkpoints across restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paperdash-liq-"));
    dirs.push(dir);
    const path = join(dir, "history.sqlite");
    const first = setup(path);
    for (let i = 0; i < 5; i++)
      first.insert(event(`z${i}`, { notionalUsd: i + 1 }), false);
    first.insert(event("open", { kind: "open" }), false);
    expect(await first.liquidations.backfill(2)).toEqual({
      processed: 2,
      complete: false,
    });
    expect((await first.liquidations.stats(undefined, at)).day.count).toBe(2);
    first.db.close();
    dbs.splice(dbs.indexOf(first.db), 1);
    const second = setup(path);
    expect(await second.liquidations.backfill(2)).toEqual({
      processed: 2,
      complete: false,
    });
    expect(await second.liquidations.backfill(2)).toEqual({
      processed: 1,
      complete: true,
    });
    expect(await second.liquidations.backfill(2)).toEqual({
      processed: 0,
      complete: true,
    });
    expect((await second.liquidations.stats(undefined, at)).day.count).toBe(5);
    second.insert(event("a-before-completed-cursor", { notionalUsd: 99 }));
    expect((await second.liquidations.stats(undefined, at)).day.count).toBe(6);
    expect(await second.liquidations.backfill(2)).toEqual({
      processed: 0,
      complete: true,
    });
    expect(
      (await second.liquidations.stats(undefined, at)).coverage
        .projectionBackfillComplete,
    ).toBe(true);
    const plan = second.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id,payload FROM trade_observations WHERE id>? AND json_extract(payload,'$.kind')='liq' ORDER BY id LIMIT 1",
      )
      .all("");
    expect(JSON.stringify(plan)).toContain("liquidation_raw_ids");
  });
  it("rolls back raw observation, membership and totals together when projection fails", async () => {
    const { insert, liquidations, db } = setup();
    db.exec(
      "CREATE TRIGGER reject_liquidation BEFORE INSERT ON liquidation_events BEGIN SELECT RAISE(ABORT,'projection failed'); END",
    );
    expect(() => insert(event("rollback"))).toThrow("projection failed");
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM trade_observations").get(),
    ).toEqual({ n: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM liquidation_members").get(),
    ).toEqual({ n: 0 });
    expect((await liquidations.stats(undefined, at)).day.count).toBe(0);
    db.exec("DROP TRIGGER reject_liquidation");
    insert(event("rollback"));
    expect((await liquidations.stats(undefined, at)).day.count).toBe(1);
  });
  it("stops at its work deadline and saves only the committed resume position", async () => {
    const { insert, liquidations } = setup();
    for (let i = 0; i < 3; i++)
      insert(event(`legacy:${i}`, { notionalUsd: i + 1 }), false);
    const timer = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(3001);
    try {
      expect(await liquidations.backfill(100)).toEqual({
        processed: 1,
        complete: false,
      });
    } finally {
      timer.mockRestore();
    }
    expect((await liquidations.stats(undefined, at)).day.count).toBe(1);
    expect(await liquidations.backfill(100)).toEqual({
      processed: 2,
      complete: true,
    });
    expect((await liquidations.stats(undefined, at)).day.count).toBe(3);
  });
});

describe("cached liquidation responses", () => {
  it("keeps initial reads cached, tail pages bounded, and partial coverage separate from stale", async () => {
    const { store, insert, liquidations } = setup();
    for (let i = 0; i < 55; i++)
      insert(event(`event:${i}`, { notionalUsd: i + 1 }));
    await store.put("collector-heartbeat", { at, errors: {} }, at);
    await store.put("overview", { status: { stream: "connected" } }, at);
    await refreshLiquidations(store, at);
    const page = vi.spyOn(liquidations, "page"),
      stats = vi.spyOn(liquidations, "stats");
    const first = await readLiquidations(store, undefined, undefined, at);
    expect(first.stale).toBe(false);
    expect(
      first.hourly?.buckets
        .flatMap((b) => b.assets)
        .reduce((n, a) => n + a.count, 0),
    ).toBe(55);
    expect(first.coverage).toMatchObject({
      partial: true,
      projectionBackfillComplete: false,
    });
    expect(page).not.toHaveBeenCalled();
    expect(stats).not.toHaveBeenCalled();
    expect(
      (await readLiquidations(store, undefined, first.nextCursor!, at)).items,
    ).toHaveLength(5);
    expect(page).toHaveBeenCalledOnce();
    expect(stats).not.toHaveBeenCalled();
    expect(
      (await readLiquidations(store, undefined, undefined, at + 15001)).stale,
    ).toBe(true);
  });
  it("reads older cached snapshots without inventing hourly buckets during rollout", async () => {
    const { store } = setup();
    await store.put("collector-heartbeat", { at, errors: {} }, at);
    await store.put("overview", { status: { stream: "connected" } }, at);
    await refreshLiquidations(store, at);
    const value = await readLiquidations(store, undefined, undefined, at);
    const { hourly: _hourly, ...legacy } = value;
    await store.put("liquidations:all", legacy, at);
    expect(
      (await readLiquidations(store, undefined, undefined, at)).hourly,
    ).toBeUndefined();
  });
  it.each(["stream", "recent", "liquidations", "liquidations-backfill"])(
    "marks feed or projection failure stale despite a current heartbeat: %s",
    async (loop) => {
      const { store } = setup();
      await store.put(
        "collector-heartbeat",
        { at, errors: { [loop]: "failed" } },
        at,
      );
      await store.put("overview", { status: { stream: "connected" } }, at);
      await refreshLiquidations(store, at);
      expect(
        (await readLiquidations(store, undefined, undefined, at)).stale,
      ).toBe(true);
      await store.put("collector-heartbeat", { at, errors: {} }, at);
      await store.put("overview", { status: { stream: "disconnected" } }, at);
      expect(
        (await readLiquidations(store, undefined, undefined, at)).stale,
      ).toBe(true);
    },
  );
});
