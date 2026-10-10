import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createStore, visibleTrades, type Store } from "../src/store.js";
import {
  accountsSchema,
  cashflowSchema,
  normalizeTrade,
  walletSchema,
} from "../src/schemas.js";
import {
  canonicalPath,
  firstWalletEvent,
  RequestGate,
  retryAfter,
  Upstream,
  UpstreamError,
} from "../src/upstream.js";
import { downsample, emptyOverview } from "../src/collector.js";
import { buildApi, EventHub } from "../src/api.js";
import { ChangeBus } from "../src/bus.js";

// Synthetic fixtures are confined to tests. The application never seeds them.
const address = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const txHash = `0x${"1".repeat(64)}`;
const raw = "90071992547409930000000000000000000001";
const wallet = {
  address,
  indexedThroughBlock: 100,
  indexedThroughTimestamp: Math.floor(Date.now() / 1000),
  accountRevision: 2,
  balance: raw,
  queued: "0",
  locked: "0",
  paper: { balance: "0", staked: "0", pendingBase: "0", rewardDebt: "5" },
  lifetime: {
    depositedRaw: raw,
    withdrawnRaw: "0",
    realizedPnlRaw: "0",
    feesPaidRaw: "0",
    tradedNotionalRaw: "0",
    paperRewardsClaimedRaw: "0",
  },
  openPositions: [],
  sessionKeys: [[other, "9999999999"]],
  operations: [{ private: "not public" }],
};
const sourceTrade = {
  ts: 1791605504000,
  wallet: address,
  instrument: "BTC",
  side: "long",
  leverage: 50,
  notionalUsd: 1000,
  kind: "open",
  pnlUsd: null,
};
const stores: Store[] = [];
const dirs: string[] = [];
async function memory() {
  const s = await createStore({ memory: true });
  stores.push(s);
  return s;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) await s.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("exact public account data", () => {
  it("keeps raw deposited amounts exact and removes session keys/operations", () => {
    const parsed = walletSchema.parse(wallet);
    expect(parsed.lifetime.depositedRaw).toBe(raw);
    expect(parsed.balance).toBe(raw);
    expect(parsed).not.toHaveProperty("sessionKeys");
    expect(parsed).not.toHaveProperty("operations");
    expect(parsed.paper).not.toHaveProperty("rewardDebt");
    expect(
      cashflowSchema.parse({
        timestampMs: 100,
        txHash,
        amountRaw: raw,
        kind: "Withdrawal",
        recipientAmountRaw: null,
        route: null,
        withdrawalStatus: "in_transit",
      }).withdrawalStatus,
    ).toBe("in_transit");
    expect(() =>
      cashflowSchema.parse({
        timestampMs: 100,
        txHash,
        amountRaw: 9007199254740993,
        kind: "Deposit",
      }),
    ).toThrow();
  });
  it("decodes split SSE frames, ignores heartbeat, and refuses the wrong account", async () => {
    const text = `: connected\r\n\r\nevent: heartbeat\r\ndata: null\r\n\r\nevent: wallet\r\ndata: ${JSON.stringify(wallet)}\r\n\r\n`;
    const stream = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < text.length; i += 7)
            controller.enqueue(new TextEncoder().encode(text.slice(i, i + 7)));
          controller.close();
        },
      });
    expect((await firstWalletEvent(stream(), address)).balance).toBe(raw);
    await expect(firstWalletEvent(stream(), other)).rejects.toThrow(
      "different account",
    );
  });
  it("retains separate API sequences but suppresses duplicate stream display observations", () => {
    const stream = normalizeTrade(sourceTrade, "public-stream");
    const first = normalizeTrade({ ...sourceTrade, seq: "1" }, "recent-api");
    const second = normalizeTrade({ ...sourceTrade, seq: "2" }, "recent-api");
    expect(visibleTrades([stream, first, second])).toEqual([first, second]);
    expect(first.instrument).toBe(0);
    expect(
      normalizeTrade(sourceTrade, "public-stream", "arrival-1").id,
    ).not.toBe(normalizeTrade(sourceTrade, "public-stream", "arrival-2").id);
    expect(() => normalizeTrade(sourceTrade, "recent-api")).toThrow(
      "sequence ID",
    );
    expect(() =>
      normalizeTrade(
        { ...sourceTrade, instrument: "UNKNOWN" },
        "public-stream",
      ),
    ).toThrow();
  });
});

