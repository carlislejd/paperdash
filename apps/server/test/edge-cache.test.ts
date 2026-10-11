import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { gunzipSync } from "node:zlib";
import { buildApi } from "../src/api.js";
import { EventHub } from "../src/event-hub.js";
import { createStore, type Store } from "../src/store.js";
import { emptyOverview } from "../src/collector.js";
import { Upstream } from "../src/upstream.js";
import { config } from "../src/config.js";
import { refreshLiquidations } from "../src/liquidations.js";

const edge = "public, s-maxage=1, must-revalidate";
const address = `0x${"1".repeat(40)}`;
const allowedOrigin = config.origins[0]!;
let store: Store;
let upstream: Upstream;
const apps: FastifyInstance[] = [];
beforeEach(async () => {
  store = await createStore({ memory: true, databaseUrl: "" });
  await store.put("overview", {
    ...emptyOverview("local"),
    history: Array.from({ length: 100 }, (_, i) => ({
      time: i,
      tvlRaw: String(i),
    })),
  });
  upstream = new Upstream(store);
  vi.spyOn(upstream, "request").mockRejectedValue(
    new Error("Unexpected source request"),
  );
  vi.spyOn(upstream, "wallet").mockResolvedValue({
    address,
    snapshot: null,
    cashflows: { items: [], nextCursor: null },
    trades: { items: [], nextCursor: null },
    portfolio: null,
    receivedAt: Date.now(),
    stale: true,
    errors: ["Waiting for retained data"],
  });
  vi.spyOn(upstream, "accounts").mockResolvedValue({
    ok: true,
    accounts: [],
    count: 0,
    summary: {
      uniqueAccounts: 0,
      trackedBalance: "0",
      trackedQueued: "0",
      trackedOpenNotional: "0",
      trackedPaper: "0",
    },
    pageInfo: { page: 0, totalPages: 1 },
    receivedAt: Date.now(),
    stale: false,
  });
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  await upstream.close();
  await store.close();
  vi.restoreAllMocks();
});
async function app(options: { rateLimit?: number; readCacheMs?: number } = {}) {
  const result = await buildApi(store, upstream, undefined, {
    logger: false,
    ...options,
  });
  apps.push(result);
  return result;
}

