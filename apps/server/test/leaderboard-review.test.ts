import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import type { FastifyInstance } from "fastify";
import { buildApi } from "../src/api.js";
import { ChangeBus } from "../src/bus.js";
import { refreshAssetAnalytics, retainAssetSource } from "../src/assets.js";
import { normalizeTrade } from "../src/schemas.js";
import { createStore, type Store } from "../src/store.js";
import { RequestGate, Upstream } from "../src/upstream.js";

const address = `0x${"1".repeat(40)}`;
const other = `0x${"2".repeat(40)}`;
const stores: Store[] = [];
const upstreams: Upstream[] = [];
const apps: FastifyInstance[] = [];
let now: number;
beforeEach(() => {
  now = 1_800_000_030_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const upstream of upstreams.splice(0)) await upstream.close();
  for (const store of stores.splice(0)) await store.close();
  vi.restoreAllMocks();
});
function sourceAccounts(page = 0) {
  return {
    ok: true,
    count: 76,
    pageInfo: { page, totalPages: 4 },
    summary: { uniqueAccounts: 76, trackedBalance: "200", trackedQueued: "0", trackedOpenNotional: "0", trackedPaper: "0" },
    accounts: [{
      address, leaderboardName: "Shiro & Co", currentBalance: "200", currentQueued: "0",
      currentOpenNotional: "0", currentOpenPositionCount: 0, currentUnrealizedPnl: "500",
      // Deliberately disagree: only the windowed field may become the 24h P&L.
      realizedPnl: "999000000000000000000", totalVolume: "999999000000000000000000",
      totalWindowedPnl: "-12345000000000000000", paperTotal: "0", lastActiveTs: Math.floor(now / 1000),
    }],
  };
}
async function fixture(fetcher = vi.fn(async (input: string | URL | Request) => {
  const url = new URL(String(input));
  return Response.json(sourceAccounts(Number(url.searchParams.get("page") ?? 0)));
})) {
  const store = await createStore({ memory: true, databaseUrl: "" });
  stores.push(store);
  await store.put("collector-heartbeat", { at: now, errors: {} }, now);
  await store.put("overview", { status: { stream: "connected" } }, now);
  const upstream = new Upstream(store, fetcher as typeof fetch, "https://papertrade.test", new RequestGate(3, 0));
  upstreams.push(upstream);
  const app = await buildApi(store, upstream, new ChangeBus(), { logger: false });
  apps.push(app);
  return { store, upstream, app, fetcher };
}
async function execution(store: Store, wallet: string, kind: "open" | "close" | "liq", notionalUsd: number, at: number, arrival: string) {
  const source = { ts: at, wallet, instrument: "BTC", side: "long", leverage: 50, notionalUsd, kind, pnlUsd: kind === "open" ? null : 10 };
  await store.trade(normalizeTrade(source, "public-stream", arrival));
  return source;
}

