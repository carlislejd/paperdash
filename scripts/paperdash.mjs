#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

export const DEFAULT_BASE_URL = "https://paperdash-api.onrender.com";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SORTS = [
  "currentBalance",
  "currentUnrealizedPnl",
  "lastActiveTs",
  "totalWindowedPnl",
  "realizedPnl",
  "totalVolume",
  "currentOpenNotional",
];
const GLOBAL_FLAGS = [
  "base-url",
  "timeout-ms",
  "max-wait-ms",
  "retries",
  "pretty",
  "json",
  "require-fresh",
];
const COMMAND_FLAGS = {
  tvl: [],
  overview: [],
  wallets: ["page", "sort", "q"],
  watchlist: [],
  wallet: ["history", "cursor"],
  positions: [],
  assets: [],
  leaderboard: ["metric", "page", "q"],
  house: [],
  liquidations: ["asset", "cursor"],
  indexing: [],
  health: [],
};
const BOOL_FLAGS = new Set(["pretty", "json", "require-fresh", "help"]);
export const HELP = `Paperclub public, read-only CLI (Node.js 24+)

Usage: node paperclub.mjs COMMAND [ARGUMENT] [OPTIONS]
From the repository: node scripts/paperdash.mjs COMMAND [ARGUMENT] [OPTIONS]

Commands:
  tvl                         Exact raw TVL, source and freshness
  overview                    Protocol summary, recent observations and history
  wallets                     One page of the public account directory
    --page N --sort KEY --q SEARCH
  watchlist ADDRESSES          Retained summaries and recent activity for 1..25 wallets
    Comma-separated addresses; one request, no saved list or watch loop
  wallet ADDRESS              Snapshot and first retained-history pages
    --history cashflows|trades [--cursor CURSOR]
  positions [ADDRESS]         Wallet open positions; without address, global count
  assets [BTC|ETH|0|1]         Asset summaries; with asset, recent price/trade view
  leaderboard                 Rolling 24h ranking, one page
    --metric pnl|volume|trades --page N --q SEARCH
  house                       House Funds, PAPER and retained house history
  liquidations                Observed liquidations with rolling 1h/24h totals
    --asset BTC|ETH|0|1 --cursor CURSOR
  indexing                    Saved collector/backfill coverage
  health                      API readiness (may report degraded collection)

Global options:
  --base-url URL               API origin/prefix; overrides PAPERDASH_API_URL
  --timeout-ms N               Per-attempt timeout, 100..60000 (default 10000)
  --max-wait-ms N              Whole request budget, 100..120000 (default 30000)
  --retries N                 Additional attempts, 0..3 (default 1)
  --require-fresh              Exit 3 if data is stale, degraded or unavailable
  --pretty                    Indent JSON output
  --json                      JSON output (already the default)
  --help                      Show help without making a request

Default API: ${DEFAULT_BASE_URL}
Directory sort keys: ${SORTS.join(", ")}
Pages are zero-based. Requests never crawl later pages automatically.
Raw money/token strings retain source precision (18 decimals where documented).
USD numbers from public observations remain approximate. Coverage is preserved.
Global positions is a count, not a complete list of every wallet's open positions.
Stdout: one JSON result. Stderr: JSON errors. Exit: 0 success, 1 request failure,
2 invalid arguments, 3 --require-fresh failed (result still on stdout).
`;

