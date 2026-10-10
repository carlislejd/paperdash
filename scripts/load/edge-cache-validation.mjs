#!/usr/bin/env node
// Prepared for an explicitly authorized release check. Default invocation is offline.
import https from "node:https";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
const API = "https://paperdash-api.onrender.com";
const ALLOWED = [
  "https://papertrade.club",
  "https://www.papertrade.club",
  "https://paperdash-web.onrender.com",
];
const DENIED = "https://edge-validation.invalid";
const argv = process.argv.slice(2),
  values = new Map();
for (const arg of argv) {
  if (arg === "--execute-approved") continue;
  const match = /^--(wallet|output)=(.+)$/.exec(arg);
  if (!match || values.has(match[1]))
    throw new Error("Unknown or duplicate argument");
  values.set(match[1], match[2]);
}
const wallet = values.get("wallet");
if (wallet && !/^0x[a-fA-F0-9]{40}$/.test(wallet))
  throw new Error("Invalid retained-wallet address");
const output = values.get("output");
if (output && !/^\/tmp\/[A-Za-z0-9_.-]+\.json$/.test(output))
  throw new Error("Output must be a simple /tmp/*.json path");
const plan = {
  origin: API,
  allowedOrigins: ALLOWED,
  requestCap: 65,
  bodyByteCap: 16 * 1024 * 1024,
  deadlineMs: 60000,
  requestTimeoutMs: 5000,
  sseDurationMs: 3000,
  retries: 0,
  minimumRequestSpacingMs: 100,
  externalUpstreamRequests: 0,
  walletChecks: wallet
    ? "Retained position metrics and cashflow/trade pages only"
    : "Skipped: no known retained wallet supplied",
  excludedFullWalletSnapshot: true,
  stages: [
    "Alternating allowed/no/denied Origin within measured one-second windows",
    "Identity/gzip decode and ETag 304",
    "Expiry after 1.25 seconds",
    "Exact allowlist and no-store exclusions",
    "Credentials after anonymous warm cache",
    "One three-second SSE header check",
  ],
};
if (!argv.includes("--execute-approved")) {
  console.log(
    JSON.stringify({ preparedOnly: true, networkRequests: 0, plan }, null, 2),
  );
  process.exit(0);
}
const started = Date.now(),
  requests = new Set(),
  agent = new https.Agent({ keepAlive: true, maxSockets: 2 });
const rows = [],
  checks = [],
  notes = [],
  timingWindows = [];
let requestCount = 0,
  bytes = 0,
  lastStarted = 0,
  stopped = false,
  abortReason = null;
