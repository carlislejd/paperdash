import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { LeaderboardResponse } from "../../../packages/shared/src/types.js";
import { buildApi } from "../src/api.js";
import { createStore, type Store } from "../src/store.js";
import { RequestGate, Upstream } from "../src/upstream.js";
import { normalizeTrade } from "../src/schemas.js";

const wallet = (n: number) => `0x${String(n).padStart(40, "0")}`;
const large = 900719925474099312345678901234567890n;
const stores: Store[] = [];
const apps: FastifyInstance[] = [];
const sources: Upstream[] = [];
let now: number;
beforeEach(() => {
  now = 1_800_000_030_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const source of sources.splice(0)) await source.close();
  for (const store of stores.splice(0)) await store.close();
  vi.restoreAllMocks();
});
function accounts(
  totals = [String(large), "17"],
  tracked = String(large * 5n + 233n),
) {
  return {
    ok: true,
    count: 76,
    pageInfo: { page: 2, totalPages: 4 },
    summary: {
      uniqueAccounts: 1000,
      trackedBalance: "0",
      trackedQueued: "0",
      trackedOpenNotional: "0",
      trackedPaper: tracked,
    },
    accounts: totals.map((total, i) => ({
      address: wallet(i + 1),
      leaderboardName: `Paper ${i + 1}`,
      currentBalance: "1",
      currentQueued: "0",
      currentOpenNotional: "0",
      currentOpenPositionCount: 0,
      currentUnrealizedPnl: "-12345",
      realizedPnl: "99999999",
      totalVolume: "88888888",
      totalWindowedPnl: i === 0 ? "-42" : "53",
      paperTotal: total,
      lastActiveTs: Math.floor(now / 1000),
    })),
  };
}
async function fixture(value = accounts()) {
  const store = await createStore({ memory: true, databaseUrl: "" });
  stores.push(store);
  await store.put("collector-heartbeat", { at: now, errors: {} }, now);
  await store.put("overview", { status: { stream: "connected" } }, now);
  const fetcher = vi.fn(async (_input: string | URL | Request) =>
    Response.json(value),
  );
  const source = new Upstream(
    store,
    fetcher as typeof fetch,
    "https://papertrade.test",
    new RequestGate(3, 0),
  );
  sources.push(source);
  const app = await buildApi(store, source, undefined, {
    logger: false,
    readCacheMs: 0,
  });
  apps.push(app);
  return { store, source, app, fetcher };
}