export class CliError extends Error {
  constructor(code, message, details = {}, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}
const invalid = (message) => {
  throw new CliError("invalid_arguments", message, {}, 2);
};
function integer(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < min ||
    Number(value) > max
  )
    invalid(`--${name} must be an integer from ${min} to ${max}.`);
  return Number(value);
}
function address(value) {
  if (!ADDRESS.test(value ?? ""))
    invalid("Supply a complete 0x wallet address (40 hexadecimal characters).");
  return value.toLowerCase();
}
export function parseArgs(argv, env = process.env) {
  const options = {},
    positionals = [];
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === "-h") arg = "--help";
    if (!arg.startsWith("--")) {
      if (arg.startsWith("-")) invalid(`Unknown option: ${arg}`);
      positionals.push(arg);
      continue;
    }
    const split = arg.indexOf("=");
    const key = arg.slice(2, split < 0 ? undefined : split);
    if (
      !(
        GLOBAL_FLAGS.includes(key) ||
        BOOL_FLAGS.has(key) ||
        Object.values(COMMAND_FLAGS).flat().includes(key)
      )
    )
      invalid(`Unknown option: --${key}`);
    if (Object.hasOwn(options, key)) invalid(`Duplicate option: --${key}`);
    if (BOOL_FLAGS.has(key)) {
      if (split >= 0) invalid(`--${key} does not take a value.`);
      options[key] = true;
    } else {
      const value = split < 0 ? argv[++i] : arg.slice(split + 1);
      if (value === undefined || value.startsWith("--") || value === "")
        invalid(`--${key} requires a value.`);
      options[key] = value;
    }
  }
  if (options.help || positionals[0] === "help" || !argv.length)
    return { help: true };
  const [command, argument, ...extra] = positionals;
  if (!Object.hasOwn(COMMAND_FLAGS, command ?? ""))
    invalid("Unknown command. Use --help to list commands.");
  if (
    extra.length ||
    (argument !== undefined &&
      !["wallet", "positions", "assets", "watchlist"].includes(command))
  )
    invalid(`Unexpected argument for ${command}.`);
  for (const key of Object.keys(options))
    if (!GLOBAL_FLAGS.includes(key) && !COMMAND_FLAGS[command].includes(key))
      invalid(`--${key} is not valid for ${command}.`);
  let base;
  try {
    base = new URL(
      options["base-url"] ?? env.PAPERDASH_API_URL ?? DEFAULT_BASE_URL,
    );
  } catch {
    invalid("The API base URL is invalid.");
  }
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    invalid(
      "The API base URL must be HTTP(S), without credentials, query or fragment.",
    );
  const query = new URLSearchParams();
  let path;
  if (
    command === "tvl" ||
    command === "overview" ||
    (command === "positions" && argument === undefined)
  )
    path = "/api/overview";
  if (command === "indexing") path = "/api/indexing";
  if (command === "house") path = "/api/house";
  if (command === "liquidations") {
    path = "/api/liquidations";
    if (options.asset) {
      const instrument = { BTC: 0, ETH: 1, 0: 0, 1: 1 }[
        options.asset.toUpperCase()
      ];
      if (instrument === undefined)
        invalid("--asset must be BTC, ETH, 0 or 1.");
      query.set("instrument", String(instrument));
    }
    if (options.cursor) {
      if (options.cursor.length > 1024)
        invalid("--cursor must have at most 1024 characters.");
      query.set("cursor", options.cursor);
    }
  }
  if (command === "health") path = "/health/ready";
  if (command === "watchlist") {
    const entries = (argument ?? "").split(",");
    if (entries.length > 25)
      invalid("watchlist accepts at most 25 comma-separated addresses.");
    const addresses = [
      ...new Set(entries.map((value) => address(value.trim()))),
    ].sort();
    path = "/api/wallets/batch";
    query.set("addresses", addresses.join(","));
  }
  if (command === "wallets" || command === "leaderboard") {
    path = command === "wallets" ? "/api/accounts" : "/api/leaderboard";
    query.set("page", String(integer(options.page, 0, 0, 1000000, "page")));
    const q = options.q?.trim() ?? "";
    if (q.length > 42) invalid("--q must have at most 42 characters.");
    if (command === "wallets") {
      const sort = options.sort ?? "currentBalance";
      if (!SORTS.includes(sort))
        invalid(`Unsupported --sort. Choose ${SORTS.join(", ")}.`);
      query.set("sort", sort);
    } else {
      const metric = options.metric ?? "pnl";
      if (!["pnl", "volume", "trades"].includes(metric))
        invalid("--metric must be pnl, volume or trades.");
      if (metric !== "pnl" && !/^(?:0x)?[a-f0-9]{0,40}$/i.test(q))
        invalid("Volume/trade rankings accept an address prefix for --q.");
      query.set("metric", metric);
    }
    if (q) query.set("q", q);
  }
  if (
    command === "wallet" ||
    (command === "positions" && argument !== undefined)
  ) {
    path = `/api/wallets/${address(argument)}`;
    if (options.history) {
      if (!["cashflows", "trades"].includes(options.history))
        invalid("--history must be cashflows or trades.");
      path += `/${options.history}`;
    }
    if (options.cursor) {
      if (!options.history) invalid("--cursor requires --history.");
      if (options.cursor.length > 2048)
        invalid("--cursor must have at most 2048 characters.");
      query.set("cursor", options.cursor);
    }
  }
  if (command === "assets") {
    path = "/api/assets";
    if (argument !== undefined) {
      const instrument = { BTC: 0, ETH: 1, 0: 0, 1: 1 }[argument.toUpperCase()];
      if (instrument === undefined)
        invalid("The asset must be BTC, ETH, 0 or 1.");
      path += `/${instrument}/market`;
    }
  }
  return {
    command,
    argument,
    history: options.history,
    pretty: Boolean(options.pretty),
    requireFresh: Boolean(options["require-fresh"]),
    url: base.href.replace(/\/$/, "") + path + (query.size ? `?${query}` : ""),
    timeoutMs: integer(options["timeout-ms"], 10000, 100, 60000, "timeout-ms"),
    maxWaitMs: integer(
      options["max-wait-ms"],
      30000,
      100,
      120000,
      "max-wait-ms",
    ),
    retries: integer(options.retries, 1, 0, 3, "retries"),
  };
}

