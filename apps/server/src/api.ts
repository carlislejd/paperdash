import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import type {
  Cashflow,
  ClosedTrade,
} from "../../../packages/shared/src/types.js";
import { config, errorMessage } from "./config.js";
import { trustProxy } from "./proxy.js";
import { addressSchema, accountsQuerySchema, cursorSchema } from "./schemas.js";
import { readOverview } from "./collector.js";
import { type Store } from "./store.js";
import { ChangeBus } from "./bus.js";
import { Upstream, UpstreamError } from "./upstream.js";
import { readAssets } from "./assets.js";
import { analyticsResponse } from "./analytics-response.js";
import { HistoryCursorError } from "./history-store.js";
import { readPositionMetrics } from "./position-metrics.js";
import { readMarket } from "./market.js";
import { readHouse } from "./house.js";
import { readLiquidations } from "./liquidations.js";
import { EventHub, type StreamTopic } from "./event-hub.js";
import { PublicReadCache, ReadCapacityError } from "./public-read-cache.js";
import { applyEdgeCachePolicy } from "./edge-cache.js";
import { readProtocolCharts } from "./protocol-charts.js";
export { EventHub } from "./event-hub.js";

export async function buildApi(
  store: Store,
  upstream = new Upstream(store),
  bus = new ChangeBus(),
  options: {
    logger?: boolean;
    readCacheMs?: number;
    maxStreams?: number;
    rateLimit?: number;
  } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    trustProxy,
    bodyLimit: 16384,
    requestTimeout: 15000,
  });
  await app.register(cors, {
    origin: (origin, cb) =>
      cb(null, !origin || config.origins.includes(origin)),
    methods: ["GET"],
    credentials: false,
  });
  await app.register(rateLimit, {
    max: options.rateLimit ?? config.apiRateLimit,
    timeWindow: "1 minute",
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: "Too many requests. Please try again shortly.",
    }),
  });
  const hub = new EventHub(store, bus);
  const profileLimit = {
    config: {
      rateLimit: {
        max: options.rateLimit ?? config.apiProfileRateLimit,
        timeWindow: "1 minute",
      },
    },
  };
  const reads = new PublicReadCache({
    ttl: options.readCacheMs ?? config.apiReadCacheMs,
    maxEntries: 2048,
    maxBytes: 64 * 1024 * 1024,
    maxPending: 64,
  });
  const profileReads = new PublicReadCache({
    ttl: options.readCacheMs ?? config.apiReadCacheMs,
    maxEntries: 2048,
    maxBytes: 64 * 1024 * 1024,
    maxPending: 32,
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ReadCapacityError)
      return reply
        .header("Retry-After", "2")
        .code(503)
        .send({ error: error.message });
    if (error instanceof HistoryCursorError)
      return reply
        .code(400)
        .send({ error: "Invalid retained-history cursor." });
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: "Invalid request parameters.",
        details: error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      });
    if (error instanceof UpstreamError) {
      if (error.retryAt)
        reply.header(
          "Retry-After",
          Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1000)),
        );
      return reply
        .code(error.status === 429 ? 429 : error.status === 503 ? 503 : 502)
        .send({ error: error.message });
    }
    if (
      error &&
      typeof error === "object" &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    )
      return reply.code(error.statusCode).send({
        error:
          error.statusCode === 429
            ? "Too many requests. Please try again shortly."
            : "Invalid request.",
      });
    app.log.error(error, "API request failed");
    return reply
      .code(500)
      .send({ error: "The data service is temporarily unavailable." });
  });
  app.addHook("onSend", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    applyEdgeCachePolicy(req, reply, config.origins);
  });
  app.get(
    "/health/ready",
    { config: { rateLimit: false } },
    async (_req, reply) => {
      if (!(await reads.read("health", () => store.health())))
        return reply
          .code(503)
          .send({ ready: false, reason: "storage_unavailable" });
      const overview = await reads.read("overview", () => readOverview(store));
      if (!overview.summary)
        return reply.code(503).send({
          ready: false,
          reason: "waiting_for_first_observation",
          persistence: store.kind,
        });
      return {
        ready: true,
        degraded: overview.status.stale,
        status: overview.status,
      };
    },
  );
  app.get("/api/overview", async (req, reply) =>
    analyticsResponse(
      req,
      reply,
      await reads.read("overview", () => readOverview(store)),
    ),
  );
  app.get("/api/indexing", async (req, reply) =>
    analyticsResponse(
      req,
      reply,
      await reads.read("indexing", async () => {
        const [indexing, heartbeat] = await Promise.all([
          store.get("indexing-status"),
          store.get<{ at: number; errors: Record<string, string> }>(
            "collector-heartbeat",
          ),
        ]);
        return {
          indexing: indexing?.value ?? null,
          receivedAt: indexing?.receivedAt ?? null,
          collectorAt: heartbeat?.value.at ?? null,
          stale: !heartbeat || Date.now() - heartbeat.value.at > 30000,
          // The source does not promise a complete global execution archive.
          coverage: "available-source-history-and-retained-observations",
        };
      }),
    ),
  );
  app.get("/api/accounts", profileLimit, async (req, reply) => {
    const q = accountsQuerySchema.parse(req.query);
    return analyticsResponse(
      req,
      reply,
      await profileReads.read(
        `accounts:${q.sort}:${q.page}:${q.pageSize}:${q.q}`,
        () => upstream.accounts(q.q, q.sort, q.page, q.pageSize),
      ),
    );
  });
  app.get("/api/house", async (req, reply) =>
    analyticsResponse(
      req,
      reply,
      await reads.read("house", () => readHouse(store)),
    ),
  );
  app.get("/api/protocol/charts", async (req, reply) =>
    analyticsResponse(
      req,
      reply,
      await reads.read("protocol-charts", () => readProtocolCharts(store)),
    ),
  );
  app.get("/api/liquidations/stats", async (req, reply) =>
    analyticsResponse(
      req,
      reply,
      await reads.read("liquidation-stats", async () => {
        const {
          items: _items,
          nextCursor: _cursor,
          hourly: _hourly,
          ...summary
        } = await readLiquidations(store);
        return summary;
      }),
    ),
  );
  app.get("/api/liquidations", async (req, reply) => {
    const query = z
      .object({
        instrument: z.enum(["0", "1"]).transform(Number).optional(),
        cursor: z.string().min(1).max(1024).optional(),
      })
      .parse(req.query);
    const cache = query.cursor ? profileReads : reads;
    return analyticsResponse(
      req,
      reply,
      await cache.read(
        `liquidations:${query.instrument ?? "all"}:${query.cursor ?? ""}`,
        () => readLiquidations(store, query.instrument, query.cursor),
      ),
    );
  });
  app.get("/api/assets", async (req, reply) => {
    return analyticsResponse(
      req,
      reply,
      await reads.read("assets", () => readAssets(store)),
    );
  });
  app.get("/api/assets/:instrument/market", async (req, reply) => {
    const { instrument } = z
      .object({ instrument: z.enum(["0", "1"]).transform(Number) })
      .parse(req.params);
    const { window } = z
      .object({ window: z.enum(["5m", "15m", "1h"]).default("1h") })
      .parse(req.query);
    return analyticsResponse(
      req,
      reply,
      await reads.read(`market:${instrument}:${window}`, () =>
        readMarket(store, instrument, Date.now(), window),
      ),
    );
  });
  app.get("/api/position-metrics", async (req, reply) => {
    return analyticsResponse(
      req,
      reply,
      await reads.read("position-metrics", () => readPositionMetrics(store)),
    );
  });
  app.get(
    "/api/wallets/:address/position-metrics",
    profileLimit,
    async (req, reply) => {
      const { address } = z
        .object({ address: addressSchema })
        .parse(req.params);
      return analyticsResponse(
        req,
        reply,
        await profileReads.read(`position-metrics:${address}`, () =>
          readPositionMetrics(store, address),
        ),
      );
    },
  );
  app.get("/api/leaderboard", profileLimit, async (req, reply) => {
    const query = z
      .object({
        metric: z.enum(["pnl", "volume", "trades"]).default("pnl"),
        page: z.coerce.number().int().min(0).max(1000000).default(0),
        q: z
          .string()
          .max(42)
          .default("")
          .transform((value) => value.trim().toLowerCase()),
      })
      .refine(
        (value) =>
          value.metric === "pnl" || /^(?:0x)?[a-f0-9]{0,40}$/.test(value.q),
        {
          path: ["q"],
          message: "Observed activity search requires a wallet address prefix",
        },
      )
      .parse(req.query);
    return analyticsResponse(
      req,
      reply,
      await profileReads.read(
        `leaderboard:${query.metric}:${query.page}:${query.q}`,
        () => upstream.leaderboard(query.metric, query.page, query.q),
      ),
    );
  });
  app.get("/api/wallets/:address", profileLimit, async (req, reply) => {
    const { address } = z.object({ address: addressSchema }).parse(req.params);
    return analyticsResponse(
      req,
      reply,
      await profileReads.read(`wallet:${address}`, () =>
        upstream.wallet(address),
      ),
    );
  });
  for (const kind of ["cashflows", "trades"] as const) {
    app.get(
      `/api/wallets/:address/${kind}`,
      profileLimit,
      async (req, reply) => {
        const { address } = z
          .object({ address: addressSchema })
          .parse(req.params);
        const { cursor } = z
          .object({ cursor: cursorSchema.optional() })
          .parse(req.query);
        return analyticsResponse(
          req,
          reply,
          await profileReads.read(
            `history:${address}:${kind}:${cursor ?? ""}`,
            async () => {
              const result = await upstream.history<Cashflow | ClosedTrade>(
                address,
                kind,
                cursor,
              );
              return {
                ...result.value,
                receivedAt: result.receivedAt,
                stale: result.stale,
                ...(result.error ? { error: result.error } : {}),
              };
            },
          ),
        );
      },
    );
  }
  app.get(
    "/api/events",
    {
      config: {
        rateLimit: {
          max: options.rateLimit ?? config.sseConnectRateLimit,
          timeWindow: "1 minute",
        },
      },
    },
    async (req, reply) => {
      if (hub.size >= (options.maxStreams ?? config.maxStreams))
        return reply.header("Retry-After", "15").code(503).send({
          error: "Live stream capacity reached. Please reconnect shortly.",
        });
      const { topics } = z
        .object({ topics: z.string().max(80).optional() })
        .parse(req.query);
      const selected =
        topics === undefined
          ? undefined
          : (new Set(
              topics
                .split(",")
                .map((topic) =>
                  z
                    .enum([
                      "overview",
                      "trades",
                      "asset:0",
                      "asset:1",
                      "liquidations",
                    ])
                    .parse(topic),
                ),
            ) as Set<StreamTopic>);
      const rawId = req.headers["last-event-id"];
      const id =
        typeof rawId === "string" && /^\d{1,18}$/.test(rawId)
          ? rawId
          : undefined;
      // CORS headers were set by the plugin; writeHead retains them.
      reply.hijack();
      const headers = reply.getHeaders();
      for (const [name, value] of Object.entries(headers))
        if (value !== undefined) reply.raw.setHeader(name, value);
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "CDN-Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      reply.raw.write(": connected\nretry: 3000\n\n");
      await hub.add(reply.raw, id, selected);
    },
  );
  app.addHook("onClose", async () => {
    hub.close();
    reads.clear();
    profileReads.clear();
  });
  app.addHook("preClose", async () => {
    hub.close();
    reads.clear();
    profileReads.clear();
  });
  return app;
}
