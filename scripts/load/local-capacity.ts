/** Synthetic localhost only. No collector or external upstream is started.
 * node --import tsx scripts/load/local-capacity.ts --clients=2000 --seconds=20 --profile=mixed
 * Client and API run in separate processes on the SAME host: not a Render capacity certification.
 */
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const opts = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => a.slice(2).split("=")),
);
const clients = Number(opts.clients ?? 2000),
  seconds = Number(opts.seconds ?? 20);
if (
  !Number.isInteger(clients) ||
  clients < 1 ||
  clients > 10000 ||
  !Number.isInteger(seconds) ||
  seconds < 5 ||
  seconds > 120
)
  throw new Error("Use1–10000 clients and5–120 seconds");
const profile = opts.profile ?? "mixed";
if (!["all", "mixed", "overview"].includes(profile))
  throw new Error("Unknown load profile");

if (process.argv.includes("server")) {
  const [{ createStore }, { buildApi }, { ChangeBus }, { emptyOverview }] =
    await Promise.all([
      import("../../apps/server/src/store.js"),
      import("../../apps/server/src/api.js"),
      import("../../apps/server/src/bus.js"),
      import("../../apps/server/src/collector.js"),
    ]);
  const store = await createStore({ memory: true });
  const bus = new ChangeBus();
  let reads = 0,
    tails = 0,
    snapshots = 0,
    sourceReads = 0;
  const originalGet = store.get.bind(store),
    originalEvents = store.events.bind(store);
  store.get = async (key) => {
    reads++;
    if (key === "overview") snapshots++;
    return originalGet(key);
  };
  store.events = async (...args) => {
    tails++;
    return originalEvents(...args);
  };
  const address = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;
  let sequence = 0;
  const trade = (i: number) => ({
    id: `synthetic:${i}`,
    ts: Date.now(),
    wallet: address((i % 1000) + 1),
    instrument: i % 2,
    side: i % 2 ? ("short" as const) : ("long" as const),
    leverage: 1000,
    notionalUsd: 10_000_000_000,
    kind: i % 7 ? ("open" as const) : ("liq" as const),
    pnlUsd: null,
    priceUsd: i % 2 ? 2500 : 83000,
    provenance: "public-stream" as const,
  });
  const overview = {
    ...emptyOverview("local"),
    summary: {
      ok: true,
      source: { block: "100", at: Date.now() },
      balances: {
        tvl: "10000000000000000000000000000",
        margin: "0",
        lp: "0",
        reserve: "0",
        queue: "0",
      },
      activity: { volume: "1000000000000000000000000000000", open: 1000 },
      fees: { pending: "0", lifetime: "0" },
      paper: { supply: "0", staked: "0" },
    },
    accountCount: 10000,
    history: Array.from({ length: 300 }, (_, i) => ({
      time: Date.now() - (300 - i) * 60000,
      value: 10_000_000_000 + i * 100,
    })),
    trades: Array.from({ length: 50 }, (_, i) => trade(i)),
    status: {
      ...emptyOverview("local").status,
      stale: false,
      stream: "connected" as const,
      sourceAt: Date.now(),
      receivedAt: Date.now(),
    },
  };
  const cache = {
    accounts: [],
    count: 10000,
    pageInfo: { page: 0, totalPages: 400 },
    summary: {
      uniqueAccounts: 10000,
      trackedBalance: "0",
      trackedQueued: "0",
      trackedOpenNotional: "0",
      trackedPaper: "0",
    },
    receivedAt: Date.now(),
    stale: false,
  };
  const fakeUpstream = {
    async accounts(_q: string, _sort: string, page: number) {
      sourceReads++;
      return { ...cache, pageInfo: { ...cache.pageInfo, page } };
    },
    async wallet(wallet: string) {
      sourceReads++;
      return {
        address: wallet,
        snapshot: null,
        cashflows: {
          items: Array.from({ length: 75 }, (_, i) => ({
            id: String(i),
            amountRaw: "10000000000000000000000000000",
            timestampMs: Date.now() - i * 60000,
            kind: "Deposit",
            txHash: `0x${"a".repeat(64)}`,
          })),
          nextCursor: null,
        },
        trades: {
          items: Array.from({ length: 75 }, (_, i) => trade(i)),
          nextCursor: null,
        },
        portfolio: { samples: overview.history },
        receivedAt: Date.now(),
        stale: true,
        errors: ["Synthetic load fixture"],
      };
    },
  };
  await store.put("overview", { ...overview, eventCursor: "0" });
  await store.put("collector-heartbeat", { at: Date.now(), errors: {} });
  for (const instrument of [0, 1])
    await store.put(`market:${instrument}`, {
      instrument,
      symbol: instrument ? "ETH" : "BTC",
      price: { priceUsd: 83000, sourceAt: Date.now(), receivedAt: Date.now() },
      points: Array.from({ length: 720 }, (_, i) => ({
        time: Date.now() - (720 - i) * 5000,
        priceUsd: 83000 + i * 0.01,
      })),
      trades: Array.from({ length: 200 }, (_, i) => trade(i)),
      windowFrom: Date.now() - 3600000,
      windowTo: Date.now(),
      receivedAt: Date.now(),
      stale: false,
      coverage: {
        source: "retained-market-observations",
        observedFrom: Date.now() - 3600000,
        partial: true,
        tradesCapped: true,
      },
    });
  await store.put("market-connection", { connected: true });
  const app = await buildApi(store, fakeUpstream as never, bus, {
    logger: false,
    maxStreams: 12000,
  });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const start = performance.now(),
    cpu = process.cpuUsage();
  let peakRss = process.memoryUsage().rss;
  const memoryTimer = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 100);
  const tradeTimer = setInterval(() => {
    void store
      .event({ type: "trade", data: trade(++sequence) })
      .then(() => bus.notify());
  }, 180);
  const priceTimer = setInterval(() => {
    for (const instrument of [0, 1])
      void store
        .event({
          type: "asset-price",
          data: {
            instrument,
            point: { time: Date.now(), priceUsd: 83000 + sequence },
            receivedAt: Date.now(),
          },
        })
        .then(() => bus.notify());
  }, 1000);
  const metricTimer = setInterval(() => {
    void (async () => {
      overview.status.receivedAt = overview.status.sourceAt = Date.now();
      await store.event({
        type: "metrics",
        data: {
          summary: overview.summary,
          accountCount: overview.accountCount,
          status: overview.status,
        },
      });
      await store.put("overview", {
        ...overview,
        eventCursor: (await store.eventBounds()).latest,
      });
      await store.put("collector-heartbeat", { at: Date.now(), errors: {} });
      bus.notify();
    })();
  }, 2000);
  process.send?.({ ready: url });
  process.on("message", (message) => {
    if (message !== "stop") return;
    void (async () => {
      clearInterval(tradeTimer);
      clearInterval(priceTimer);
      clearInterval(metricTimer);
      clearInterval(memoryTimer);
      const cpuUsed = process.cpuUsage(cpu),
        elapsed = performance.now() - start;
      process.send?.({
        server: {
          elapsedMs: elapsed,
          peakRssMiB: peakRss / 1048576,
          finalRssMiB: process.memoryUsage().rss / 1048576,
          eventLoopP99Ms: loop.percentile(99) / 1e6,
          eventLoopMaxMs: loop.max / 1e6,
          cpuCorePercent: (cpuUsed.user + cpuUsed.system) / elapsed / 10,
          databaseCalls: { snapshots, tailReads: tails, getReads: reads },
          fakeProfileLoads: sourceReads,
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
  let report: unknown;
  const url = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.on("message", (message: any) => {
      if (message.ready) resolve(message.ready);
      if (message.server) report = message.server;
    });
  });
  const sockets: http.ClientRequest[] = [],
    restAgent = new http.Agent({ keepAlive: true, maxSockets: 128 });
  const statuses: Record<string, number> = {};
  let ready = 0,
    bytes = 0,
    messages = 0,
    failures = 0,
    finishing = false;
  const latencies: number[] = [],
    restTimes: number[] = [],
    bootstrapTimes: number[] = [];
  const started = performance.now();
  const topic = (i: number) =>
    profile === "all"
      ? ""
      : profile === "overview"
        ? "?topics=overview"
        : i % 10 < 2
          ? "?topics=overview,trades"
          : i % 10 < 4
            ? `?topics=overview,asset:${i % 2}`
            : "?topics=overview";
  let next = 0;
  const connectionDeadline = Date.now() + 60000;
  const connect = async (i: number) =>
    new Promise<void>((resolve) => {
      const at = performance.now();
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve();
        }
      };
      const timeout = setTimeout(() => {
        request.destroy(new Error("Local connect deadline exceeded"));
        done();
      }, 5000);
      const request = http.get(
        `${url}/api/events${topic(i)}`,
        {
          agent: false,
          headers: {
            "x-forwarded-for": `10.1.${Math.floor(i / 250)}.${(i % 250) + 1}`,
          },
        },
        (response) => {
          if (response.statusCode !== 200) {
            failures++;
            response.resume();
            done();
            return;
          }
          ready++;
          bootstrapTimes.push(performance.now() - at);
          let pending = "";
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            const text = chunk.toString();
            messages += text.split("\ndata: ").length - 1;
            if (i < 20) {
              pending += text;
              let boundary: number;
              while ((boundary = pending.indexOf("\n\n")) >= 0) {
                const frame = pending.slice(0, boundary);
                pending = pending.slice(boundary + 2);
                const line = frame
                  .split("\n")
                  .find((line) => line.startsWith("data: "));
                if (!line) continue;
                const event = JSON.parse(line.slice(6));
                const sourceAt =
                  event.type === "trade"
                    ? event.data.ts
                    : event.type === "asset-price"
                      ? event.data.receivedAt
                      : null;
                if (sourceAt) latencies.push(Date.now() - sourceAt);
              }
            }
            done();
          });
          response.on("error", () => {
            if (!finishing) failures++;
            done();
          });
        },
      );
      request.on("error", () => {
        if (!finishing) failures++;
        done();
      });
      sockets.push(request);
    });
  try {
    await Promise.all(
      Array.from({ length: Math.min(20, clients) }, async () => {
        while (next < clients && Date.now() < connectionDeadline)
          await connect(next++);
      }),
    );
    const initialBytes = bytes,
      initialMessages = messages,
      connectedIn = performance.now() - started;
    let requests = 0;
    const pending = new Set<Promise<void>>();
    const paths = [
      "/api/overview",
      "/api/assets/0/market",
      "/api/assets/1/market",
      "/api/accounts?page=0",
    ];
    const rest = setInterval(() => {
      if (pending.size >= 128) return;
      const index = requests++,
        path =
          index % 2
            ? `/api/wallets/0x${((index % 1000) + 1).toString(16).padStart(40, "0")}`
            : paths[(index / 2) % paths.length];
      const work = new Promise<void>((resolve) => {
        const at = performance.now();
        const request = http.get(
          `${url}${path}`,
          {
            agent: restAgent,
            headers: {
              "accept-encoding": "gzip",
              "x-forwarded-for": `10.2.${Math.floor((index % 1000) / 250)}.${(index % 250) + 1}`,
            },
          },
          (response) => {
            const key = String(response.statusCode);
            statuses[key] = (statuses[key] ?? 0) + 1;
            response.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
            });
            response.on("end", () => {
              restTimes.push(performance.now() - at);
              resolve();
            });
            response.on("error", () => {
              failures++;
              resolve();
            });
          },
        );
        request.on("error", () => {
          failures++;
          resolve();
        });
      }).finally(() => pending.delete(work));
      pending.add(work);
    }, 15); // ~67 REST/s: 1000 panels polling every15s.
    await delay(seconds * 1000);
    clearInterval(rest);
    await Promise.all(pending);
    const steadyBytes = bytes - initialBytes,
      steadyMessages = messages - initialMessages;
    finishing = true;
    for (const socket of sockets) socket.destroy();
    restAgent.destroy();
    server.send("stop");
    await new Promise<void>((resolve) => server.once("exit", () => resolve()));
    const quantile = (values: number[], q: number) =>
      values.length
        ? [...values].sort((a, b) => a - b)[
            Math.min(values.length - 1, Math.floor(values.length * q))
          ]
        : null;
    console.log(
      JSON.stringify(
        {
          synthetic: true,
          providerLoad: false,
          profile,
          requestedClients: clients,
          attemptedClients: next,
          connectedClients: ready,
          seconds,
          connectedInMs: connectedIn,
          firstByteP95Ms: quantile(bootstrapTimes, 0.95),
          bootstrapBytes: initialBytes,
          steadyBytes,
          steadyBytesPerClientPerSecond: steadyBytes / ready / seconds,
          steadyEvents: steadyMessages,
          sourceToClientP95Ms: quantile(latencies, 0.95),
          sourceToClientP99Ms: quantile(latencies, 0.99),
          restRequests: requests,
          restStatuses: statuses,
          restP95Ms: quantile(restTimes, 0.95),
          restP99Ms: quantile(restTimes, 0.99),
          failures,
          server: report,
        },
        null,
        2,
      ),
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    restAgent.destroy();
    if (server.connected) server.kill("SIGTERM");
  }
}