describe("explicit native edge-cache policy", () => {
  it("keeps hourly liquidation data on the chart endpoint and out of the compact overview stats response", async () => {
    await refreshLiquidations(store);
    const api = await app();
    const full = (await api.inject("/api/liquidations")).json();
    const stats = (await api.inject("/api/liquidations/stats")).json();
    expect(full.hourly.buckets).toHaveLength(25);
    expect(stats).not.toHaveProperty("hourly");
    expect(stats).not.toHaveProperty("items");
    expect(stats).not.toHaveProperty("nextCursor");
    expect(stats.stats).toEqual(full.stats);
  });
  it.each([
    "/api/overview",
    "/api/assets",
    "/api/assets/0/market",
    "/api/assets/1/market",
    ...[0, 1].flatMap((instrument) =>
      ["5m", "15m", "1h"].map(
        (window) => `/api/assets/${instrument}/market?window=${window}`,
      ),
    ),
    "/api/house",
    "/api/protocol/charts",
    "/api/paper/economics",
    "/api/position-metrics",
    "/api/liquidations/stats",
  ])(
    "opts in only the exact public snapshot %s, preserving ETag and CORS",
    async (url) => {
      const api = await app();
      const first = await api.inject({
        url,
        headers: { origin: allowedOrigin },
      });
      expect(first.statusCode).toBe(200);
      expect(first.headers["cdn-cache-control"]).toBe(edge);
      expect(first.headers["cache-control"]).toBe("no-cache");
      expect(first.headers["access-control-allow-origin"]).toBe(allowedOrigin);
      expect(first.headers.vary).toBe("Accept-Encoding, Origin");
      expect(first.headers.etag).toBeTruthy();
      const conditional = await api.inject({
        url,
        method: "HEAD",
        headers: {
          origin: allowedOrigin,
          "if-none-match": String(first.headers.etag),
        },
      });
      expect(conditional.statusCode).toBe(304);
      expect(conditional.payload).toBe("");
      expect(conditional.headers["cdn-cache-control"]).toBe(edge);
      expect(conditional.headers.etag).toBe(first.headers.etag);
      expect(upstream.request).not.toHaveBeenCalled();
    },
  );

  it("preserves separate gzip/identity representations and browser revalidation", async () => {
    const api = await app();
    const plain = await api.inject("/api/overview");
    const gzip = await api.inject({
      url: "/api/overview",
      headers: { "accept-encoding": "gzip" },
    });
    expect(gzip.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(gzip.rawPayload).toString()).toBe(plain.payload);
    expect(gzip.headers.etag).not.toBe(plain.headers.etag);
    for (const response of [plain, gzip]) {
      expect(response.headers["cdn-cache-control"]).toBe(edge);
      expect(response.headers["cache-control"]).toBe("no-cache");
      expect(response.headers.vary).toBe("Accept-Encoding, Origin");
    }
    const next = await api.inject({
      url: "/api/overview",
      headers: {
        "accept-encoding": "gzip",
        "if-none-match": String(gzip.headers.etag),
      },
    });
    expect(next.statusCode).toBe(304);
    expect(next.headers["cdn-cache-control"]).toBe(edge);
    expect(next.payload).toBe("");
  });

  it("excludes unrecognized query variants, accounts, wallets and paginated history", async () => {
    const api = await app();
    for (const url of [
      "/api/overview?ignored=1",
      "/api/assets/0/market?range=1h",
      "/api/assets/0/market?window=1h&ignored=1",
      "/api/assets/0/market?window=5m&window=1h",
      "/api/assets/0/market?window=6h",
      "/api/assets/0/market?window=%35m",
      "/api/%6fverview",
      "/api/house?x=1",
      "/api/protocol/charts?range=1d",
      "/api/paper/economics?range=1d",
      "/api/liquidations/stats?instrument=0",
      "/api/accounts",
      "/api/accounts?q=0x1&page=0",
      `/api/wallets/${address}`,
      `/api/wallets/${address}/position-metrics`,
      `/api/wallets/${address}/cashflows`,
      `/api/wallets/${address}/trades`,
      "/api/indexing",
      "/api/liquidations",
      "/api/liquidations?cursor=invalid",
    ]) {
      const response = await api.inject(url);
      expect(response.statusCode, url).toBeLessThan(500);
      expect(response.headers["cdn-cache-control"], url).toBe("no-store");
    }
    expect(upstream.request).not.toHaveBeenCalled();
  });

  it("does not cache denied origins or any credential-bearing request/response", async () => {
    const api = await app();
    api.addHook("preHandler", async (request, reply) => {
      if (request.headers["x-test-cookie"])
        reply.header("Set-Cookie", "test=1; Secure; HttpOnly");
    });
    const denied = await api.inject({
      url: "/api/overview",
      headers: { origin: "https://untrusted.invalid" },
    });
    expect(denied.statusCode).toBe(200);
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    expect(denied.headers["cdn-cache-control"]).toBe("no-store");
    for (const headers of [
      { authorization: "Bearer synthetic" },
      { authorization: "" },
      { cookie: "session=synthetic" },
      { cookie: "" },
      { "x-test-cookie": "yes" },
    ]) {
      for (const url of ["/api/overview", "/api/assets/0/market?window=15m"]) {
        const response = await api.inject({ url, headers });
        expect(response.statusCode).toBe(200);
        expect(response.headers["cdn-cache-control"]).toBe("no-store");
        expect(response.headers["cache-control"]).toBe("no-store");
      }
    }
  });

  it("defaults health, errors, unknown paths, OPTIONS and unsafe methods to no-store", async () => {
    const api = await app();
    for (const request of [
      { url: "/health/ready" },
      { url: "/missing.png" },
      { url: "/api/overview/" },
      { url: "/api/assets/2/market" },
      { url: "/api/assets/01/market" },
      { url: "/api/overview", method: "POST" as const },
      {
        url: "/api/overview",
        method: "OPTIONS" as const,
        headers: {
          origin: allowedOrigin,
          "access-control-request-method": "GET",
        },
      },
    ]) {
      const response = await api.inject(request);
      expect(
        response.headers["cdn-cache-control"],
        JSON.stringify(request),
      ).toBe("no-store");
      expect(response.headers["cache-control"], JSON.stringify(request)).toBe(
        "no-store",
      );
    }
    const failed = await app({ readCacheMs: 0 });
    vi.spyOn(store, "get").mockRejectedValue(new Error("storage unavailable"));
    const error = await failed.inject("/api/overview");
    expect(error.statusCode).toBe(500);
    expect(error.headers["cdn-cache-control"]).toBe("no-store");
    expect(error.headers["cache-control"]).toBe("no-store");
  });

  it("never gives 206, redirects, throttles or unavailable responses the success policy", async () => {
    const api = await app();
    api.addHook("preHandler", async (request, reply) => {
      if (request.headers["x-test-status"])
        return reply
          .code(Number(request.headers["x-test-status"]))
          .send({ error: "synthetic" });
    });
    for (const status of [206, 301, 302, 400, 429, 503]) {
      const response = await api.inject({
        url: "/api/overview",
        headers: { "x-test-status": String(status) },
      });
      expect(response.statusCode).toBe(status);
      expect(response.headers["cdn-cache-control"]).toBe("no-store");
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    const limited = await app({ rateLimit: 1 });
    expect((await limited.inject("/api/overview")).statusCode).toBe(200);
    const throttled = await limited.inject("/api/overview");
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers["cdn-cache-control"]).toBe("no-store");
    expect(throttled.headers["cache-control"]).toBe("no-store");
  });

  it("sets both no-store policies on the hijacked SSE response", async () => {
    vi.spyOn(EventHub.prototype, "add").mockImplementation(async (response) => {
      response.end();
    });
    const api = await app();
    const response = await api.inject({
      url: "/api/events?topics=overview",
      headers: { origin: allowedOrigin },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.headers["cache-control"]).toBe("no-store, no-transform");
    expect(response.headers["cdn-cache-control"]).toBe("no-store");
    expect(response.headers["access-control-allow-origin"]).toBe(allowedOrigin);
  });
});