describe("source-ranked PAPER ownership", () => {
  it("uses the canonical PAPER sort with 24h accompanying PnL, source order and page-offset ranks", async () => {
    const { store, source, app, fetcher } = await fixture();
    const walletRequest = vi.spyOn(source, "wallet");
    const activity = vi.spyOn(store.analytics, "walletMetrics");
    const response = await app.inject(
      "/api/leaderboard?metric=paper&page=2&q=Paper%20%26%20Co",
    );
    expect(response.statusCode).toBe(200);
    expect(String(fetcher.mock.calls[0][0])).toBe(
      "https://papertrade.test/state/leaderboard/accounts?page=2&pageSize=25&q=paper+%26+co&sortDir=desc&sortKey=paperTotal&window=24h",
    );
    const data = response.json<LeaderboardResponse>();
    expect(data).toMatchObject({
      metric: "paper",
      window: "current",
      count: 76,
      pageInfo: { page: 2, totalPages: 4 },
      accountReceivedAt: now,
      accountStale: false,
      rows: [
        {
          address: wallet(1),
          rank: 51,
          paperTotalRaw: String(large),
          pnlRaw: "-42",
          currentUnrealizedPnlRaw: "-12345",
        },
        { address: wallet(2), rank: 52, paperTotalRaw: "17", pnlRaw: "53" },
      ],
      paperOwnership: {
        trackedTotalRaw: String(large * 5n + 233n),
        pageTotalRaw: String(large + 17n),
        pageShareBps: Number(((large + 17n) * 10000n) / (large * 5n + 233n)),
      },
    });
    expect(response.headers["cdn-cache-control"]).toBe("no-store");
    await app.inject("/api/leaderboard?metric=paper&page=2&q=Paper%20%26%20Co");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(activity).toHaveBeenCalledExactlyOnceWith(
      [wallet(1), wallet(2)],
      now,
    );
    expect(walletRequest).not.toHaveBeenCalled();
  });

  it("adds current PAPER holdings to the PnL rank without changing its 24h contract", async () => {
    const { app, fetcher } = await fixture();
    const data = (
      await app.inject("/api/leaderboard?metric=pnl&page=2")
    ).json<LeaderboardResponse>();
    expect(
      new URL(String(fetcher.mock.calls[0][0])).searchParams.get("sortKey"),
    ).toBe("totalWindowedPnl");
    expect(data.window).toBe("24h");
    expect(data.rows[0]).toMatchObject({
      paperTotalRaw: String(large),
      pnlRaw: "-42",
    });
    expect(data.paperOwnership?.pageTotalRaw).toBe(String(large + 17n));
  });

  it("keeps the global tracked denominator when a name search narrows the page", async () => {
    const value = accounts(["300"], "1000");
    value.count = 1;
    value.pageInfo = { page: 0, totalPages: 1 };
    const { app } = await fixture(value);
    const data = (
      await app.inject("/api/leaderboard?metric=paper&q=Paper%201")
    ).json<LeaderboardResponse>();
    expect(data.count).toBe(1);
    expect(data.paperOwnership).toEqual({
      trackedTotalRaw: "1000",
      pageTotalRaw: "300",
      pageShareBps: 3000,
    });
  });

  it.each([
    { totals: ["0"], tracked: "0", share: null },
    { totals: ["0"], tracked: "100", share: 0 },
    { totals: [], tracked: "100", share: 0 },
    { totals: ["70", "40"], tracked: "100", share: null },
    { totals: ["100"], tracked: "100", share: 10000 },
  ])(
    "guards zero/inconsistent denominators and preserves empty-page semantics: $totals / $tracked",
    async ({ totals, tracked, share }) => {
      const { source } = await fixture(accounts(totals, tracked));
      const data = await source.leaderboard("paper");
      expect(data.paperOwnership).toEqual({
        trackedTotalRaw: tracked,
        pageTotalRaw: totals
          .reduce((sum, raw) => sum + BigInt(raw), 0n)
          .toString(),
        pageShareBps: share,
      });
      expect(data.count).toBe(76); // The source account count is not a count of nonzero holders.
    },
  );

  it("keeps exact ownership through local activity failure and cached source outage", async () => {
    const { store, source, fetcher } = await fixture();
    vi.spyOn(store.analytics, "walletMetrics").mockRejectedValue(
      new Error("activity unavailable"),
    );
    const first = await source.leaderboard("paper");
    expect(first).toMatchObject({
      accountStale: false,
      activityCoverage: { stale: true },
    });
    expect(first.rows[0]).toMatchObject({
      paperTotalRaw: String(large),
      tradeCount: null,
      volumeUsd: null,
      assetsTraded: null,
    });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    now += 61000;
    await store.put(`cache-error:${url.pathname}${url.search}`, {
      until: now + 60000,
      message: "source unavailable",
    });
    const saved = await source.leaderboard("paper");
    expect(saved.accountStale).toBe(true);
    expect(saved.stale).toBe(true);
    expect(saved.receivedAt).toBe(first.receivedAt);
    expect(saved.paperOwnership).toEqual(first.paperOwnership);
    expect(saved.rows[0].paperTotalRaw).toBe(first.rows[0].paperTotalRaw);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps observed rankings independent of current ownership and makes no source request", async () => {
    const { store, source, fetcher } = await fixture();
    await store.recordTrade(
      normalizeTrade(
        {
          ts: now - 1000,
          wallet: wallet(1),
          instrument: "BTC",
          side: "long",
          leverage: 10,
          notionalUsd: 100,
          kind: "open",
          pnlUsd: null,
        },
        "public-stream",
        "paper-test",
      ),
    );
    await store.analytics.backfill();
    for (const metric of ["volume", "trades"] as const) {
      const data = await source.leaderboard(metric);
      expect(data.rows[0].paperTotalRaw).toBeNull();
      expect(data).not.toHaveProperty("paperOwnership");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