describe("upstream resilience", () => {
  it("canonicalizes query order and escapes user-controlled values", () => {
    expect(
      canonicalPath("/query/accounts/a/trades", {
        limit: 75,
        filter: "all",
        cursor: "x&limit=999",
      }),
    ).toBe(
      "/query/accounts/a/trades?cursor=x%26limit%3D999&filter=all&limit=75",
    );
    expect(retryAfter("90", 1000)).toBe(91000);
  });
  it("coalesces concurrent loads, persists results, and serves stale data on failure", async () => {
    const store = await memory();
    const upstream = new Upstream(store);
    let resolve!: (v: { amount: string }) => void;
    const loader = vi.fn(
      () =>
        new Promise<{ amount: string }>((r) => {
          resolve = r;
        }),
    );
    const a = upstream.cached("same", 1000, loader);
    const b = upstream.cached("same", 1000, loader);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    resolve({ amount: raw });
    expect((await a).value.amount).toBe(raw);
    expect(await b).toEqual(await a);
    await store.put("cache:old", { amount: raw }, Date.now() - 60000);
    const stale = await upstream.cached(
      "old",
      1000,
      async () => {
        throw new Error("upstream unavailable");
      },
      { wait: true },
    );
    expect(stale).toMatchObject({
      value: { amount: raw },
      stale: true,
      error: "upstream unavailable",
    });
  });
  it("honors Retry-After and does not retry a rate-limited source immediately", async () => {
    const store = await memory();
    const fetcher = vi.fn(
      async () =>
        new Response("{}", { status: 429, headers: { "Retry-After": "90" } }),
    );
    const upstream = new Upstream(
      store,
      fetcher as typeof fetch,
      "https://test.invalid",
      new RequestGate(1, 0),
    );
    await expect(
      upstream.request("/directory", accountsSchema),
    ).rejects.toMatchObject({ status: 429 });
    await expect(
      upstream.request("/directory", accountsSchema),
    ).rejects.toMatchObject({ status: 429 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(upstream.gate.cooldown).toBeGreaterThan(Date.now() + 85000);
  });
  it("returns explicit partial-wallet errors without disguising missing history as success", async () => {
    const store = await memory();
    const upstream = new Upstream(store);
    vi.spyOn(upstream, "snapshot").mockResolvedValue({
      value: walletSchema.parse(wallet),
      receivedAt: Date.now(),
      stale: false,
    });
    vi.spyOn(upstream, "history").mockRejectedValue(
      new UpstreamError("History unavailable."),
    );
    vi.spyOn(upstream, "request").mockRejectedValue(
      new UpstreamError("Portfolio unavailable."),
    );
    const result = await upstream.wallet(address);
    expect(result.snapshot?.balance).toBe(raw);
    expect(result.stale).toBe(true);
    expect(result.errors).toHaveLength(3);
    expect(result.portfolio).toBeNull();
  });
});

describe("durability and display bounds", () => {
  it("commits a trade and its notification together and rolls both back on notification failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paperdash-atomic-"));
    dirs.push(dir);
    const store = await createStore({ dataDir: dir });
    stores.push(store);
    const trade = normalizeTrade({ ...sourceTrade, seq: "19" }, "recent-api");
    expect(await store.recordTrade(trade)).toBe(true);
    expect(await store.recordTrade(trade)).toBe(false);
    expect(await store.events()).toHaveLength(1);
    expect(await store.trades()).toHaveLength(1);
    const fault = new DatabaseSync(join(dir, "paperdash.sqlite"));
    fault.exec("DROP TABLE stream_events");
    fault.close();
    const next = normalizeTrade({ ...sourceTrade, seq: "20" }, "recent-api");
    await expect(store.recordTrade(next)).rejects.toThrow();
    expect(await store.trades()).toEqual([trade]);
  });
  it("keeps observations idempotent across restarts and stores replay separately", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paperdash-test-"));
    dirs.push(dir);
    let store = await createStore({ dataDir: dir });
    const trade = normalizeTrade({ ...sourceTrade, seq: "18" }, "recent-api");
    expect(await store.trade(trade)).toBe(true);
    expect(await store.trade(trade)).toBe(false);
    await store.put("test", { raw });
    await store.event({ type: "trade", data: trade });
    await store.close();
    store = await createStore({ dataDir: dir });
    stores.push(store);
    expect((await store.get<{ raw: string }>("test"))?.value.raw).toBe(raw);
    expect(await store.trades()).toEqual([trade]);
    expect((await store.events("0"))[0].message).toEqual({
      type: "trade",
      data: trade,
    });
    const release = await store.lease();
    expect(release).not.toBeNull();
    expect(await store.lease()).toBeNull();
    await release!();
  });
  it("fails visibly at the local storage cap rather than deleting financial observations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paperdash-limit-"));
    dirs.push(dir);
    const first = await createStore({ dataDir: dir });
    const trade = normalizeTrade(sourceTrade, "public-stream");
    await first.trade(trade);
    await first.close();
    const capped = await createStore({ dataDir: dir, maxBytes: 1 });
    stores.push(capped);
    await expect(capped.put("another", { value: 1 })).rejects.toThrow(
      "No durable trade observations were deleted",
    );
    expect(await capped.trades()).toEqual([trade]);
  });
  it("bounds chart transmission while preserving endpoints and important extremes", () => {
    const points = Array.from({ length: 1440 }, (_, time) => ({
      time,
      value: time === 517 ? 100000 : time === 999 ? -5000 : time,
    }));
    const small = downsample(points);
    expect(small.length).toBeLessThanOrEqual(300);
    expect(small[0]).toEqual(points[0]);
    expect(small.at(-1)).toEqual(points.at(-1));
    expect(small.some((p) => p.time === 517)).toBe(true);
    expect(small.some((p) => p.time === 999)).toBe(true);
    expect(small.every((p, i) => !i || p.time > small[i - 1].time)).toBe(true);
  });
});

