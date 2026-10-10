/** LOCALHOST ONLY. No collector, provider requests, or remote target option.
 * node --import tsx scripts/load/local-rest-capacity.ts --clients=10000 --seconds=20 --rest-rps=500
 * Synthetic viewer IPs are sent only over loopback. This is an in-memory,
 * single-host shared-cache/socket test, not Render/PostgreSQL capacity proof.
 */
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import http from "node:http";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const options = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((x) => x.startsWith("--"))
    .map((x) => x.slice(2).split("=")),
);
function numberOption(
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const value = Number(options[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`--${name} must be an integer ${min}–${max}`);
  return value;
}
const clients = numberOption("clients", 10000, 1, 10000);
const seconds = numberOption("seconds", 20, 5, 60);
const restRps = numberOption("rest-rps", 500, 1, 5000);
const maxInflight = numberOption("max-inflight", 256, 16, 512);
const routeSlots = [
  "/api/house",
  "/api/house",
  "/api/position-metrics",
  "/api/position-metrics",
  "/api/liquidations/stats",
  "/api/liquidations/stats",
  "/api/assets",
  "/api/assets",
  "/api/assets",
  "/api/assets/0/market",
  "/api/assets/0/market",
  "/api/assets/1/market",
  "/api/assets/1/market",
  "/api/liquidations",
  "/api/overview",
  "/api/accounts?page=0&pageSize=10",
];
const paths = [...new Set(routeSlots)];
const sourceHashes = Object.fromEntries(
  ["local-rest-capacity.ts", "cache-fixtures.ts"].map((file) => [
    file,
    createHash("sha256")
      .update(readFileSync(new URL(file, import.meta.url)))
      .digest("hex"),
  ]),
);

if (process.argv.includes("server")) {
  const [{ createStore }, { buildApi }, { ChangeBus }, { cacheFixtures }] =
    await Promise.all([
      import("../../apps/server/src/store.js"),
      import("../../apps/server/src/api.js"),
      import("../../apps/server/src/bus.js"),
      import("./cache-fixtures.js"),
    ]);
  // Fail visibly if future harness changes accidentally attempt provider I/O.
  globalThis.fetch = async () => {
    throw new Error("External fetch forbidden in local capacity harness");
  };
  const store = await createStore({ memory: true, databaseUrl: "" });
  const bus = new ChangeBus();
  const fixtures = await cacheFixtures(store);
  let reads = 0,
    tails = 0;
  const get = store.get.bind(store),
    events = store.events.bind(store);
  store.get = async (key) => {
    reads++;
    return get(key);
  };
  store.events = async (...args) => {
    tails++;
    return events(...args);
  };
  const app = await buildApi(store, fixtures.upstream as never, bus, {
    logger: false,
    maxStreams: 12000,
  });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  let sequence = 1000,
    stopping = false,
    updating = false;
  const publications = new Set<Promise<unknown>>();
  const track = (promise: Promise<unknown>) => {
    const work = promise
      .catch((error) => process.send?.({ fatal: String(error) }))
      .finally(() => publications.delete(work));
    publications.add(work);
  };
  const tradeTimer = setInterval(
    () =>
      track(
        store
          .event({
            type: "trade",
            data: { ...fixtures.trade(sequence++), ts: Date.now() },
          })
          .then(() => bus.notify()),
      ),
    180,
  );
  const priceTimer = setInterval(() => {
    for (const instrument of [0, 1])
      track(
        store
          .event({
            type: "asset-price",
            data: {
              instrument,
              point: {
                time: Date.now(),
                priceUsd: (instrument ? 2537 : 83871) + Math.sin(sequence),
              },
              receivedAt: Date.now(),
            },
          })
          .then(() => bus.notify()),
      );
  }, 1000);
  const updateTimer = setInterval(() => {
    if (updating) return;
    updating = true;
    track(
      fixtures
        .update()
        .then((overview) =>
          store.event({
            type: "metrics",
            data: {
              summary: overview.summary,
              accountCount: overview.accountCount,
              status: overview.status,
            },
          }),
        )
        .then(() => bus.notify())
        .finally(() => {
          updating = false;
        }),
    );
  }, 5000);
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  let started = performance.now(),
    cpu = process.cpuUsage(),
    intervalCpu = cpu,
    intervalAt = started;
  let peakRss = process.memoryUsage().rss,
    worstP99 = 0,
    worstLoop = 0;
  const telemetry = () => {
    const now = performance.now(),
      used = process.cpuUsage(intervalCpu);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    worstP99 = Math.max(worstP99, loop.percentile(99) / 1e6);
    worstLoop = Math.max(worstLoop, loop.max / 1e6);
    const value = {
      rssMiB: process.memoryUsage().rss / 1048576,
      eventLoopP99Ms: loop.percentile(99) / 1e6,
      eventLoopMaxMs: loop.max / 1e6,
      cpuCorePercent: (used.user + used.system) / (now - intervalAt) / 10,
    };
    intervalCpu = process.cpuUsage();
    intervalAt = now;
    loop.reset();
    process.send?.({ telemetry: value });
  };
  const telemetryTimer = setInterval(telemetry, 1000);
  process.send?.({ ready: url });
  process.on("message", (message) => {
    if (message === "measure") {
      started = performance.now();
      cpu = intervalCpu = process.cpuUsage();
      intervalAt = started;
      reads = tails = 0;
      fixtures.reset();
      loop.reset();
      worstP99 = worstLoop = 0;
      return;
    }
    if (message !== "stop" || stopping) return;
    stopping = true;
    void (async () => {
      clearInterval(tradeTimer);
      clearInterval(priceTimer);
      clearInterval(updateTimer);
      clearInterval(telemetryTimer);
      await Promise.all(publications);
      telemetry();
      const used = process.cpuUsage(cpu),
        elapsed = performance.now() - started;
      process.send?.({
        server: {
          elapsedMs: elapsed,
          peakRssMiB: peakRss / 1048576,
          finalRssMiB: process.memoryUsage().rss / 1048576,
          eventLoopWorstP99Ms: worstP99,
          eventLoopMaxMs: worstLoop,
          cpuCorePercent: (used.user + used.system) / elapsed / 10,
          readCalls: reads,
          tailReads: tails,
          ...fixtures.counters(),
        },
      });
      loop.disable();
      await app.close();
      bus.close();
      await store.close();
      process.disconnect?.();
    })();
  });
} else {
  const server = fork(fileURLToPath(import.meta.url), ["server"], {
    execArgv: ["--import", "tsx"],
    env: {
      ...process.env,
      DATABASE_URL: "",
      REDIS_URL: "",
      EMBEDDED_COLLECTOR: "false",
    },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const sockets: http.ClientRequest[] = [],
    active = new Set<http.ClientRequest>();
  const restAgent = new http.Agent({
    keepAlive: true,
    maxSockets: maxInflight,
  });
  let report: unknown,
    abortReason: string | null = null,
    finishing = false,
    measuring = false,
    pressure = 0;
  let connected = 0,
    streamFailures = 0,
    sequenceErrors = 0,
    streamBytes = 0,
    streamMessages = 0;
  const streamFailureReasons: Record<string, number> = {};
  const streamFailure = (reason: string) => {
    streamFailures++;
    streamFailureReasons[reason] = (streamFailureReasons[reason] ?? 0) + 1;
  };
  let peakGeneratorRss = process.memoryUsage().rss;
  const stop = (reason: string) => {
    abortReason ??= reason;
  };
  const deadline = setTimeout(() => {
    stop("Harness overall deadline exceeded");
    for (const request of active) request.destroy();
    for (const socket of sockets) socket.destroy();
    server.kill("SIGTERM");
  }, 150000);
  server.on("message", (message: any) => {
    if (message.server) report = message.server;
    if (message.fatal) stop(`Fixture publisher failed: ${message.fatal}`);
    if (message.telemetry && measuring) {
      const t = message.telemetry;
      pressure = t.eventLoopP99Ms > 500 ? pressure + 1 : 0;
      if (t.rssMiB > 1536 || pressure >= 3)
        stop("API memory/event-loop pressure threshold exceeded");
    }
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Local API startup timed out")),
      15000,
    );
    server.once("error", reject);
    server.once("exit", (code) =>
      reject(new Error(`Local API exited before readiness: ${code}`)),
    );
    server.on("message", (message: any) => {
      if (message.ready) {
        clearTimeout(timeout);
        resolve(message.ready);
      }
    });
  });
  const target = new URL(url);
  if (target.hostname !== "127.0.0.1" || target.protocol !== "http:")
    throw new Error("Refusing non-local load target");
  const bootstrapMs: number[] = [],
    restMs: number[] = [],
    sseMs: number[] = [];
  const wire: Record<
    string,
    {
      offered: number;
      started: number;
      completed: number;
      dropped: number;
      errors: number;
      statuses: Record<string, number>;
      bodyBytes: number;
      headerBytes: number;
      requestHeaderBytes: number;
      gzip: number;
      revalidated: number;
      latency: number[];
    }
  > = Object.fromEntries(
    paths.map((path) => [
      path,
      {
        offered: 0,
        started: 0,
        completed: 0,
        dropped: 0,
        errors: 0,
        statuses: {},
        bodyBytes: 0,
        headerBytes: 0,
        requestHeaderBytes: 0,
        gzip: 0,
        revalidated: 0,
        latency: [],
      },
    ]),
  );
  const seedEtags = new Map<string, string>(),
    etags = new Map<string, string>();
  const viewerIp = (i: number) =>
    `10.31.${Math.floor(i / 250)}.${(i % 250) + 1}`;
  const topic = (i: number) =>
    i % 10 < 4
      ? "overview,trades"
      : i % 10 < 7
        ? `overview,asset:${i % 2}`
        : i % 10 === 7
          ? "overview,liquidations"
          : "overview";
  const connect = (i: number) =>
    new Promise<void>((resolve) => {
      const start = performance.now();
      let settled = false,
        bootstrapped = false,
        buffer = "",
        last = -1n;
      const done = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve();
        }
      };
      const request = http.get(
        `${url}/api/events?topics=${encodeURIComponent(topic(i))}`,
        { agent: false, headers: { "x-forwarded-for": viewerIp(i) } },
        (response) => {
          if (response.statusCode !== 200) {
            streamFailure(`HTTP${response.statusCode}`);
            response.resume();
            done();
            return;
          }
          response.on("data", (chunk: Buffer) => {
            streamBytes += chunk.length;
            buffer += chunk.toString();
            if (buffer.length > 1024 * 1024) {
              stop("SSE frame exceeds bounded client buffer");
              request.destroy();
              done();
              return;
            }
            let boundary: number;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const id = /^id: (\d+)$/m.exec(frame)?.[1];
              if (id) {
                const next = BigInt(id);
                if (next <= last) {
                  sequenceErrors++;
                  stop("Duplicate/regressing SSE ID");
                }
                last = next;
              }
              const data = /^data: (.+)$/m.exec(frame)?.[1];
              if (!data) continue;
              streamMessages++;
              if (!bootstrapped) {
                bootstrapped = true;
                connected++;
                bootstrapMs.push(performance.now() - start);
                done();
              }
              if (measuring && i < 64) {
                const event = JSON.parse(data),
                  time =
                    event.type === "trade"
                      ? event.data.ts
                      : event.type === "asset-price"
                        ? event.data.receivedAt
                        : null;
                if (time && sseMs.length < 100000)
                  sseMs.push(Date.now() - time);
              }
            }
          });
          response.on("error", (error: NodeJS.ErrnoException) => {
            if (!finishing)
              streamFailure(`response:${error.code ?? error.message}`);
            done();
          });
          response.on("end", () => {
            if (!finishing) streamFailure("unexpected-end");
            done();
          });
        },
      );
      const timeout = setTimeout(() => {
        streamFailure("bootstrap-timeout");
        request.destroy();
        done();
      }, 10000);
      request.on("error", (error: NodeJS.ErrnoException) => {
        if (!finishing) streamFailure(`request:${error.code ?? error.message}`);
        done();
      });
      sockets.push(request);
    });
  let offered = 0,
    startedRequests = 0,
    completed = 0,
    dropped = 0,
    requestErrors = 0,
    httpFailures = 0,
    peakInflight = 0,
    schedulerDrops = 0;
  const request = (path: string, viewer: number) => {
    const stats = wire[path],
      key = `${viewer}:${path}`,
      etag = etags.get(key) ?? seedEtags.get(path);
    const at = performance.now();
    let done = false;
    const headers = {
      "accept-encoding": "gzip",
      "x-forwarded-for": viewerIp(viewer),
      ...(etag ? { "if-none-match": etag } : {}),
    };
    const req = http.get(
      `${url}${path}`,
      { agent: restAgent, headers },
      (response) => {
        const status = String(response.statusCode);
        stats.statuses[status] = (stats.statuses[status] ?? 0) + 1;
        if (response.statusCode !== 200 && response.statusCode !== 304)
          httpFailures++;
        stats.headerBytes += Buffer.byteLength(
          `HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\n${response.rawHeaders.reduce((s, v, i) => s + v + (i % 2 ? "\r\n" : ": "), "")}\r\n`,
        );
        if (response.headers["content-encoding"] === "gzip") stats.gzip++;
        if (response.statusCode === 304) stats.revalidated++;
        if (typeof response.headers.etag === "string")
          etags.set(key, response.headers.etag);
        let body = 0;
        response.on("data", (chunk: Buffer) => {
          stats.bodyBytes += chunk.length;
          body += chunk.length;
          if (body > 2 * 1024 * 1024)
            req.destroy(new Error("REST body bound exceeded"));
        });
        response.on("end", () => finish(false));
        response.on("error", () => finish(true));
      },
    );
    const timeout = setTimeout(
      () => req.destroy(new Error("REST deadline exceeded")),
      4000,
    );
    function finish(failed: boolean) {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      active.delete(req);
      if (failed) {
        stats.errors++;
        requestErrors++;
      } else {
        stats.completed++;
        completed++;
        const elapsed = performance.now() - at;
        restMs.push(elapsed);
        stats.latency.push(elapsed);
      }
    }
    req.on("error", () => finish(true));
    // Count actual serialized HTTP request headers, including conditional ETags.
    req.once("finish", () => {
      stats.requestHeaderBytes += Buffer.byteLength(
        (req as unknown as { _header?: string })._header ?? "",
      );
    });
    active.add(req);
    stats.started++;
    startedRequests++;
    peakInflight = Math.max(peakInflight, active.size);
  };
  let warmupBytes = 0;
  try {
    for (const path of paths) {
      const response = await fetch(`${url}${path}`, {
        headers: { "accept-encoding": "gzip" },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok)
        throw new Error(`Fixture warmup failed ${path}: ${response.status}`);
      const body = (await response.json()) as any;
      if (
        (path === "/api/house" && body.history?.length !== 300) ||
        (path === "/api/assets" && body.assets?.[0]?.history?.length !== 300) ||
        (path.endsWith("/market") &&
          (body.points?.length !== 720 || body.trades?.length !== 200)) ||
        (path === "/api/liquidations" && body.items?.length !== 50)
      )
        throw new Error(`Fixture payload is incomplete: ${path}`);
      warmupBytes += Number(response.headers.get("content-length") ?? 0);
      const etag = response.headers.get("etag");
      if (etag) seedEtags.set(path, etag);
    }
    const connectAt = performance.now();
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(32, clients) }, async () => {
        while (next < clients && !abortReason) {
          await connect(next++);
          if (streamFailures > Math.max(5, clients * 0.01))
            stop("Too many SSE connection failures");
        }
      }),
    );
    const connectElapsed = performance.now() - connectAt;
    if (connected !== clients)
      stop(`Only ${connected}/${clients} streams bootstrapped`);
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    const cpu = process.cpuUsage(),
      steadyStart = performance.now(),
      bytesBefore = streamBytes,
      messagesBefore = streamMessages;
    measuring = true;
    server.send("measure");
    const end = steadyStart + seconds * 1000;
    while (performance.now() < end && !abortReason) {
      const elapsed = performance.now() - steadyStart;
      const due =
        Math.floor((Math.min(elapsed, seconds * 1000) * restRps) / 1000) -
        offered;
      // Do not turn generator stalls into an unbounded catch-up queue.
      const launchBudget = Math.min(due, 1000);
      for (let i = 0; i < launchBudget; i++) {
        const index = offered++,
          panel = Math.floor(index / clients) % 3;
        const path = routeSlots[(index + panel * 5) % routeSlots.length],
          stats = wire[path];
        stats.offered++;
        if (active.size >= maxInflight) {
          dropped++;
          stats.dropped++;
          continue;
        }
        request(path, index % clients);
      }
      if (due > launchBudget) {
        schedulerDrops += due - launchBudget;
        dropped += due - launchBudget;
        offered += due - launchBudget;
      }
      peakGeneratorRss = Math.max(peakGeneratorRss, process.memoryUsage().rss);
      if (
        elapsed > 5000 &&
        (dropped / Math.max(1, offered) > 0.05 ||
          (requestErrors + httpFailures) / Math.max(1, startedRequests) > 0.01)
      )
        stop("REST dropped/error pressure threshold exceeded");
      if (peakGeneratorRss > 1536 * 1048576)
        stop("Generator memory threshold exceeded");
      await delay(5);
    }
    const offeredWindowMs = performance.now() - steadyStart;
    const drainUntil = performance.now() + 5000;
    while (active.size && performance.now() < drainUntil) await delay(10);
    for (const req of active) req.destroy();
    finishing = true;
    measuring = false;
    const steadyStreamBytes = streamBytes - bytesBefore,
      steadyStreamMessages = streamMessages - messagesBefore;
    for (const socket of sockets) socket.destroy();
    restAgent.destroy();
    server.send("stop");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        server.kill("SIGTERM");
        stop("API shutdown deadline exceeded");
        resolve();
      }, 10000);
      server.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    const used = process.cpuUsage(cpu);
    const percentile = (values: number[], q: number) =>
      values.length
        ? [...values].sort((a, b) => a - b)[
            Math.min(values.length - 1, Math.floor(values.length * q))
          ]
        : null;
    const routes = Object.fromEntries(
      Object.entries(wire).map(([path, { latency, ...stats }]) => [
        path,
        {
          ...stats,
          p95Ms: percentile(latency, 0.95),
          p99Ms: percentile(latency, 0.99),
        },
      ]),
    );
    console.log(
      JSON.stringify(
        {
          synthetic: true,
          localhostOnly: true,
          externalProviderRequests: 0,
          sourceHashes,
          storage: "in-memory SQLite; synthetic materialized position rollup",
          scope:
            "single-host shared-cache HTTP and SSE; excludes PostgreSQL/Redis/Render/CDN/TLS/cold-wallet capacity",
          requestedClients: clients,
          connectedClients: connected,
          requestedRestRps: restRps,
          configuredSeconds: seconds,
          offeredWindowMs,
          connectElapsedMs: connectElapsed,
          bootstrapP95Ms: percentile(bootstrapMs, 0.95),
          maxInflight,
          peakInflight,
          offered,
          started: startedRequests,
          completed,
          dropped,
          schedulerDrops,
          requestErrors,
          httpFailures,
          offeredRps: (offered / offeredWindowMs) * 1000,
          completedRps: (completed / offeredWindowMs) * 1000,
          restP95Ms: percentile(restMs, 0.95),
          restP99Ms: percentile(restMs, 0.99),
          restWarmupCompressedBytes: warmupBytes,
          etagPolicy:
            "real warmup ETags seed loaded viewers; subsequent ETags retained per viewer/route; each viewer rotates three panels; snapshots change every5s",
          routes,
          sse: {
            sequenceErrors,
            streamFailures,
            streamFailureReasons,
            steadyBytes: steadyStreamBytes,
            steadyMessages: steadyStreamMessages,
            latencyP95Ms: percentile(sseMs, 0.95),
            latencyP99Ms: percentile(sseMs, 0.99),
            latencySampleViewers: Math.min(64, clients),
          },
          server: report,
          generator: {
            peakRssMiB: peakGeneratorRss / 1048576,
            eventLoopP99Ms: loop.percentile(99) / 1e6,
            eventLoopMaxMs: loop.max / 1e6,
            cpuCorePercent:
              (used.user + used.system) /
              (performance.now() - steadyStart) /
              10,
          },
          aborted: abortReason,
        },
        null,
        2,
      ),
    );
    loop.disable();
    if (
      abortReason ||
      dropped ||
      requestErrors ||
      httpFailures ||
      streamFailures ||
      sequenceErrors
    )
      process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    finishing = true;
    for (const req of active) req.destroy();
    for (const socket of sockets) socket.destroy();
    restAgent.destroy();
    if (server.connected) server.kill("SIGTERM");
  }
}