function check(condition, name, details) {
  checks.push({
    name,
    passed: Boolean(condition),
    ...(details ? { details } : {}),
  });
}
function stop(reason) {
  if (abortReason) return;
  abortReason = reason;
  stopped = true;
  for (const req of requests) req.destroy();
  agent.destroy();
}
const deadline = setTimeout(
  () => stop("Hard deadline reached"),
  plan.deadlineMs,
);
process.on("SIGINT", () => stop("Operator SIGINT"));
process.on("SIGTERM", () => stop("Operator SIGTERM"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function ensure() {
  if (stopped) throw new Error(abortReason ?? "Stopped");
  if (requestCount >= plan.requestCap) throw new Error("Request cap reached");
}
async function read(
  path,
  {
    origin = ALLOWED[0],
    encoding = "identity",
    headers = {},
    method = "GET",
    stream = false,
  } = {},
) {
  ensure();
  await sleep(
    Math.max(0, plan.minimumRequestSpacingMs - (Date.now() - lastStarted)),
  );
  ensure();
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new Error("Only fixed-origin paths are allowed");
  lastStarted = Date.now();
  requestCount++;
  const at = Date.now();
  return await new Promise((resolve, reject) => {
    let done = false,
      size = 0,
      timer;
    const chunks = [];
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      requests.delete(req);
      if (error) reject(error);
      else resolve(value);
    };
    const req = https.request(
      new URL(path, API),
      {
        agent,
        method,
        headers: {
          Accept: stream ? "text/event-stream" : "application/json",
          "Accept-Encoding": encoding,
          "User-Agent": "Paperdash-bounded-edge-validation/1.0",
          ...(origin === null ? {} : { Origin: origin }),
          ...headers,
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status === 429 || status >= 500) {
          stop(
            `HTTP ${status} from ${path.replace(/0x[a-fA-F0-9]{40}/g, "[wallet]")}`,
          );
          finish(new Error(abortReason));
          return;
        }
        res.on("data", (chunk) => {
          size += chunk.length;
          bytes += chunk.length;
          if (size > 2 * 1024 * 1024 || bytes > plan.bodyByteCap) {
            stop("Response byte limit reached");
            finish(new Error(abortReason));
            return;
          }
          if (!stream) chunks.push(chunk);
        });
        const result = () => {
          const h = res.headers;
          let json = null,
            bodyHash = null;
          if (!stream && status !== 304 && method !== "HEAD") {
            const raw = Buffer.concat(chunks),
              body =
                h["content-encoding"] === "gzip"
                  ? gunzipSync(raw, { maxOutputLength: 2 * 1024 * 1024 })
                  : raw;
            if (h["content-encoding"] && h["content-encoding"] !== "gzip")
              throw new Error("Unexpected content encoding");
            if (body.length) {
              json = JSON.parse(body.toString("utf8"));
              bodyHash = createHash("sha256").update(body).digest("hex");
            }
          }
          const row = {
            path: path.replace(/0x[a-fA-F0-9]{40}/g, "[retained-wallet]"),
            origin,
            encoding,
            method,
            status,
            atMs: at - started,
            durationMs: Date.now() - at,
            bytes: size,
            cfCacheStatus: h["cf-cache-status"] ?? null,
            age: h.age ?? null,
            cdnCacheControl: h["cdn-cache-control"] ?? null,
            cacheControl: h["cache-control"] ?? null,
            vary: h.vary ?? null,
            allowOrigin: h["access-control-allow-origin"] ?? null,
            etag: h.etag ?? null,
            contentEncoding: h["content-encoding"] ?? null,
            bodyHash,
          };
          rows.push(row);
          return { row, json, headers: h };
        };
        if (stream) {
          clearTimeout(timer);
          timer = setTimeout(() => {
            try {
              const value = result();
              finish(null, value);
              req.destroy();
            } catch (error) {
              finish(error);
              req.destroy();
            }
          }, plan.sseDurationMs);
        }
        res.on("end", () => {
          try {
            finish(null, result());
          } catch (error) {
            finish(error);
          }
        });
        res.on("error", (error) => {
          if (!done) finish(error);
        });
      },
    );
    requests.add(req);
    timer = setTimeout(() => {
      finish(new Error("Request timed out"));
      req.destroy();
    }, plan.requestTimeoutMs);
    req.on("error", (error) => {
      if (!done) finish(error);
    });
    req.end();
  });
}
function noStore(value, label) {
  check(
    value.row.cdnCacheControl === "no-store",
    `${label}: CDN no-store`,
    value.row,
  );
  check(
    !["HIT", "STALE", "UPDATING", "REVALIDATED"].includes(
      value.row.cfCacheStatus,
    ),
    `${label}: not served from shared cache`,
    value.row.cfCacheStatus,
  );
}
function snapshot(value, label) {
  check(value.row.status === 200, `${label}: 200`);
  check(
    value.row.cdnCacheControl === "public, s-maxage=1, must-revalidate",
    `${label}: one-second edge policy`,
  );
  check(
    value.row.cacheControl === "no-cache",
    `${label}: browser revalidation`,
  );
  check(
    value.row.vary?.toLowerCase().includes("origin") &&
      value.row.vary?.toLowerCase().includes("accept-encoding"),
    `${label}: Vary Origin/encoding`,
  );
  if (value.row.age !== null)
    check(
      Number(value.row.age) <= 1,
      `${label}: Age is at most one second`,
      value.row.age,
    );
}
try {
  // Every path below is served from our retained/cached API; none addresses the exchange.
  for (let round = 0; round < 2; round++) {
    const t = Date.now();
    for (const origin of [...ALLOWED, null, DENIED]) {
      const value = await read("/api/overview", { origin });
      check(value.row.status === 200, `origin round${round}: 200`);
      check(
        value.row.allowOrigin ===
          (origin !== null && ALLOWED.includes(origin) ? origin : null),
        `origin round${round}: exact CORS`,
        value.row,
      );
      if (origin === DENIED) noStore(value, `denied origin round${round}`);
      else snapshot(value, `origin round${round}`);
    }
    timingWindows.push({
      label: `origin round${round}`,
      elapsedMs: Date.now() - t,
      withinOneSecond: Date.now() - t <= 1000,
    });
  }
  const identity = await read("/api/overview");
  snapshot(identity, "identity");
  const gzip = await read("/api/overview", { encoding: "gzip" });
  snapshot(gzip, "gzip");
  check(
    Boolean(
      identity.json &&
        gzip.json &&
        Array.isArray(identity.json.history) &&
        Array.isArray(gzip.json.history),
    ),
    "identity/gzip both decode expected JSON",
  );
  notes.push({
    label: "Representation comparison",
    sameDecodedBody: identity.row.bodyHash === gzip.row.bodyHash,
    explanation:
      "Different bodies can be valid if a newer collector snapshot arrived between requests.",
  });
  let conditional = await read("/api/overview", {
    encoding: "gzip",
    headers: { "If-None-Match": gzip.row.etag ?? "" },
  });
  if (
    conditional.row.status === 200 &&
    conditional.row.etag &&
    conditional.row.etag !== gzip.row.etag
  ) {
    notes.push({
      label: "Conditional race",
      explanation:
        "Collector snapshot changed; testing one immediate conditional request against its new ETag.",
    });
    conditional = await read("/api/overview", {
      encoding: "gzip",
      headers: { "If-None-Match": conditional.row.etag },
    });
  }
  check(
    conditional.row.status === 304,
    "ETag revalidation returns 304",
    conditional.row,
  );
  check(conditional.row.bytes === 0, "304 response is empty");
  await sleep(1250);
  const expired = await read("/api/overview");
  snapshot(expired, "after 1.25s");
  notes.push({
    label: "Expiry observation",
    previousEtag: gzip.row.etag,
    etagChanged: expired.row.etag !== gzip.row.etag,
    cacheStatus: expired.row.cfCacheStatus,
    age: expired.row.age,
    explanation:
      "Other visitors may refill an expired key; HIT alone does not prove stale service or an origin revalidation.",
  });
  for (const path of [
    "/api/assets",
    "/api/assets/0/market",
    "/api/assets/1/market",
    "/api/house",
    "/api/position-metrics",
    "/api/liquidations/stats",
  ])
    snapshot(await read(path), path);
  for (const path of [
    "/api/overview?edge_validation=1",
    "/api/assets/0/market?range=1h",
    "/api/liquidations/stats?instrument=0",
    "/health/ready",
    "/api/edge-cache-validation-not-found",
    "/api/assets/2/market",
    "/api/indexing",
    "/api/liquidations?cursor=invalid",
  ])
    noStore(await read(path), path);
  const preflight = await read("/api/overview", {
    method: "OPTIONS",
    headers: { "Access-Control-Request-Method": "GET" },
  });
  noStore(preflight, "OPTIONS");
  if (wallet) {
    for (const suffix of ["position-metrics", "cashflows", "trades"])
      noStore(
        await read(`/api/wallets/${wallet.toLowerCase()}/${suffix}`),
        `retained wallet ${suffix}`,
      );
  } else
    notes.push({
      label: "Wallet checks skipped",
      reason:
        "No known retained wallet supplied. Full wallet snapshot endpoint is intentionally never called.",
    });
  await read("/api/overview");
  for (const headers of [
    { Authorization: "Bearer public-cache-behavior-check" },
    { Cookie: "paperdash_cache_check=1" },
  ]) {
    const value = await read("/api/overview", { headers });
    notes.push({
      label: "Credential request after anonymous warm cache",
      credential: Object.keys(headers)[0],
      cacheStatus: value.row.cfCacheStatus,
      cdnCacheControl: value.row.cdnCacheControl,
      originGuardObserved: value.row.cdnCacheControl === "no-store",
      inheritedPublicObject: value.row.cfCacheStatus === "HIT",
      setCookiePresent: Boolean(value.headers["set-cookie"]),
      sensitiveContent: false,
      explanation:
        "A cached anonymous public snapshot can bypass origin response-header guards. This is observation, not a guaranteed edge bypass.",
    });
    check(
      value.row.status === 200,
      "credential request remains a public snapshot",
    );
    check(
      !value.headers["set-cookie"],
      "credential check does not set a cookie",
    );
    check(
      Boolean(
        value.json &&
          Array.isArray(value.json.history) &&
          Array.isArray(value.json.trades),
      ),
      "credential check retains the anonymous overview schema",
    );
  }
  const stream = await read("/api/events?topics=overview", { stream: true });
  noStore(stream, "SSE");
  check(stream.row.cacheControl?.includes("no-store"), "SSE browser no-store");
  check(
    stream.headers["content-type"]?.startsWith("text/event-stream"),
    "SSE MIME type",
  );
  check(stream.row.allowOrigin === ALLOWED[0], "SSE exact CORS");
} catch (error) {
  stop(error instanceof Error ? error.message : "Validation failed");
} finally {
  stopped = true;
  clearTimeout(deadline);
  for (const req of requests) req.destroy();
  agent.destroy();
  const report = {
    startedAt: new Date(started).toISOString(),
    endedAt: new Date().toISOString(),
    passed: !abortReason && checks.every((c) => c.passed),
    abortReason,
    plan,
    requests: requestCount,
    responseBytes: bytes,
    timingWindows,
    checks,
    rows,
    notes,
    edgeHitObserved: rows.some((r) => r.cfCacheStatus === "HIT"),
    caveats: [
      "Low-volume single-region validation, not a capacity test",
      "No upstream URLs or full wallet snapshot refreshes",
      "Headers/local tests cannot prove provider cache-key policy; inspect actual CORS and encoding results",
      "Credential requests may inherit anonymous public cache hits; guaranteed bypass is not claimed",
      "Concurrent users may refill entries during the expiry interval",
    ],
  };
  const json = JSON.stringify(report, null, 2);
  console.log(json);
  if (output) await writeFile(output, json + "\n", { flag: "wx" });
  process.exitCode = report.passed ? 0 : 1;
}
