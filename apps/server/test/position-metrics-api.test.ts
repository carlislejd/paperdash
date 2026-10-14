import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../src/api.js";
import { createStore, type Store } from "../src/store.js";
import { readPositionMetrics } from "../src/position-metrics.js";
import { Upstream } from "../src/upstream.js";

const address = `0x${"1".repeat(40)}`;
let store: Store;
beforeEach(async () => {
  store = await createStore({ memory: true, databaseUrl: "" });
  await store.put("collector-heartbeat", { at: Date.now(), errors: {} });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await store.close();
});

describe("position metric responses", () => {
  it("serves retained rollups with partial global coverage, no source fetch or history scan, and ETags", async () => {
    const upstream = new Upstream(store);
    const source = vi.spyOn(upstream, "request");
    const history = vi.spyOn(store.history, "readPage");
    vi.spyOn(store.positionMetrics, "read").mockResolvedValue({
      positionCount: 4,
      avgHoldMs: 90000,
      avgLeverage: 12.5,
      excludedCount: 1,
      updatedAt: 1000,
      projectionBackfillComplete: true,
      pending: false,
    });
    await store.put("indexing-status", { wallets: 80 });
    await store.put("account-count", 100);
    const app = await buildApi(store, upstream, undefined, { logger: false });
    try {
      const first = await app.inject("/api/position-metrics");
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        positionCount: 4,
        avgHoldMs: 90000,
        avgLeverage: 12.5,
        excludedCount: 1,
        stale: false,
        coverage: {
          source: "retained-closed-positions",
          historyBackfillComplete: null,
          projectionBackfillComplete: true,
          walletsDiscovered: 80,
          totalWallets: 100,
        },
      });
      const second = await app.inject({
        url: "/api/position-metrics",
        headers: { "if-none-match": String(first.headers.etag) },
      });
      expect(second.statusCode).toBe(304);
      expect(source).not.toHaveBeenCalled();
      expect(history).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("reads an unindexed wallet without duplicate enrollment writes or claiming empty means are zero", async () => {
    const enroll = vi.spyOn(store.history, "ensureWallet");
    const app = await buildApi(store, undefined, undefined, { logger: false });
    try {
      const result = await app.inject(
        `/api/wallets/${address}/position-metrics`,
      );
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({
        positionCount: 0,
        avgHoldMs: null,
        avgLeverage: null,
        coverage: { historyBackfillComplete: false },
        highlights: {
          tradeCount: null,
          bestTrade: null,
          worstTrade: null,
          complete: false,
        },
      });
      expect(await store.history.getStatus(address)).toHaveLength(0);
      expect(enroll).not.toHaveBeenCalled();
      expect(
        (await app.inject("/api/wallets/invalid/position-metrics")).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("keeps unknown counts distinct from checked-empty history and discloses partial retained highlights", async () => {
    await store.positionMetrics.tick();
    expect(
      (await readPositionMetrics(store, address)).highlights,
    ).toMatchObject({ tradeCount: null, complete: false });
    vi.spyOn(store.history, "getStatus").mockResolvedValue([
      {
        kind: "trades",
        nextRun: Date.now(),
        lockedUntil: 0,
        state: {
          phase: "head",
          cursor: null,
          cycle: "test",
          complete: true,
          pages: 1,
          failures: 0,
          lastSuccessAt: Date.now(),
        },
      },
    ]);
    expect((await readPositionMetrics(store, address)).highlights).toEqual({
      bestTrade: null,
      worstTrade: null,
      tradeCount: 0,
      excludedCount: 0,
      complete: true,
    });
    vi.spyOn(store.positionMetrics, "read").mockResolvedValue({
      positionCount: 1,
      avgHoldMs: 100,
      avgLeverage: 2,
      excludedCount: 0,
      updatedAt: 1,
      projectionBackfillComplete: true,
      pending: false,
      highlights: {
        bestTrade: { pnlRaw: "-1", symbol: "BTC", positionId: "1" },
        worstTrade: { pnlRaw: "-2", symbol: "BTC", positionId: "2" },
        tradeCount: 2,
        excludedCount: 1,
        complete: false,
      },
    });
    const result = await readPositionMetrics(store, address);
    expect(result.positionCount).toBe(1); // mean cohort is deliberately separate
    expect(result.highlights).toMatchObject({
      tradeCount: 2,
      complete: false,
      bestTrade: { pnlRaw: "-1" },
    });
  });

  it("distinguishes projection/history errors from unrelated live-stream health", async () => {
    const now = Date.now();
    await store.put("collector-heartbeat", {
      at: now,
      errors: { stream: "disconnected" },
    });
    expect((await readPositionMetrics(store, undefined, now)).stale).toBe(
      false,
    );
    expect(
      (await readPositionMetrics(store, undefined, now + 30001)).stale,
    ).toBe(true);
    await store.put("collector-heartbeat", {
      at: now,
      errors: { "position-metrics": "delayed" },
    });
    expect((await readPositionMetrics(store, undefined, now)).stale).toBe(true);
    await store.put("collector-heartbeat", {
      at: now,
      errors: { "wallet-indexer": "delayed" },
    });
    expect((await readPositionMetrics(store, undefined, now)).stale).toBe(true);
    await store.put("collector-heartbeat", { at: now, errors: {} });
    vi.spyOn(store.history, "getStatus").mockResolvedValue([
      {
        kind: "trades",
        nextRun: now + 1000,
        lockedUntil: 0,
        state: {
          phase: "head",
          cursor: null,
          cycle: "test",
          complete: true,
          pages: 3,
          failures: 1,
          lastSuccessAt: now - 1000,
          error: "Source delayed",
        },
      },
    ]);
    expect(await readPositionMetrics(store, address, now)).toMatchObject({
      stale: true,
      coverage: {
        historyBackfillComplete: true,
        lastHistoryIndexedAt: now - 1000,
      },
    });
  });
});