describe("HTTP contracts", () => {
  it("delivers deltas published during SSE bootstrap and never trusts a future client cursor", async () => {
    const store = await memory();
    await store.put("overview", {
      ...emptyOverview("local"),
      eventCursor: "0",
    });
    const bus = new ChangeBus();
    const hub = new EventHub(store, bus);
    class Response extends EventEmitter {
      writableLength = 0;
      destroyed = false;
      chunks: string[] = [];
      write(chunk: string) {
        this.chunks.push(chunk);
        return true;
      }
      end() {
        this.destroyed = true;
        this.emit("close");
      }
      destroy() {
        this.end();
      }
    }
    const response = new Response();
    const original = store.get.bind(store);
    let resume!: () => void;
    const pause = new Promise<void>((resolve) => {
      resume = resolve;
    });
    vi.spyOn(store, "get").mockImplementation(async (key) => {
      const value = await original(key);
      if (key === "overview") await pause;
      return value;
    });
    try {
      const joining = hub.add(
        response as unknown as ServerResponse,
        "999999999",
      );
      await vi.waitFor(() => expect(store.get).toHaveBeenCalled());
      const first = normalizeTrade({ ...sourceTrade, seq: "31" }, "recent-api");
      await store.recordTrade(first);
      bus.notify();
      resume();
      await joining;
      const data = () =>
        response.chunks.flatMap((chunk) =>
          chunk
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => JSON.parse(line.slice(6))),
        );
      expect(data()[0].type).toBe("overview");
      expect(
        data()
          .filter((m) => m.type === "trade")
          .map((m) => m.data.id),
      ).toEqual([first.id]);
      const second = normalizeTrade(
        { ...sourceTrade, seq: "32" },
        "recent-api",
      );
      await store.recordTrade(second);
      bus.notify();
      await vi.waitFor(() =>
        expect(
          data()
            .filter((m) => m.type === "trade")
            .map((m) => m.data.id),
        ).toEqual([first.id, second.id]),
      );
    } finally {
      resume();
      hub.close();
      bus.close();
    }
  });
  it("rejects invalid routes before upstream access and starts with honest unavailable data", async () => {
    const store = await memory();
    const upstream = new Upstream(store);
    const spy = vi.spyOn(upstream, "wallet");
    const app = await buildApi(store, upstream, undefined, { logger: false });
    try {
      expect((await app.inject("/api/wallets/not-an-address")).statusCode).toBe(
        400,
      );
      expect(spy).not.toHaveBeenCalled();
      expect((await app.inject("/api/accounts?page=-1")).statusCode).toBe(400);
      expect((await app.inject("/api/accounts?sort=evil")).statusCode).toBe(
        400,
      );
      expect((await app.inject("/api/overview")).json()).toMatchObject({
        summary: null,
        accountCount: null,
        status: { stale: true },
      });
      expect((await app.inject("/health/ready")).statusCode).toBe(503);
      const overview = emptyOverview("local");
      overview.summary = {
        ok: true,
        source: { block: "1", at: 1 },
        balances: { tvl: "1", margin: "0", lp: "0", reserve: "0", queue: "0" },
        activity: { volume: "0", open: 0 },
        fees: { pending: "0", lifetime: "0" },
        paper: { supply: "0", staked: "0" },
      };
      await store.put("overview", overview);
      expect((await app.inject("/health/ready")).json()).toMatchObject({
        ready: true,
        degraded: true,
      });
    } finally {
      await app.close();
    }
  });
  it("returns 429, rather than 500, when the local request limit is exceeded", async () => {
    const store = await memory();
    const app = await buildApi(store, undefined, undefined, { logger: false });
    try {
      let last;
      for (let i = 0; i < 121; i++) last = await app.inject("/api/overview");
      expect(last!.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
});
