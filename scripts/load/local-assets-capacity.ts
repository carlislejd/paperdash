/** Localhost-only staggered Assets viewers against the real API and SQLite store.
 * No production target, collector, or external source access. Separate API/publisher/client processes.
 * node --import tsx scripts/load/local-assets-capacity.ts --clients=250 --seconds=45 --ramp-seconds=20
 */
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { Overview, TradeEvent } from "../../packages/shared/src/types.js";

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")));
const clients = Number(args.clients ?? 250);
const seconds = Number(args.seconds ?? 45);
const rampSeconds = Number(args["ramp-seconds"] ?? 20);
if (![clients, seconds, rampSeconds].every(Number.isInteger) || clients < 1 || clients > 500 || seconds < 20 || seconds > 90 || rampSeconds < 1 || rampSeconds > seconds / 2)
  throw new Error("Use 1–500 clients, 20–90 seconds, and a ramp no longer than half the run.");
const quantile = (items: number[], q: number) => items.length ? [...items].sort((a, b) => a - b)[Math.min(items.length - 1, Math.floor(items.length * q))] : null;
const wallet = (i: number) => `0x${createHash("sha256").update(`assets-load:${i}`).digest("hex").slice(0, 40)}`;

if (process.argv.includes("server")) {
  const dataDir = process.env.ASSETS_LOAD_DIR;
  if (!process.send || !dataDir?.startsWith(join(tmpdir(), "paperdash-assets-load-")))
    throw new Error("Internal API mode requires IPC and its disposable load-test directory.");
  globalThis.fetch = async () => { throw new Error("External requests disabled in local assets load test"); };
  const [{ createStore }, { buildApi }, { ChangeBus }] = await Promise.all([
    import("../../apps/server/src/store.js"), import("../../apps/server/src/api.js"), import("../../apps/server/src/bus.js"),
  ]);
  const store = await createStore({ dataDir, databaseUrl: "" });
  const bus = new ChangeBus();
  let getCalls = 0, marketGets = 0, tailReads = 0, bootstraps = 0;
  const originalGet = store.get.bind(store), originalEvents = store.events.bind(store);
  store.get = async (key) => { getCalls++; if (key.startsWith("market:")) marketGets++; if (key === "overview") bootstraps++; return originalGet(key); };
  store.events = async (...values) => { tailReads++; return originalEvents(...values); };
  const app = await buildApi(store, {} as never, bus, { logger: false });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  const started = performance.now(), cpu = process.cpuUsage(), baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  const memoryTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 100);
  process.send?.({ ready: url });
  process.on("message", (message) => {
    if (message === "changed") { bus.notify(); return; }
    if (message !== "stop") return;
    void (async () => {
      clearInterval(memoryTimer);
      const elapsedMs = performance.now() - started, used = process.cpuUsage(cpu);
      process.send?.({ report: { store: "temporary shared SQLite WAL", elapsedMs, baselineRssMiB: baselineRss / 1048576,
        peakRssMiB: Math.max(peakRss, process.memoryUsage().rss) / 1048576, finalRssMiB: process.memoryUsage().rss / 1048576,
        eventLoopP99Ms: loop.percentile(99) / 1e6, eventLoopMaxMs: loop.max / 1e6,
        cpuCorePercent: (used.user + used.system) / elapsedMs / 10, getCalls, marketGets, tailReads, bootstraps } });
      loop.disable(); await app.close(); bus.close(); await store.close(); process.disconnect?.();
    })();
  });
} else if (process.argv.includes("publisher")) {
  if (!process.send) throw new Error("Internal publisher mode requires IPC.");
  let upstreamRequests = 0;
  globalThis.fetch = async () => { upstreamRequests++; throw new Error("External requests disabled in local assets load test"); };
  const [{ createStore }, { emptyOverview }, { refreshMarkets }] = await Promise.all([
    import("../../apps/server/src/store.js"),
    import("../../apps/server/src/collector.js"), import("../../apps/server/src/market.js"),
  ]);
  const dataDir = await mkdtemp(join(tmpdir(), "paperdash-assets-load-"));
  const store = await createStore({ dataDir, databaseUrl: "" });
  const trade = (i: number, at = Date.now()): TradeEvent => ({
    id: `assets-load:${i}`, ts: at, wallet: wallet(i % 100), instrument: i % 2,
    side: i % 4 < 2 ? "long" : "short", leverage: 20, notionalUsd: 10000 + (i % 100) * 12345.67,
    kind: (["open", "close", "liq"] as const)[i % 3], pnlUsd: i % 3 ? (i % 2 ? -123 : 456) : null,
    priceUsd: i % 2 ? 2500 + (i % 100) / 100 : 83000 + (i % 100), provenance: "public-stream",
  });
  const initialAt = Date.now();
  for (let i = 0; i < 100; i++) await store.put(`account-summary:${wallet(i)}`, { address: wallet(i), realizedPnl: (BigInt(1000 + i * 2000) * 10n ** 18n).toString() }, initialAt);
  for (let i = 0; i < 720; i++) for (const instrument of [0, 1]) await store.market.quote({ instrument, priceUsd: instrument ? 2500 + i / 100 : 83000 + i / 10, sourceAt: initialAt - (720 - i) * 5000, receivedAt: initialAt - (720 - i) * 5000 });
  let sequence = 0;
  for (; sequence < 1200; sequence++) await store.recordTrade(trade(sequence, initialAt - (1200 - sequence) * 3000));
  const source: Overview = { ...emptyOverview("local"), trades: [], history: Array.from({ length: 300 }, (_, i) => ({ time: initialAt - (300 - i) * 60000, value: 100000000 + i * 1234.56 })), status: { ...emptyOverview("local").status, sourceAt: initialAt, receivedAt: initialAt, stale: false, stream: "connected" as const } };
  async function publish() {
    const at = Date.now();
    source.status.sourceAt = source.status.receivedAt = at;
    source.trades = await store.trades(50);
    await store.put("collector-heartbeat", { at, errors: {} });
    await store.put("market-connection", { connected: true, at }, at);
    await store.put("overview", { ...source, eventCursor: (await store.eventBounds()).latest ?? "0" }, at);
    await store.put("asset-source", { ok: true, historyGeneration: "local-assets-load", historyRevision: String(sequence), sourceAsOfMs: at,
      head: [at, 100000000, -500000, 12000, 3600000000, 2600000000, 2500000000, 1600000000] }, at);
    await store.put("asset-analytics", {
      activity: await store.analytics.activity([0, 1], at),
      history: Object.fromEntries([0, 1].map((instrument) => [instrument, Array.from({ length: 300 }, (_, i) => {
        const time = Math.floor(at / 60000) * 60000 - (300 - i) * 240000;
        return { instrument, time, sourceAt: time, receivedAt: time, sourceBlock: null,
          longRaw: (BigInt(1000000000 + i * 1326) * 10n ** 18n).toString(), shortRaw: (BigInt(900000000 + i * 628) * 10n ** 18n).toString() };
      })])),
    }, at);
    await refreshMarkets(store, at);
  }
  await publish();
  const api = fork(fileURLToPath(import.meta.url), ["server"], { execArgv: ["--import", "tsx"], env: { ...process.env, ASSETS_LOAD_DIR: dataDir }, stdio: ["ignore", "ignore", "inherit", "ipc"] });
  let apiReport: any;
  const url = await new Promise<string>((resolve, reject) => {
    api.once("error", reject); api.once("exit", (code) => { if (code) reject(new Error(`Local API exited: ${code}`)); });
    api.on("message", (message: any) => { if (message.ready) resolve(message.ready); if (message.report) apiReport = message.report; });
  });
  process.once("SIGTERM", () => { api.kill("SIGTERM"); void store.close().finally(() => rm(dataDir, { recursive: true, force: true })).finally(() => process.exit(0)); });
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  const baselineRss = process.memoryUsage().rss, cpu = process.cpuUsage(), started = performance.now();
  let peakRss = baselineRss, publicationInFlight = false, generatedTrades = 0, generatedQuotes = 0, publicationFailures = 0;
  let work = Promise.resolve();
  const enqueue = (fn: () => Promise<void>) => { work = work.then(fn).catch(() => { publicationFailures++; }); };
  const memoryTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 100);
  const tradeTimer = setInterval(() => enqueue(async () => { await store.recordTrade(trade(sequence++)); generatedTrades++; api.send("changed"); }), 100);
  const quoteTimer = setInterval(() => enqueue(async () => {
    const at = Date.now();
    for (const instrument of [0, 1]) { await store.market.quote({ instrument, priceUsd: instrument ? 2500 + sequence / 100 : 83000 + sequence, sourceAt: at, receivedAt: at }); generatedQuotes++; }
    api.send("changed");
  }), 1000);
  const snapshotTimer = setInterval(() => {
    if (publicationInFlight) return;
    publicationInFlight = true;
    enqueue(async () => { try { await publish(); } finally { publicationInFlight = false; } });
  }, 5000);
  process.send?.({ ready: url });
  process.on("message", (message) => { if (message !== "stop") return; void (async () => {
    for (const timer of [memoryTimer, tradeTimer, quoteTimer, snapshotTimer]) clearInterval(timer);
    await work;
    const elapsedMs = performance.now() - started, used = process.cpuUsage(cpu);
    const publisher = { elapsedMs, baselineRssMiB: baselineRss / 1048576, peakRssMiB: Math.max(peakRss, process.memoryUsage().rss) / 1048576,
      finalRssMiB: process.memoryUsage().rss / 1048576, eventLoopP99Ms: loop.percentile(99) / 1e6, eventLoopMaxMs: loop.max / 1e6,
      cpuCorePercent: (used.user + used.system) / elapsedMs / 10, generatedTrades, generatedQuotes, publicationFailures, upstreamRequests };
    api.send("stop"); await new Promise<void>((resolve) => api.once("exit", () => resolve()));
    process.send?.({ report: { ...apiReport, publisher } });
    loop.disable(); await store.close(); await rm(dataDir, { recursive: true, force: true }); process.disconnect?.();
  })(); });
} else {
  const server = fork(fileURLToPath(import.meta.url), ["publisher"], { execArgv: ["--import", "tsx"], env: { ...process.env, DATABASE_URL: "", REDIS_URL: "", EMBEDDED_COLLECTOR: "false" }, stdio: ["ignore", "ignore", "inherit", "ipc"] });
  let serverReport: any;
  const url = await new Promise<string>((resolve, reject) => {
    server.once("error", reject); server.once("exit", (code) => { if (code) reject(new Error(`API exited: ${code}`)); });
    server.on("message", (message: any) => { if (message.ready) resolve(message.ready); if (message.report) serverReport = message.report; });
  });
  type Viewer = { id: number; instrument: number; request?: http.ClientRequest; closing: boolean; lastId: bigint; etags: Map<string, string>; marketAt: number; assetsAt: number; joinedAt: number; latestQuoteAt: number; };
  const viewers: Viewer[] = [], restAgent = new http.Agent({ keepAlive: true, maxSockets: 128 });
  const pending = new Set<Promise<void>>(), failures: string[] = [], latencies: number[] = [], restTimes: number[] = [], bootstrapTimes: number[] = [], snapshotAges: number[] = [];
  const statuses: Record<string, number> = {}, routes: Record<string, number> = {};
  let ready = 0, connected = 0, peakConnected = 0, reconnects = 0, streamMessages = 0, bytes = 0, restRequests = 0, finishing = false;
  let scheduler: ReturnType<typeof setInterval> | undefined;
  const started = Date.now();
  const failure = (reason: string) => { if (!finishing && failures.length < 30) failures.push(reason); };
  async function connect(viewer: Viewer) {
    return new Promise<void>((resolve) => {
      const at = performance.now(); viewer.closing = false; viewer.lastId = 0n; viewer.joinedAt = Date.now();
      let done = false, hasBootstrap = false;
      const complete = () => { if (!done) { done = true; clearTimeout(timeout); resolve(); } };
      const timeout = setTimeout(() => { failure(`viewer ${viewer.id}: bootstrap timeout`); request.destroy(); complete(); }, 5000);
      const request = http.get(`${url}/api/events?topics=overview,asset:${viewer.instrument}`, { agent: false }, (response) => {
        if (response.statusCode !== 200) { failure(`stream status ${response.statusCode}`); response.resume(); complete(); return; }
        connected++; peakConnected = Math.max(peakConnected, connected);
        let buffer = "";
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length; buffer += chunk.toString();
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const id = frame.split("\n").find((line) => line.startsWith("id: "))?.slice(4);
            const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
            if (!data) continue;
            if (id && BigInt(id) <= viewer.lastId) failure(`viewer ${viewer.id}: non-increasing stream sequence`);
            if (id) viewer.lastId = BigInt(id);
            const event = JSON.parse(data); streamMessages++;
            if (event.type === "overview" && !hasBootstrap) { hasBootstrap = true; ready++; bootstrapTimes.push(performance.now() - at); complete(); }
            if ((event.type === "trade" || event.type === "asset-price") && event.data.instrument !== viewer.instrument) failure("wrong asset delivered");
            const sourceAt = event.type === "trade" ? event.data.ts : event.type === "asset-price" ? event.data.receivedAt : null;
            if (event.type === "asset-price") viewer.latestQuoteAt = Math.max(viewer.latestQuoteAt, event.data.point.time);
            // Bootstrap replay may legitimately predate joining; measure live publications separately.
            if (sourceAt >= viewer.joinedAt) latencies.push(Date.now() - sourceAt);
          }
        });
        response.on("close", () => { connected--; if (!viewer.closing) failure(`viewer ${viewer.id}: unexpected stream close`); complete(); });
        response.on("error", (error) => { if (!viewer.closing) failure(`stream: ${error.message}`); complete(); });
      });
      viewer.request = request;
      request.on("error", (error) => { if (!viewer.closing) failure(`connect: ${error.message}`); complete(); });
    });
  }
  function rest(viewer: Viewer, path: string) {
    if (pending.size >= 128) { failure("REST pending bound reached"); return; }
    restRequests++; routes[path] = (routes[path] ?? 0) + 1;
    const task = new Promise<void>((resolve) => {
      const at = performance.now(), headers: Record<string, string> = { "accept-encoding": "gzip" };
      const etag = viewer.etags.get(path); if (etag) headers["if-none-match"] = etag;
      const request = http.get(`${url}${path}`, { agent: restAgent, headers }, (response) => {
        statuses[String(response.statusCode)] = (statuses[String(response.statusCode)] ?? 0) + 1;
        const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => { chunks.push(chunk); bytes += chunk.length; });
        response.on("end", () => {
          restTimes.push(performance.now() - at);
          try {
            if (![200, 304].includes(response.statusCode!)) throw new Error(`HTTP ${response.statusCode}`);
            if (typeof response.headers.etag === "string") viewer.etags.set(path, response.headers.etag);
            if (response.statusCode === 200 && path.includes("/market")) {
              const raw = Buffer.concat(chunks), body = JSON.parse((response.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString());
              const expected = new URL(path, url).searchParams;
              if (body.instrument !== viewer.instrument || body.activity !== expected.get("activity")) throw new Error("market selection mismatch");
              const age = Date.now() - body.receivedAt; snapshotAges.push(age);
              if (age > 15000 || body.stale || !body.chartSample || body.trades.length > 200 || body.chartSample.trades.length > 62) throw new Error("stale or unbounded market response");
              if (expected.get("segment") === "profitable" && body.segmentCoverage?.activity !== expected.get("activity")) throw new Error("profit classification mismatch");
            }
          } catch (error) { failure(`REST ${path}: ${(error as Error).message}`); }
          resolve();
        });
        response.on("error", (error) => { failure(`REST response: ${error.message}`); resolve(); });
      });
      request.setTimeout(4000, () => request.destroy(new Error("REST deadline")));
      request.on("error", (error) => { failure(`REST: ${error.message}`); resolve(); });
    }).finally(() => pending.delete(task));
    pending.add(task);
  }
  try {
    scheduler = setInterval(() => {
      const now = Date.now();
      for (const viewer of viewers) {
        if (now >= viewer.marketAt) {
          const segment = viewer.id % 2 ? "profitable" : "all", activity = (["all", "entries", "exits"] as const)[viewer.id % 3], window = (["5m", "15m", "1h"] as const)[Math.floor(viewer.id / 3) % 3];
          rest(viewer, `/api/assets/${viewer.instrument}/market?window=${window}&segment=${segment}${segment === "profitable" ? `&minPnl=${[1000, 10000, 100000][Math.floor(viewer.id / 9) % 3]}` : ""}&activity=${activity}`);
          viewer.marketAt = now + (segment === "profitable" ? 5000 : 15000) + viewer.id % 1000;
        }
        if (now >= viewer.assetsAt) { rest(viewer, "/api/assets"); viewer.assetsAt = now + 15000 + viewer.id % 1000; }
      }
    }, 50);
    for (let i = 0; i < clients; i++) {
      const viewer: Viewer = { id: i, instrument: Math.floor(i / 2) % 2, closing: false, lastId: 0n, etags: new Map(), marketAt: Date.now(), assetsAt: Date.now(), joinedAt: 0, latestQuoteAt: 0 };
      viewers.push(viewer); await connect(viewer);
      const target = started + ((i + 1) * rampSeconds * 1000) / clients;
      if (Date.now() < target) await sleep(target - Date.now());
    }
    const connectedAfterRamp = connected;
    await sleep(Math.max(0, started + (seconds - 10) * 1000 - Date.now()));
    const count = Math.min(50, Math.floor(clients / 5));
    for (const viewer of viewers.slice(0, count)) { viewer.closing = true; viewer.request?.destroy(); }
    await sleep(150);
    for (const viewer of viewers.slice(0, count)) { await connect(viewer); reconnects++; rest(viewer, `/api/assets/${viewer.instrument}/market?window=15m&segment=all&activity=exits`); }
    await sleep(Math.max(0, started + seconds * 1000 - Date.now()));
    clearInterval(scheduler); await Promise.all(pending);
    const finalConnected = connected;
    const maxFinalQuoteAgeMs = Math.max(...viewers.map((viewer) => Date.now() - viewer.latestQuoteAt));
    if (maxFinalQuoteAgeMs > 5000) failure("A connected viewer's reference price stopped advancing");
    finishing = true; for (const viewer of viewers) { viewer.closing = true; viewer.request?.destroy(); }
    restAgent.destroy(); server.send("stop"); await new Promise<void>((resolve) => server.once("exit", () => resolve()));
    const report = { synthetic: true, productionTraffic: false, at: new Date().toISOString(), clients, seconds, rampSeconds, reconnects,
      connectedAfterRamp, finalConnected, peakConnected, successfulBootstraps: ready, firstSnapshotP95Ms: quantile(bootstrapTimes, .95),
      firstSnapshotP99Ms: quantile(bootstrapTimes, .99), sourceToClientP95Ms: quantile(latencies, .95), sourceToClientP99Ms: quantile(latencies, .99),
      sourceToClientMaxMs: latencies.reduce((max, value) => Math.max(max, value), 0), maxFinalQuoteAgeMs, streamMessages, liveLatencySamples: latencies.length, restRequests, statuses,
      restP95Ms: quantile(restTimes, .95), restP99Ms: quantile(restTimes, .99), maxSnapshotAgeMs: Math.max(0, ...snapshotAges),
      receivedMiB: bytes / 1048576, failures, server: serverReport, routes };
    const json = JSON.stringify(report, null, 2); if (args.output) await writeFile(args.output, `${json}\n`); console.log(json);
    if (failures.length || ready !== clients + reconnects || finalConnected !== clients || serverReport?.publisher?.publicationFailures || serverReport?.publisher?.upstreamRequests) process.exitCode = 1;
  } finally {
    clearInterval(scheduler); finishing = true; for (const viewer of viewers) { viewer.closing = true; viewer.request?.destroy(); } restAgent.destroy();
    if (server.connected) server.kill("SIGTERM");
  }
}
