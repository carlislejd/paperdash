import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import type { ServerResponse } from "node:http";
import type {
  Cashflow,
  ClosedTrade,
} from "../../../packages/shared/src/types.js";
import { config, errorMessage } from "./config.js";
import { addressSchema, accountsQuerySchema, cursorSchema } from "./schemas.js";
import { readOverview, readOverviewSnapshot } from "./collector.js";
import { type Store, type StreamRecord } from "./store.js";
import { ChangeBus } from "./bus.js";
import { Upstream, UpstreamError } from "./upstream.js";
import { HistoryCursorError } from "./history-store.js";

interface Client {
  response: ServerResponse;
  lastId: string;
  ready: boolean;
}
export class EventHub {
  private clients = new Set<Client>();
  private cursor = "0";
  private busy = false;
  private again = false;
  private timer: ReturnType<typeof setInterval>;
  private unsubscribe: () => void;
  constructor(
    private store: Store,
    bus: ChangeBus,
  ) {
    this.timer = setInterval(() => {
      void this.pump();
    }, 1000);
    this.timer.unref();
    this.unsubscribe = bus.subscribe(() => {
      void this.pump();
    });
  }
  get size() {
    return this.clients.size;
  }
  private send(client: Client, record: StreamRecord, bootstrap = false) {
    if (
      (!client.ready && !bootstrap) ||
      BigInt(record.id) <= BigInt(client.lastId)
    )
      return;
    if (client.response.destroyed) {
      this.clients.delete(client);
      return;
    }
    // Bound slow browsers; reconnect gets a snapshot/replay instead of unbounded RAM.
    if (client.response.writableLength > 256 * 1024) {
      client.response.destroy();
      this.clients.delete(client);
      return;
    }
    client.lastId = record.id;
    client.response.write(
      `id: ${record.id}\ndata: ${JSON.stringify(record.message)}\n\n`,
    );
  }
  async add(response: ServerResponse, lastId?: string) {
    const client: Client = { response, lastId: lastId ?? "0", ready: false };
    this.clients.add(client);
    const heartbeat = setInterval(() => {
      if (!response.destroyed) response.write(": heartbeat\n\n");
    }, 15000);
    response.on("close", () => {
      clearInterval(heartbeat);
      this.clients.delete(client);
    });
    try {
      // A full snapshot supersedes older client state, including Last-Event-ID.
      // Its own watermark is the safe place to resume durable deltas.
      await this.resync(client);
    } catch (error) {
      response.write(
        `data: ${JSON.stringify({ type: "status", data: { receivedAt: null, sourceAt: null, indexedBlock: null, stale: true, persistence: this.store.kind, stream: "disconnected", message: "Live updates are temporarily unavailable. Reconnecting." } })}\n\n`,
      );
      response.end();
    }
  }
  private async resync(client: Client) {
    client.ready = false;
    const { overview, cursor } = await readOverviewSnapshot(this.store);
    const bounds = await this.store.eventBounds();
    const gap =
      bounds.oldest !== null && BigInt(cursor) < BigInt(bounds.oldest) - 1n;
    client.lastId = gap ? String(BigInt(bounds.oldest!) - 1n) : cursor;
    if (gap)
      overview.status = {
        ...overview.status,
        message: [
          overview.status.message,
          "Live notification replay expired; resuming from the saved snapshot.",
        ]
          .filter(Boolean)
          .join(" "),
      };
    client.response.write(
      `id: ${client.lastId}\ndata: ${JSON.stringify({ type: "overview", data: overview })}\n\n`,
    );
    for (let pass = 0; pass < 20; pass++) {
      const records = await this.store.events(client.lastId);
      for (const record of records) this.send(client, record, true);
      // Stay out of fanout until caught up to everything it already scanned.
      if (
        records.length < 1000 &&
        BigInt(client.lastId) >= BigInt(this.cursor)
      ) {
        client.ready = true;
        return;
      }
    }
    client.response.end();
  }
  private async pump() {
    if (!this.clients.size) return;
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    try {
      const bounds = await this.store.eventBounds();
      if (bounds.oldest && BigInt(this.cursor) < BigInt(bounds.oldest) - 1n) {
        this.cursor = bounds.latest!;
        await Promise.all(
          [...this.clients]
            .filter((client) => client.ready)
            .map((client) => this.resync(client)),
        );
      } else {
        for (const record of await this.store.events(this.cursor)) {
          for (const client of this.clients) this.send(client, record);
          this.cursor = record.id;
        }
      }
    } catch {
      /* Cached REST remains available; next tick retries the durable notification log. */
    } finally {
      this.busy = false;
      if (this.again) {
        this.again = false;
        void this.pump();
      }
    }
  }
  close() {
    clearInterval(this.timer);
    this.unsubscribe();
    for (const c of this.clients) c.response.end();
    this.clients.clear();
  }
}

export async function buildApi(
  store: Store,
  upstream = new Upstream(store),
  bus = new ChangeBus(),
  options: { logger?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    trustProxy: (_address: string, hop: number) => hop < 1,
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
    max: 120,
    timeWindow: "1 minute",
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: "Too many requests. Please try again shortly.",
    }),
  });
  const hub = new EventHub(store, bus);
  app.setErrorHandler((error, _request, reply) => {
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
  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  });
  app.get(
    "/health/ready",
    { config: { rateLimit: false } },
    async (_req, reply) => {
      if (!(await store.health()))
        return reply
          .code(503)
          .send({ ready: false, reason: "storage_unavailable" });
      const overview = await readOverview(store);
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
  app.get("/api/overview", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return readOverview(store);
  });
  app.get("/api/indexing", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
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
  });
  app.get("/api/accounts", async (req, reply) => {
    const q = accountsQuerySchema.parse(req.query);
    reply.header("Cache-Control", "no-store");
    return upstream.accounts(q.q, q.sort, q.page);
  });
  app.get("/api/wallets/:address", async (req, reply) => {
    const { address } = z.object({ address: addressSchema }).parse(req.params);
    reply.header("Cache-Control", "no-store");
    return upstream.wallet(address);
  });
  for (const kind of ["cashflows", "trades"] as const) {
    app.get(`/api/wallets/:address/${kind}`, async (req, reply) => {
      const { address } = z
        .object({ address: addressSchema })
        .parse(req.params);
      const { cursor } = z
        .object({ cursor: cursorSchema.optional() })
        .parse(req.query);
      const result = await upstream.history<Cashflow | ClosedTrade>(
        address,
        kind,
        cursor,
      );
      reply.header("Cache-Control", "no-store");
      return {
        ...result.value,
        receivedAt: result.receivedAt,
        stale: result.stale,
        ...(result.error ? { error: result.error } : {}),
      };
    });
  }
  app.get(
    "/api/events",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      if (hub.size >= 500)
        return reply.code(503).send({
          error: "Live stream capacity reached. Please reconnect shortly.",
        });
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
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      reply.raw.write(": connected\nretry: 3000\n\n");
      await hub.add(reply.raw, id);
    },
  );
  app.addHook("onClose", async () => {
    hub.close();
  });
  app.addHook("preClose", async () => {
    hub.close();
  });
  return app;
}