export function retryAfterMs(value, now = Date.now()) {
  if (!value) return null;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const result = Math.ceil(Number(text) * 1000);
    return Number.isSafeInteger(result) ? result : Number.MAX_SAFE_INTEGER;
  }
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}
async function readJson(response) {
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new CliError(
      "response_too_large",
      "The API response exceeded 8 MiB.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw new CliError(
      "invalid_response",
      "The API returned an empty response.",
    );
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new CliError(
        "response_too_large",
        "The API response exceeded 8 MiB.",
      );
    }
    chunks.push(value);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error();
    return body;
  } catch {
    throw new CliError(
      "invalid_response",
      "The API did not return a JSON object.",
    );
  }
}
export async function requestJson(config, dependencies = {}) {
  const fetcher = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.sleep ?? sleep;
  const deadline = now() + config.maxWaitMs;
  let lastError;
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 0)
      throw (
        lastError ?? new CliError("timeout", "The request time budget expired.")
      );
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(config.timeoutMs, remaining),
    );
    let retry = false,
      delay = Math.min(1000 * 2 ** attempt, 8000);
    try {
      const response = await fetcher(config.url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": "paperdash-cli/1.0",
        },
      });
      if (!response.ok) {
        const retryMs = retryAfterMs(
          response.headers.get("retry-after"),
          now(),
        );
        let body;
        try {
          body = await readJson(response);
        } catch {
          /* HTML errors still preserve HTTP status. */
        }
        const serverMessage =
          typeof body?.error === "string"
            ? body.error.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300)
            : null;
        lastError = new CliError(
          response.status === 429 ? "rate_limited" : "http_error",
          serverMessage ?? `API returned HTTP ${response.status}.`,
          {
            status: response.status,
            attempts: attempt + 1,
            ...(retryMs === null ? {} : { retryAfterMs: retryMs }),
            ...(body ? { response: body } : {}),
          },
        );
        retry = RETRYABLE.has(response.status);
        if (retryMs !== null) delay = Math.max(delay, retryMs);
      } else {
        return await readJson(response);
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
      lastError = new CliError(
        controller.signal.aborted ? "timeout" : "network_error",
        controller.signal.aborted
          ? "The API request timed out."
          : "Unable to read the API response.",
        { attempts: attempt + 1 },
      );
      retry = true;
    } finally {
      clearTimeout(timer);
    }
    if (!retry || attempt >= config.retries || delay >= deadline - now())
      throw lastError;
    await wait(delay);
  }
  throw lastError;
}