describe("independent leaderboard and asset API contracts", () => {
  it("requests the canonical source 24h P&L sort and preserves signed raw P&L", async () => {
    const { app, fetcher } = await fixture();
    const response = await app.inject("/api/leaderboard?metric=pnl&page=2&q=Shiro%20%26%20Co");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(String(fetcher.mock.calls[0][0])).toBe("https://papertrade.test/state/leaderboard/accounts?page=2&pageSize=25&q=shiro+%26+co&sortDir=desc&sortKey=totalWindowedPnl&window=24h");
    expect(response.json()).toMatchObject({
      window: "24h", metric: "pnl", stale: false,
      rows: [{ address, leaderboardName: "Shiro & Co", rank: 51, pnlRaw: "-12345000000000000000", volumeUsd: null, tradeCount: null }],
      pageInfo: { page: 2, totalPages: 4 }, count: 76,
      coverage: { source: "papertrade-leaderboard" },
    });
    await app.inject("/api/leaderboard?metric=pnl&page=2&q=Shiro%20%26%20Co");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid metric, paging and observed-address queries before any upstream request", async () => {
    const { app, fetcher } = await fixture();
    for (const query of [
      "metric=profit", "page=-1", "page=0.5", "page=wat", "page=1000001",
      `q=${"a".repeat(43)}`, "metric=volume&q=alice", "metric=trades&q=%25", "metric=trades&q=0xzz",
    ]) {
      const response = await app.inject(`/api/leaderboard?${query}`);
      expect(response.statusCode, query).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("ranks retained open, close and liquidation executions without borrowing source lifetime volume", async () => {
    const { store, app, fetcher } = await fixture();
    const opened = await execution(store, address, "open", 100, now - 10_000, "open-arrival");
    await store.trade(normalizeTrade({ ...opened, seq: "101" }, "recent-api"));
    await execution(store, address, "close", 100, now - 9000, "close-arrival");
    await execution(store, address, "liq", 100, now - 8000, "liq-arrival");
    await execution(store, other, "open", 1000, now - 7000, "other-arrival");
    await execution(store, other, "open", 1_000_000, now - 86_400_001, "old-arrival");
    await store.analytics.backfill();
    await store.put("collector-heartbeat", { at: now, errors: {} }, now);

    const trades = await app.inject("/api/leaderboard?metric=trades");
    expect(trades.statusCode).toBe(200);
    expect(trades.json()).toMatchObject({
      window: "24h", metric: "trades", stale: false, count: 2,
      rows: [
        { address, rank: 1, tradeCount: 3, volumeUsd: 300, pnlRaw: null },
        { address: other, rank: 2, tradeCount: 1, volumeUsd: 1000, pnlRaw: null },
      ],
      coverage: { source: "retained-public-observations", identityAmbiguous: true, projectionBackfillComplete: true },
    });
    const volume = await app.inject("/api/leaderboard?metric=volume");
    expect(volume.json().rows.map((row: { address: string }) => row.address)).toEqual([other, address]);
    expect(volume.json().rows[0]).toMatchObject({ volumeUsd: 1000, tradeCount: 1 });
    const filtered = await app.inject("/api/leaderboard?metric=trades&q=0x111");
    expect(filtered.json()).toMatchObject({ count: 1, rows: [{ address, tradeCount: 3 }] });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not mark a freshly queried local ranking live when collection stopped", async () => {
    const { store, app } = await fixture();
    await execution(store, address, "open", 100, now - 1000, "arrival");
    await store.analytics.backfill();
    await store.put("collector-heartbeat", { at: now - 60_000, errors: {} }, now);
    const response = await app.inject("/api/leaderboard?metric=trades");
    expect(response.statusCode).toBe(200);
    expect(response.json().receivedAt).toBe(now);
    expect(response.json().stale).toBe(true);
  });

  it.each(["volume", "trades"])(
    "re-evaluates %s feed health even while the ranking itself is cached",
    async (metric) => {
      const { store, app, fetcher } = await fixture();
      await execution(store, address, "open", 100, now - 1000, "arrival");
      await store.analytics.backfill();
      const first = await app.inject(`/api/leaderboard?metric=${metric}`);
      expect(first.json().stale).toBe(false);

      for (const failedFeed of ["stream", "recent", "asset-activity"]) {
        await store.put("collector-heartbeat", { at: now, errors: { [failedFeed]: "fixture outage" } }, now);
        const response = await app.inject(`/api/leaderboard?metric=${metric}`);
        expect(response.statusCode).toBe(200);
        expect(response.json().receivedAt).toBe(first.json().receivedAt);
        expect(response.json().rows).toEqual(first.json().rows);
        expect(response.json().stale, failedFeed).toBe(true);
        expect(response.json().error).toMatch(/collection is delayed/);
      }

      await store.put("collector-heartbeat", { at: now, errors: {} }, now);
      await store.put("overview", { status: { stream: "connecting" } }, now);
      expect((await app.inject(`/api/leaderboard?metric=${metric}`)).json().stale).toBe(true);
      await store.put("overview", { status: { stream: "connected" } }, now);
      expect((await app.inject(`/api/leaderboard?metric=${metric}`)).json().stale).toBe(false);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("serves retained asset data with no source request and preserves its age", async () => {
    const { store, app, fetcher } = await fixture();
    expect((await app.inject("/api/assets")).json()).toMatchObject({ assets: [], stale: true, sourceAt: null });
    await retainAssetSource(store, {
      ok: true, historyGeneration: "generation", historyRevision: "epoch", sourceAsOfMs: now,
      head: [now, 100, 0, 0, 75.25, 24.75, 0, 0],
    }, now);
    await refreshAssetAnalytics(store, now);
    const response = await app.inject("/api/assets");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.json()).toMatchObject({
      stale: false, receivedAt: now, sourceAt: now,
      assets: [
        { symbol: "BTC", openInterest: { totalRaw: "100000000000000000000", longSharePct: 75.25, shortSharePct: 24.75 } },
        { symbol: "ETH", openInterest: { longSharePct: null, shortSharePct: null } },
      ],
    });
    now += 30_001;
    expect((await app.inject("/api/assets")).json().stale).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("compresses retained history and revalidates representations without caching away feed failures", async () => {
    const { store, app, fetcher } = await fixture();
    for (const instrument of [0, 1]) {
      for (let index = 0; index < 32; index++) {
        const time = Math.floor(now / 60000) * 60000 - index * 60000;
        await store.analytics.sample({
          instrument, time, sourceAt: time, receivedAt: time,
          longRaw: "75000000000000000000", shortRaw: "25000000000000000000", sourceBlock: null,
        });
      }
    }
    await retainAssetSource(store, {
      ok: true, historyGeneration: "generation", historyRevision: "epoch", sourceAsOfMs: now,
      head: [now, 100, 0, 0, 75, 25, 75, 25],
    }, now);
    await refreshAssetAnalytics(store, now);

    const plain = await app.inject("/api/assets");
    expect(plain.statusCode).toBe(200);
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.headers.vary).toMatch(/Accept-Encoding/i);
    expect(plain.headers.vary).toMatch(/Origin/i);
    const zipped = await app.inject({ url: "/api/assets", headers: { "accept-encoding": "br, gzip" } });
    expect(zipped.statusCode).toBe(200);
    expect(zipped.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(zipped.rawPayload).toString()).toBe(plain.payload);
    expect(zipped.rawPayload.byteLength).toBeLessThan(plain.rawPayload.byteLength / 2);
    expect(zipped.headers.etag).not.toBe(plain.headers.etag);

    const unchanged = await app.inject({
      url: "/api/assets", headers: { "accept-encoding": "gzip", "if-none-match": `W/${zipped.headers.etag}` },
    });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.payload).toBe("");
    expect(unchanged.headers.etag).toBe(zipped.headers.etag);
    const gzipRefused = await app.inject({ url: "/api/assets", headers: { "accept-encoding": "gzip;q=0, br" } });
    expect(gzipRefused.statusCode).toBe(200);
    expect(gzipRefused.headers["content-encoding"]).toBeUndefined();
    expect(gzipRefused.headers.etag).toBe(plain.headers.etag);
    const changedEncoding = await app.inject({
      url: "/api/assets", headers: { "accept-encoding": "gzip", "if-none-match": plain.headers.etag! },
    });
    expect(changedEncoding.statusCode).toBe(200);

    // Same amounts and source timestamps, but a new feed error must invalidate
    // the representation rather than leave a browser's cached "live" response.
    await store.put("collector-heartbeat", { at: now, errors: { recent: "fixture outage" } }, now);
    const delayed = await app.inject({
      url: "/api/assets", headers: { "accept-encoding": "gzip", "if-none-match": zipped.headers.etag! },
    });
    expect(delayed.statusCode).toBe(200);
    expect(delayed.headers.etag).not.toBe(zipped.headers.etag);
    expect(JSON.parse(gunzipSync(delayed.rawPayload).toString())).toMatchObject({ stale: true, error: "Trade activity snapshot is delayed." });

    await store.put("collector-heartbeat", { at: now, errors: {} }, now);
    now += 30_001;
    const aged = await app.inject({ url: "/api/assets", headers: { "if-none-match": plain.headers.etag! } });
    expect(aged.statusCode).toBe(200);
    expect(aged.json().stale).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
