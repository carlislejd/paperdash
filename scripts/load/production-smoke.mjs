#!/usr/bin/env node
/** Prepared only. Running this requires the release owner's explicit authorization.
 * No keys, cookies, forwarding headers, external source URLs or automatic retries.
 * Default invocation prints the plan and makes ZERO network requests.
 */
import https from "node:https";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";

const ORIGIN = "https://paperdash-api.onrender.com";
const FRONTEND = "https://papertrade.club";
const args = process.argv.slice(2);
const known = new Set([
  "targets",
  "ramp",
  "hold-seconds",
  "deadline-seconds",
  "max-mib",
  "output",
  "profile",
]);
const values = new Map();
for (const arg of args) {
  if (arg === "--execute-approved") continue;
  const match = /^--([a-z-]+)=(.+)$/.exec(arg);
  if (!match || !known.has(match[1]) || values.has(match[1]))
    throw new Error("Unknown, repeated or malformed option");
  values.set(match[1], match[2]);
}
function integer(name, fallback, min, max) {
  const raw = values.get(name) ?? String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid ${name}`);
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new Error(`${name} must be ${min}–${max}`);
  return number;
}
const targets = (values.get("targets") ?? "500,1000").split(",").map((raw) => {
  if (!/^\d+$/.test(raw)) throw new Error("Invalid target list");
  const target = Number(raw);
  if (!Number.isSafeInteger(target) || target < 1 || target > 10000)
    throw new Error("Targets must be 1–10000");
  return target;
});
if (
  targets.length > 4 ||
  targets.some((target, index) => index > 0 && target <= targets[index - 1])
)
  throw new Error("Use 1–4 strictly increasing target counts");
const rampPerSecond = integer("ramp", 20, 1, 20);
const holdSeconds = integer("hold-seconds", 20, 5, 30);
const deadlineSeconds = integer("deadline-seconds", 120, 30, 900);
const maxMiB = integer("max-mib", 512, 10, 8192);
if (
  deadlineSeconds <
  targets.at(-1) / rampPerSecond + targets.length * holdSeconds + 10
)
  throw new Error(
    "Deadline is too short for the requested ramp/holds plus 10s margin",
  );
const profile = values.get("profile") ?? "overview";
if (!["overview", "mixed"].includes(profile))
  throw new Error("Profile must be overview or mixed");
function topicsFor(index) {
  if (profile === "overview") return ["overview"];
  const cohort = index % 20;
  if (cohort < 8) return ["overview", "trades"];
  if (cohort < 11) return ["overview", "asset:0"];
  if (cohort < 14) return ["overview", "asset:1"];
  if (cohort < 16) return ["overview", "liquidations"];
  return ["overview"];
}
function permitsTrade(topics, trade) {
  return (
    trade &&
    Number.isSafeInteger(trade.instrument) &&
    trade.instrument >= 0 &&
    (topics.includes("trades") ||
      topics.includes(`asset:${trade.instrument}`) ||
      (topics.includes("liquidations") && trade.kind === "liq"))
  );
}
function permitsMessage(topics, message) {
  if (["overview", "metrics", "history", "status"].includes(message.type))
    return true;
  if (message.type === "trade")
    return Boolean(permitsTrade(topics, message.data));
  return (
    message.type === "asset-price" &&
    Number.isSafeInteger(message.data?.instrument) &&
    topics.includes(`asset:${message.data.instrument}`)
  );
}
const PLAN = Object.freeze({
  origin: ORIGIN,
  profile,
  topicMix:
    profile === "overview"
      ? { overview: 100 }
      : {
          overview: 20,
          "overview,trades": 40,
          "overview,asset:0": 15,
          "overview,asset:1": 15,
          "overview,liquidations": 10,
        },
  stages: targets.map((connections) => ({ connections, holdSeconds })),
  newConnectionsPerSecond: rampPerSecond,
  totalNewConnectionCap: targets.at(-1),
  maximumNewConnectionsPerMinute: rampPerSecond * 60,
  maximumPendingConnections: 20,
  connectionBootstrapTimeoutMs: 10000,
  restRequestTimeoutMs: 5000,
  sharedRestIntervalMs: 4000,
  restPaths: ["/health/ready", "/api/overview", "/api/assets"],
  hardDurationSeconds: deadlineSeconds,
  generatorRssCapBytes: 2 * 1024 * 1024 * 1024,
  responseByteCap: maxMiB * 1024 * 1024,
  bodyEgressCostUpperEstimateUsdBeforeAllowance:
    ((maxMiB * 1024 * 1024) / 1e9) * 0.15,
  retry: false,
  spoofedForwardingHeaders: false,
});
const output = values.get("output");
if (output && !/^\/tmp\/[A-Za-z0-9_.-]+\.json$/.test(output))
  throw new Error("Reports must use a simple /tmp/*.json path");
if (!args.includes("--execute-approved")) {
  console.log(
    JSON.stringify(
      { preparedOnly: true, networkRequests: 0, plan: PLAN },
      null,
      2,
    ),
  );
  process.exit(0);
}

const limits = process.report?.getReport?.().userLimits?.open_files ?? null;
if (
  Number.isFinite(limits?.soft) &&
  limits.soft < PLAN.totalNewConnectionCap + 256
)
  throw new Error(
    "Process open-file limit is too low; do not start connections",
  );
const startedAt = new Date().toISOString(),
  start = performance.now();
const generatorCpuStart = process.cpuUsage();
const generatorLoop = monitorEventLoopDelay({ resolution: 20 });
generatorLoop.enable();
let generatorPeakRss = process.memoryUsage().rss,
  generatorPeakCpuCorePercent = 0,
  sampleCpu = process.cpuUsage(),
  sampleAt = performance.now();
let phaseCollectorAges = [],
  phaseQuoteAges = [],
  phaseTradeAges = [];
let stopping = false,
  abortReason = null,
  abortConnections = null,
  stage = "preflight";
let attempts = 0,
  ready = 0,
  active = 0,
  peakActive = 0,
  pendingCount = 0;
let responseBytes = 0,
  steadyStartBytes = 0,
  errorCount = 0,
  consecutiveErrors = 0;
let restPending = false,
  restIndex = 0,
  restTimer,
  watchdog;
let lastClock = performance.now(),
  lastWall = Date.now();
const requests = new Set(),
  clients = new Set(),
  pending = new Set();
const pauses = new Map(),
  errors = [],
  stages = [],
  restSamples = [],
  collectorAges = [],
  bootstrapTimes = [];
const eventTypes = {},
  statusCounts = {},
  topicStats = {};
const diagnosticEventCounts = {},
  diagnosticFailureCounts = {},
  connectionTimings = { sse: {}, rest: {} };
const restAgent = new https.Agent({ keepAlive: true, maxSockets: 2 });

// Do not retain error messages, peer/local addresses, certificates or headers:
// transport errors can embed addresses and URLs. Codes identify failure classes.
function safeError(error) {
  if (!error || typeof error !== "object") return null;
  const token = (value) =>
    typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value)
      ? value
      : null;
  return {
    name: token(error.name),
    code: token(error.code),
    errno:
      typeof error.errno === "number" && Number.isFinite(error.errno)
        ? error.errno
        : token(error.errno),
    syscall: token(error.syscall),
  };
}
function diagnosticEvent(kind, event, error) {
  if (stopping) return;
  const code = safeError(error)?.code ?? "none";
  const key = `${kind}:${event}:${code}`;
  diagnosticEventCounts[key] = (diagnosticEventCounts[key] ?? 0) + 1;
}
function connectionTrace(request, kind, started, label) {
  const elapsed = {},
    state = {
      socket: null,
      response: null,
      lastByteAt: null,
      bytes: 0,
      readyAt: null,
      family: null,
      tlsProtocol: null,
      socketError: null,
      socketHadError: null,
    };
  const mark = (name) => {
    if (elapsed[name] !== undefined) return;
    const value = performance.now() - started;
    elapsed[name] = value;
    const samples = (connectionTimings[kind][name] ??= []);
    if (samples.length < PLAN.totalNewConnectionCap + 1000) samples.push(value);
  };
  request.once("socket", (socket) => {
    state.socket = socket;
    mark("socketAssignedMs");
    // Reused REST sockets have no new DNS/TCP/TLS phase. Leave these null.
    if (request.reusedSocket) return;
    socket.once("lookup", (error, _address, family) => {
      if (family === 4 || family === 6) state.family = family;
      mark("dnsLookupMs");
      if (error) diagnosticEvent(kind, "dns-error", error);
    });
    socket.once("connect", () => mark("tcpConnectMs"));
    socket.once("secureConnect", () => {
      mark("tlsHandshakeMs");
      const protocol = socket.getProtocol?.();
      if (typeof protocol === "string" && /^TLSv[\d.]+$/.test(protocol))
        state.tlsProtocol = protocol;
    });
    socket.once("error", (error) => {
      state.socketError = safeError(error);
      diagnosticEvent(kind, "socket-error", error);
    });
    socket.once("close", (hadError) => {
      state.socketHadError = hadError;
      diagnosticEvent(kind, hadError ? "socket-close-error" : "socket-close");
    });
  });
  return {
    headers(response) {
      state.response = response;
      mark("responseHeadersMs");
    },
    data(bytes) {
      state.bytes += bytes;
      state.lastByteAt = performance.now();
      mark("firstByteMs");
    },
    ready() {
      state.readyAt = performance.now();
      mark("bootstrapMs");
    },
    details(event, error) {
      const now = performance.now();
      const phase =
        state.readyAt !== null
          ? "established"
          : state.response
            ? "awaiting-bootstrap-body"
            : request.reusedSocket || elapsed.tlsHandshakeMs !== undefined
              ? "awaiting-response-headers"
              : elapsed.tcpConnectMs !== undefined
                ? "tls-handshake"
                : elapsed.dnsLookupMs !== undefined
                  ? "tcp-connect"
                  : elapsed.socketAssignedMs !== undefined
                    ? "dns-or-tcp-connect"
                    : "awaiting-socket";
      return {
        ...label,
        event,
        lifecycle: state.readyAt !== null ? "established" : "bootstrap",
        connectionPhase: phase,
        ageMs: Math.round(now - started),
        establishedForMs:
          state.readyAt === null ? null : Math.round(now - state.readyAt),
        lastByteAgeMs:
          state.lastByteAt === null ? null : Math.round(now - state.lastByteAt),
        bytesReceived: state.bytes,
        status: state.response?.statusCode ?? null,
        responseComplete: state.response?.complete ?? null,
        responseAborted: state.response?.aborted ?? null,
        socketDestroyed: state.socket?.destroyed ?? null,
        socketHadError: state.socketHadError,
        reusedSocket: Boolean(request.reusedSocket),
        ipFamily: state.family,
        tlsProtocol: state.tlsProtocol,
        error: safeError(error) ?? state.socketError,
        phaseElapsedMs: Object.fromEntries(
          Object.entries(elapsed).map(([key, value]) => [
            key,
            Math.round(value * 100) / 100,
          ]),
        ),
      };
    },
  };
}

function cleanup() {
  stopping = true;
  clearInterval(restTimer);
  clearInterval(watchdog);
  generatorLoop.disable();
  for (const [timer, resolve] of pauses) {
    clearTimeout(timer);
    resolve();
  }
  pauses.clear();
  for (const request of requests) request.destroy();
  restAgent.destroy();
}
function abort(reason, details = undefined) {
  if (abortReason || stopping) return;
  abortReason = reason;
  abortConnections = {
    active,
    pendingCount,
    pending: [...clients]
      .filter((client) => !client.ready)
      .slice(0, PLAN.maximumPendingConnections)
      .map((client) => client.trace.details("pending-at-abort")),
  };
  errors.push({
    atMs: Math.round(performance.now() - start),
    stage,
    reason,
    ...(details ? { details } : {}),
  });
  console.error(`Smoke aborted: ${reason}`);
  cleanup();
}
function failure(reason, immediate = false, details = undefined) {
  if (stopping) return;
  errorCount++;
  consecutiveErrors++;
  const diagnosticKey = `${details?.kind ?? "general"}:${details?.event ?? reason}:${details?.error?.code ?? "none"}`;
  diagnosticFailureCounts[diagnosticKey] =
    (diagnosticFailureCounts[diagnosticKey] ?? 0) + 1;
  if (errors.length < 20)
    errors.push({
      atMs: Math.round(performance.now() - start),
      stage,
      reason,
      ...(details ? { details } : {}),
    });
  // Never retry throttles/capacity responses. Three errors or an error rate over
  // one percent after 100 attempts stop the run and close existing streams.
  if (
    immediate ||
    consecutiveErrors >= 3 ||
    errorCount >= 3 ||
    (attempts >= 100 && errorCount / attempts > 0.01)
  )
    abort(reason, details);
}
function countBytes(length) {
  responseBytes += length;
  if (responseBytes > PLAN.responseByteCap)
    abort("Response byte budget exceeded");
}
function pause(ms) {
  if (stopping) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pauses.delete(timer);
      resolve();
    }, ms);
    pauses.set(timer, resolve);
  });
}
function assertRunning() {
  if (stopping) throw new Error(abortReason ?? "Stopping");
}
function summaryOfPhase() {
  return {
    phase: stage,
    elapsedMs: Math.round(performance.now() - start),
    attempted: attempts,
    active,
    ready,
    errors: errorCount,
    responseBytes,
  };
}
function assertHealth(path, value) {
  if (path === "/health/ready" && value?.ready !== true)
    abort("Readiness is not healthy");
  if (
    value?.stale === true ||
    ((path === "/health/ready" || path === "/api/overview") &&
      value?.status?.stale === true)
  )
    abort("Collector/source became stale; stop load before diagnosis");
}
async function readShared(path) {
  if (stopping) return;
  const at = performance.now();
  await new Promise((resolve) => {
    let settled = false,
      bytes = 0,
      trace;
    const chunks = [];
    const done = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        requests.delete(request);
        resolve();
      }
    };
    const request = https.get(
      new URL(path, ORIGIN),
      {
        agent: restAgent,
        headers: {
          Accept: "application/json",
          Origin: FRONTEND,
          "User-Agent": "Paperdash-bounded-release-smoke/1.0",
        },
      },
      (response) => {
        trace.headers(response);
        const status = response.statusCode ?? 0;
        statusCounts[`${path}:${status}`] =
          (statusCounts[`${path}:${status}`] ?? 0) + 1;
        if (status !== 200) {
          failure(
            `REST ${path} returned ${status}; Retry-After=${response.headers["retry-after"] ?? "none"}`,
            true,
            trace.details("http-rejection"),
          );
          response.resume();
          done();
          return;
        }
        if (response.headers["access-control-allow-origin"] !== FRONTEND) {
          failure(`Unexpected CORS origin for ${path}`, true);
          done();
          return;
        }
        response.on("data", (chunk) => {
          trace.data(chunk.length);
          countBytes(chunk.length);
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) {
            failure(`Oversized shared REST response: ${path}`, true);
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (!stopping) {
            try {
              assertHealth(
                path,
                JSON.parse(Buffer.concat(chunks).toString("utf8")),
              );
            } catch {
              failure(`Unreadable JSON from ${path}`, true);
            }
            restSamples.push({
              path,
              status,
              durationMs: performance.now() - at,
              bytes,
            });
          }
          done();
        });
        response.on("error", (error) => {
          diagnosticEvent("rest", "response-error", error);
          failure(
            `REST transport error: ${path}`,
            true,
            trace.details("response-error", error),
          );
          done();
        });
        response.on("close", done);
      },
    );
    trace = connectionTrace(request, "rest", at, { kind: "rest", path });
    requests.add(request);
    const timeout = setTimeout(() => {
      failure(
        `REST timed out: ${path}`,
        true,
        trace.details("request-timeout"),
      );
      request.destroy();
      done();
    }, PLAN.restRequestTimeoutMs);
    request.on("error", (error) => {
      diagnosticEvent("rest", "request-error", error);
      failure(
        `REST request error: ${path}`,
        true,
        trace.details("request-error", error),
      );
      done();
    });
    request.on("close", done);
  });
}
function connect() {
  assertRunning();
  if (attempts >= PLAN.totalNewConnectionCap)
    throw new Error("Connection attempt cap exceeded");
  const topics = topicsFor(attempts),
    topicKey = topics.join(",");
  const stats = (topicStats[topicKey] ??= {
    attempted: 0,
    ready: 0,
    bytes: 0,
    eventTypes: {},
  });
  stats.attempted++;
  attempts++;
  pendingCount++;
  const at = performance.now();
  return new Promise((resolve) => {
    const client = {
      connectionId: attempts,
      topics: topicKey,
      ready: false,
      ended: false,
      lastId: null,
      lastType: null,
      lastByteAt: performance.now(),
      buffer: "",
      trace: null,
    };
    clients.add(client);
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        pendingCount--;
        clearTimeout(timeout);
        resolve();
      }
    };
    const details = (event, error) => ({
      ...client.trace.details(event, error),
      lastEventId: client.lastId === null ? null : String(client.lastId),
      lastEventType: client.lastType,
      bufferedCharacters: client.buffer.length,
    });
    const ended = (event, error) => {
      diagnosticEvent("sse", event, error);
      if (client.ended) return;
      client.ended = true;
      clients.delete(client);
      requests.delete(request);
      if (client.ready) active--;
      if (!stopping)
        failure("Unexpected SSE disconnect", false, details(event, error));
      done();
    };
    const request = https.get(
      `${ORIGIN}/api/events?topics=${encodeURIComponent(topicKey)}`,
      {
        agent: false,
        headers: {
          Accept: "text/event-stream",
          Origin: FRONTEND,
          "User-Agent": "Paperdash-bounded-release-smoke/1.0",
        },
      },
      (response) => {
        client.trace.headers(response);
        const status = response.statusCode ?? 0;
        statusCounts[`SSE:${status}`] =
          (statusCounts[`SSE:${status}`] ?? 0) + 1;
        if (
          status !== 200 ||
          !String(response.headers["content-type"]).startsWith(
            "text/event-stream",
          )
        ) {
          failure(
            `SSE rejected: ${status}; Retry-After=${response.headers["retry-after"] ?? "none"}`,
            true,
            details("http-rejection"),
          );
          response.resume();
          done();
          return;
        }
        if (response.headers["access-control-allow-origin"] !== FRONTEND) {
          failure("Unexpected SSE CORS origin", true);
          done();
          return;
        }
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          if (stopping) return;
          const byteLength = Buffer.byteLength(chunk);
          client.trace.data(byteLength);
          countBytes(byteLength);
          stats.bytes += byteLength;
          client.lastByteAt = performance.now();
          client.buffer += chunk.replace(/\r\n/g, "\n");
          if (client.buffer.length > 256 * 1024) {
            failure("SSE frame buffer exceeded limit", true);
            return;
          }
          let boundary;
          while (!stopping && (boundary = client.buffer.indexOf("\n\n")) >= 0) {
            const frame = client.buffer.slice(0, boundary);
            client.buffer = client.buffer.slice(boundary + 2);
            const lines = frame.split("\n"),
              data = lines
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
            if (!data) continue;
            let message;
            try {
              message = JSON.parse(data);
            } catch {
              failure("Malformed SSE JSON", true);
              return;
            }
            if (!permitsMessage(topics, message)) {
              failure(
                `Topic ${topicKey} leaked ${String(message.type).slice(0, 30)} or another asset; correct filter release must be active`,
                true,
              );
              return;
            }
            const id = lines
              .find((line) => line.startsWith("id:"))
              ?.slice(3)
              .trim();
            if (id) {
              if (!/^\d{1,20}$/.test(id)) {
                failure("Invalid SSE ID", true);
                return;
              }
              const current = BigInt(id);
              if (client.lastId !== null && current <= client.lastId) {
                failure("SSE duplicate or regressing ID", true, {
                  previousId: String(client.lastId),
                  currentId: id,
                  previousType: client.lastType,
                  currentType: String(message.type).slice(0, 30),
                  topics: topicKey,
                });
                return;
              }
              client.lastId = current;
              client.lastType = String(message.type).slice(0, 30);
            }
            eventTypes[message.type] = (eventTypes[message.type] ?? 0) + 1;
            stats.eventTypes[message.type] =
              (stats.eventTypes[message.type] ?? 0) + 1;
            const status =
              message.type === "status" ? message.data : message.data?.status;
            if (status?.stale) {
              failure("SSE reports stale source/collector; stop smoke", true);
              return;
            }
            if (Number.isSafeInteger(status?.receivedAt)) {
              const age = Math.max(0, Date.now() - status.receivedAt);
              if (collectorAges.length < 100000) collectorAges.push(age);
              if (
                stage.startsWith("hold-") &&
                phaseCollectorAges.length < 100000
              )
                phaseCollectorAges.push(age);
            }
            if (
              stage.startsWith("hold-") &&
              message.type === "asset-price" &&
              Number.isSafeInteger(message.data?.point?.time) &&
              phaseQuoteAges.length < 100000
            )
              phaseQuoteAges.push(
                Math.max(0, Date.now() - message.data.point.time),
              );
            if (
              stage.startsWith("hold-") &&
              message.type === "trade" &&
              Number.isSafeInteger(message.data?.ts) &&
              phaseTradeAges.length < 100000
            )
              phaseTradeAges.push(Math.max(0, Date.now() - message.data.ts));
            if (!client.ready) {
              if (message.type !== "overview") {
                failure("SSE delta arrived before bootstrap", true);
                return;
              }
              if (
                !Array.isArray(message.data?.trades) ||
                message.data.trades.some(
                  (trade) => !permitsTrade(topics, trade),
                )
              ) {
                failure(
                  `Bootstrap trades violate ${topicKey}; filter release is not active`,
                  true,
                );
                return;
              }
              client.ready = true;
              client.trace.ready();
              stats.ready++;
              active++;
              ready++;
              peakActive = Math.max(peakActive, active);
              consecutiveErrors = 0;
              bootstrapTimes.push(performance.now() - at);
              done();
            }
          }
        });
        response.on("error", (error) => ended("response-error", error));
        response.on("end", () => ended("response-end"));
        response.on("close", () => ended("response-close"));
      },
    );
    client.trace = connectionTrace(request, "sse", at, {
      kind: "sse",
      connectionId: client.connectionId,
      topics: topicKey,
    });
    requests.add(request);
    const timeout = setTimeout(() => {
      failure("SSE bootstrap timed out", true, details("bootstrap-timeout"));
      request.destroy();
      done();
    }, PLAN.connectionBootstrapTimeoutMs);
    request.on("error", (error) => ended("request-error", error));
    request.on("close", () => ended("request-close"));
  });
}
async function ramp(target) {
  stage = `ramp-to-${target}`;
  while (attempts < target && !stopping) {
    if (pendingCount >= PLAN.maximumPendingConnections) {
      await Promise.race(pending);
      continue;
    }
    const promise = connect().finally(() => pending.delete(promise));
    pending.add(promise);
    await pause(1000 / PLAN.newConnectionsPerSecond);
  }
  await Promise.all(pending);
  assertRunning();
  if (active !== target) {
    abort(`Expected ${target} healthy connections, observed ${active}`);
    assertRunning();
  }
}
function quantile(values, percentile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(sorted.length * percentile))
  ];
}
process.on("SIGINT", () => abort("Operator SIGINT"));
process.on("SIGTERM", () => abort("Operator SIGTERM"));
watchdog = setInterval(() => {
  const now = performance.now(),
    wall = Date.now();
  const rss = process.memoryUsage().rss;
  generatorPeakRss = Math.max(generatorPeakRss, rss);
  if (rss >= PLAN.generatorRssCapBytes)
    abort("Generator RSS reached the 2 GiB memory cap");
  const cpu = process.cpuUsage(sampleCpu);
  if (now > sampleAt)
    generatorPeakCpuCorePercent = Math.max(
      generatorPeakCpuCorePercent,
      (cpu.user + cpu.system) / (now - sampleAt) / 10,
    );
  sampleCpu = process.cpuUsage();
  sampleAt = now;
  if (now - start > PLAN.hardDurationSeconds * 1000)
    abort("Hard run duration exceeded");
  // A suspended laptop invalidates plateau timing; never resume a stale smoke unnoticed.
  if (now - lastClock > 5000 || wall - lastWall > 5000)
    abort("Generator/host stalled; timing evidence is invalid");
  lastClock = now;
  lastWall = wall;
  for (const client of clients)
    if (client.ready && now - client.lastByteAt > 25000) {
      abort(
        "SSE heartbeat/data stalled for 25 seconds",
        client.trace.details("inactivity-timeout"),
      );
      break;
    }
}, 500);
try {
  // Three low-rate shared-cache preflights; no wallets, searches or source reads.
  for (const path of PLAN.restPaths) {
    await readShared(path);
    assertRunning();
    await pause(1000);
  }
  restTimer = setInterval(() => {
    if (restPending || stopping) return;
    restPending = true;
    void readShared(
      PLAN.restPaths[restIndex++ % PLAN.restPaths.length],
    ).finally(() => {
      restPending = false;
    });
  }, PLAN.sharedRestIntervalMs);
  for (const step of PLAN.stages) {
    await ramp(step.connections);
    stage = `hold-${step.connections}`;
    phaseCollectorAges = [];
    phaseQuoteAges = [];
    phaseTradeAges = [];
    const phaseCpu = process.cpuUsage();
    const baseline = {
      ...summaryOfPhase(),
      restCount: restSamples.length,
      eventCount: Object.values(eventTypes).reduce((a, b) => a + b, 0),
    };
    steadyStartBytes = responseBytes;
    console.error(JSON.stringify({ checkpoint: "plateau-start", ...baseline }));
    await pause(step.holdSeconds * 1000);
    assertRunning();
    if (active !== step.connections)
      throw new Error("Plateau lost connections");
    const elapsed = performance.now() - start - baseline.elapsedMs;
    const phaseCpuUsed = process.cpuUsage(phaseCpu);
    stages.push({
      connections: step.connections,
      holdMs: elapsed,
      generatorCpuCorePercent:
        (phaseCpuUsed.user + phaseCpuUsed.system) / elapsed / 10,
      generatorRssMiB: process.memoryUsage().rss / 1048576,
      collectorObservationAgeP99Ms: quantile(phaseCollectorAges, 0.99),
      quoteSourceAgeP99Ms: quantile(phaseQuoteAges, 0.99),
      tradeSourceAgeP99Ms: quantile(phaseTradeAges, 0.99),
      responseBytes: responseBytes - steadyStartBytes,
      bytesPerViewerPerSecond:
        (responseBytes - steadyStartBytes) /
        step.connections /
        (elapsed / 1000),
      restRequests: restSamples.length - baseline.restCount,
      unintendedErrors: errorCount - baseline.errors,
      activeAtEnd: active,
    });
    console.error(
      JSON.stringify({ checkpoint: "plateau-complete", ...summaryOfPhase() }),
    );
  }
  stage = "postflight";
  await readShared("/health/ready");
  assertRunning();
} catch (error) {
  if (!abortReason)
    abort(
      error instanceof Error ? error.message.slice(0, 160) : "Smoke failed",
    );
} finally {
  cleanup();
  await Promise.allSettled(pending);
  const generatorCpu = process.cpuUsage(generatorCpuStart),
    generatorElapsed = performance.now() - start;
  const report = {
    startedAt,
    endedAt: new Date().toISOString(),
    passed: abortReason === null && stages.length === PLAN.stages.length,
    plan: PLAN,
    generatorOpenFileLimits: limits,
    elapsedMs: performance.now() - start,
    attemptedConnections: attempts,
    readyConnections: ready,
    peakActiveConnections: peakActive,
    responseBytes,
    unintendedErrors: errorCount,
    abortReason,
    abortConnections,
    stages,
    statusCounts,
    eventTypes,
    topicStats,
    connectionDiagnostics: {
      timingBasis:
        "Elapsed milliseconds from each request start; reused REST sockets omit new DNS/TCP/TLS phases. Missing phases are unknown, not zero.",
      errorsExcludeMessagesAndAddresses: true,
      eventCounts: diagnosticEventCounts,
      countedFailureClasses: diagnosticFailureCounts,
      timingSummary: Object.fromEntries(
        Object.entries(connectionTimings).map(([kind, phases]) => [
          kind,
          Object.fromEntries(
            Object.entries(phases).map(([phase, samples]) => [
              phase,
              {
                count: samples.length,
                p50Ms: quantile(samples, 0.5),
                p95Ms: quantile(samples, 0.95),
                p99Ms: quantile(samples, 0.99),
                maxMs: samples.reduce((max, value) => Math.max(max, value), 0),
              },
            ]),
          ),
        ]),
      ),
    },
    generator: {
      cpuCorePercent:
        (generatorCpu.user + generatorCpu.system) / generatorElapsed / 10,
      peakSampledCpuCorePercent: generatorPeakCpuCorePercent,
      peakRssMiB: generatorPeakRss / 1048576,
      finalRssMiB: process.memoryUsage().rss / 1048576,
      eventLoopP99Ms: generatorLoop.percentile(99) / 1e6,
      eventLoopMaxMs: generatorLoop.max / 1e6,
    },
    bootstrapP95Ms: quantile(bootstrapTimes, 0.95),
    bootstrapP99Ms: quantile(bootstrapTimes, 0.99),
    restP95Ms: quantile(
      restSamples.map((sample) => sample.durationMs),
      0.95,
    ),
    restP99Ms: quantile(
      restSamples.map((sample) => sample.durationMs),
      0.99,
    ),
    collectorObservationAgeP95Ms: quantile(collectorAges, 0.95),
    collectorObservationAgeP99Ms: quantile(collectorAges, 0.99),
    restSamples,
    errors,
    caveats: [
      "One real public IP and one generator region; no spoofed forwarding headers",
      `Profile ${profile}, short plateaus at the configured cap; no sustained or distributed capacity guarantee`,
      "No deliberate instance loss, slow readers, source failures or long soak",
      "Body bytes exclude TLS/TCP/header and static-asset overhead",
      "Per-instance distribution and resource utilization require separate Render observation",
    ],
  };
  const json = JSON.stringify(report, null, 2);
  console.log(json);
  if (output) await writeFile(output, `${json}\n`, { flag: "wx" });
  process.exitCode = report.passed ? 0 : 1;
}