export const POSITION_COLUMNS = [
  "positionId",
  "instrumentId",
  "isLong",
  "useDebt",
  "entryPriceRaw",
  "marginRaw",
  "leverage",
  "bustPriceRaw",
  "openedAtMs",
  "intentId",
];
export function selectData(config, body) {
  if (config.command === "tvl")
    return {
      tvlRaw: body.summary?.balances?.tvl ?? null,
      decimals: 18,
      currency: "USD",
      source: body.summary?.source ?? null,
      status: body.status ?? null,
    };
  if (config.command === "positions") {
    if (config.argument === undefined)
      return {
        scope: "global-count",
        openPositionCount: body.summary?.activity?.open ?? null,
        source: body.summary?.source ?? null,
        status: body.status ?? null,
      };
    const snapshot = body.snapshot;
    return {
      scope: "wallet-open-positions",
      address: body.address,
      positions: snapshot?.openPositions ?? null,
      columns: POSITION_COLUMNS,
      source: snapshot
        ? {
            indexedThroughBlock: snapshot.indexedThroughBlock,
            indexedThroughTimestamp: snapshot.indexedThroughTimestamp,
            accountRevision: snapshot.accountRevision,
          }
        : null,
      receivedAt: body.receivedAt,
      stale: body.stale,
      errors: body.errors,
      units: {
        entryPriceRaw: "instrument-scaled integer: BTC / 10, ETH / 100 for USD",
        bustPriceRaw: "same instrument scale as entryPriceRaw",
        marginRaw: "USD with 18 decimals",
        openedAtMs: "Unix milliseconds",
        indexedThroughTimestamp: "Unix seconds",
      },
    };
  }
  return body;
}
export function isFresh(config, body) {
  if (
    body.stale === true ||
    body.status?.stale === true ||
    body.degraded === true ||
    body.ready === false ||
    body.error ||
    body.errors?.length
  )
    return false;
  if (
    ["overview", "tvl"].includes(config.command) ||
    (config.command === "positions" && config.argument === undefined)
  )
    return Boolean(body.summary) && body.status?.stale === false;
  if (
    (config.command === "wallet" && !config.history) ||
    (config.command === "positions" && config.argument !== undefined)
  )
    return Boolean(body.snapshot) && body.stale === false;
  if (config.command === "health")
    return body.ready === true && body.degraded === false;
  if (config.command === "watchlist")
    return (
      body.stale === false &&
      body.activity?.stale === false &&
      Array.isArray(body.rows) &&
      body.rows.length > 0 &&
      body.rows.every(
        (row) => row.account !== null && row.account !== undefined && row.stale === false,
      )
    );
  return body.stale === false;
}
export async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const stdout = dependencies.stdout ?? ((line) => process.stdout.write(line));
  const stderr = dependencies.stderr ?? ((line) => process.stderr.write(line));
  try {
    const config = parseArgs(argv, dependencies.env ?? process.env);
    if (config.help) {
      stdout(HELP);
      return 0;
    }
    const body = await requestJson(config, dependencies);
    stdout(
      JSON.stringify(
        {
          command: config.command,
          url: config.url,
          fetchedAt: (dependencies.now ?? Date.now)(),
          data: selectData(config, body),
        },
        null,
        config.pretty ? 2 : undefined,
      ) + "\n",
    );
    if (config.requireFresh && !isFresh(config, body))
      throw new CliError(
        "data_not_fresh",
        "The result is stale, degraded or unavailable. Inspect the result's source and coverage metadata.",
        {},
        3,
      );
    return 0;
  } catch (error) {
    const failure =
      error instanceof CliError
        ? error
        : new CliError("request_failed", "Unable to complete the request.");
    stderr(
      JSON.stringify({
        error: {
          code: failure.code,
          message: failure.message,
          ...failure.details,
        },
      }) + "\n",
    );
    return failure.exitCode;
  }
}
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    // Node resolves module symlinks, while argv can retain aliases such as /tmp.
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}
if (isMainModule()) process.exitCode = await runCli();
