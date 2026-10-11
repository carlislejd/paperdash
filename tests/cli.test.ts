import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  DEFAULT_BASE_URL,
  POSITION_COLUMNS,
  parseArgs,
  requestJson,
  retryAfterMs,
  runCli,
} from "../scripts/paperdash.mjs";

const wallet = "0x1234567890123456789012345678901234567890";
const response = (body: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers });
function output() {
  const stdout = vi.fn(),
    stderr = vi.fn();
  return {
    stdout,
    stderr,
    env: {},
    text: () => stdout.mock.calls.map(([s]) => s).join(""),
    error: () => JSON.parse(stderr.mock.calls.at(-1)?.[0] ?? "{}"),
  };
}

describe("public CLI arguments and command contracts", () => {
  it("uses the public API by default and supports explicit URL precedence and prefixes", () => {
    expect(parseArgs(["overview"], {}).url).toBe(
      `${DEFAULT_BASE_URL}/api/overview`,
    );
    expect(
      parseArgs(["overview"], { PAPERDASH_API_URL: "http://localhost:8787" })
        .url,
    ).toBe("http://localhost:8787/api/overview");
    expect(
      parseArgs(["overview", "--base-url", "https://api.example/proxy/"], {
        PAPERDASH_API_URL: "https://other.example",
      }).url,
    ).toBe("https://api.example/proxy/api/overview");
  });
  it.each([
    ["wallet"],
    ["wallet", "0x123"],
    ["overview", "extra"],
    ["unknown"],
    ["wallets", "--page", "1.5"],
    ["wallets", "--page", "1000001"],
    ["overview", "--metric", "pnl"],
    ["overview", "--retries", "4"],
    ["wallets", "--page"],
    ["wallets", "--page=1", "--page=2"],
    ["overview", "--base-url", "https://user:password@api.example"],
    ["overview", "--base-url", "https://api.example/?token=secret"],
    ["overview", "--base-url", "file:///tmp/data"],
    ["assets", "DOGE"],
    ["wallet", wallet, "--cursor", "abc"],
    ["wallet", wallet, "--history", "all"],
    ["leaderboard", "--metric", "volume", "--q", "Alice"],
  ])(
    "rejects invalid arguments without sending a request: %j",
    async (...args) => {
      const io = output(),
        fetch = vi.fn();
      expect(await runCli(args, { ...io, fetch })).toBe(2);
      expect(fetch).not.toHaveBeenCalled();
      expect(io.text()).toBe("");
      expect(io.error().error.code).toBe("invalid_arguments");
    },
  );
  it("encodes cursors and never mistakes query text for executable arguments", () => {
    const plan = parseArgs(
      [
        "wallet",
        wallet.toUpperCase().replace("0X", "0x"),
        "--history",
        "cashflows",
        "--cursor",
        "a+/b?x=2&y=3",
      ],
      {},
    );
    const url = new URL(plan.url);
    expect(url.pathname).toBe(`/api/wallets/${wallet}/cashflows`);
    expect(url.searchParams.get("cursor")).toBe("a+/b?x=2&y=3");
    expect(
      new URL(
        parseArgs(["wallets", "--q", "$(echo hello)"], {}).url,
      ).searchParams.get("q"),
    ).toBe("$(echo hello)");
  });
  it("maps paged directory, rolling leaderboard and asset requests exactly", () => {
    expect(
      parseArgs(["wallets", "--page", "2", "--sort", "currentOpenNotional"], {})
        .url,
    ).toBe(`${DEFAULT_BASE_URL}/api/accounts?page=2&sort=currentOpenNotional`);
    expect(
      parseArgs(
        ["wallets", "--sort", "currentUnrealizedPnl", "--page", "1"],
        {},
      ).url,
    ).toBe(`${DEFAULT_BASE_URL}/api/accounts?page=1&sort=currentUnrealizedPnl`);
    expect(
      parseArgs(["leaderboard", "--metric", "trades", "--q", "0xab"], {}).url,
    ).toBe(`${DEFAULT_BASE_URL}/api/leaderboard?page=0&metric=trades&q=0xab`);
    expect(parseArgs(["assets", "eth"], {}).url).toBe(
      `${DEFAULT_BASE_URL}/api/assets/1/market`,
    );
    expect(parseArgs(["house"], {}).url).toBe(`${DEFAULT_BASE_URL}/api/house`);
    expect(
      parseArgs(
        ["liquidations", "--asset", "ETH", "--cursor", "opaque+/cursor"],
        {},
      ).url,
    ).toBe(
      `${DEFAULT_BASE_URL}/api/liquidations?instrument=1&cursor=opaque%2B%2Fcursor`,
    );
  });
  it("prints help without consulting network or invalid API environment", async () => {
    const io = output(),
      fetch = vi.fn();
    expect(
      await runCli(["--help"], {
        ...io,
        fetch,
        env: { PAPERDASH_API_URL: "bad" },
      }),
    ).toBe(0);
    expect(io.text()).toContain("Paperclub public, read-only CLI");
    expect(io.text()).toContain("Raw money/token strings");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("CLI data fidelity and freshness", () => {
  const summary = {
    balances: { tvl: "123456789012345678901234567890" },
    activity: { open: 1166 },
    source: { block: "48177844", at: 1791644716000 },
  };
  const status = {
    stale: false,
    receivedAt: 1791644716387,
    stream: "connected",
  };
  it("returns exact TVL strings and source metadata without Number conversion", async () => {
    const io = output(),
      fetch = vi.fn(async () => response({ summary, status }));
    expect(await runCli(["tvl", "--require-fresh"], { ...io, fetch })).toBe(0);
    expect(JSON.parse(io.text()).data).toEqual({
      tvlRaw: summary.balances.tvl,
      decimals: 18,
      currency: "USD",
      source: summary.source,
      status,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: "GET",
      redirect: "error",
    });
  });
  it("preserves account pagination, partial coverage and arbitrarily large raw values", async () => {
    const io = output();
    const data = {
      accounts: [{ address: wallet, currentBalance: "9".repeat(78) }],
      count: 9000,
      pageInfo: { page: 3, totalPages: 360 },
      stale: false,
      coverage: { partial: true },
    };
    const fetch = vi.fn(async () => response(data));
    expect(await runCli(["wallets", "--page", "3"], { ...io, fetch })).toBe(0);
    expect(JSON.parse(io.text()).data).toEqual(data);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("labels global positions as a count and wallet positions with verified wire columns", async () => {
    const global = output();
    await runCli(["positions"], {
      ...global,
      fetch: async () => response({ summary, status }),
    });
    expect(JSON.parse(global.text()).data).toMatchObject({
      scope: "global-count",
      openPositionCount: 1166,
      status,
    });
    const tuple = [
      "195",
      1,
      false,
      true,
      "249715",
      "10000000000000000000",
      1000,
      "249965",
      1791640909000,
      `0x${"a".repeat(64)}`,
    ];
    const io = output();
    await runCli(["positions", wallet], {
      ...io,
      fetch: async () =>
        response({
          address: wallet,
          snapshot: {
            openPositions: [tuple],
            indexedThroughTimestamp: 1791640909,
            indexedThroughBlock: 48177844,
            accountRevision: 12,
          },
          receivedAt: 1791640910000,
          stale: false,
          errors: [],
        }),
    });
    const data = JSON.parse(io.text()).data;
    expect(data.positions).toEqual([tuple]);
    expect(data.columns).toEqual(POSITION_COLUMNS);
    expect(data.columns[3]).toBe("useDebt");
    expect(data.columns[7]).toBe("bustPriceRaw");
    expect(data.columns[9]).toBe("intentId");
    expect(data.source.indexedThroughTimestamp).toBe(1791640909);
  });
  it.each([
    ["tvl", { summary, status: { ...status, stale: true } }],
    ["overview", { summary: null, status }],
    ["health", { ready: true, degraded: true, status }],
    ["wallets", { accounts: [], stale: false, error: "Source failed" }],
  ])(
    "keeps results visible while --require-fresh exits 3 for %s",
    async (command, data) => {
      const io = output();
      expect(
        await runCli([command, "--require-fresh"], {
          ...io,
          fetch: async () => response(data),
        }),
      ).toBe(3);
      expect(JSON.parse(io.text()).data).toBeDefined();
      expect(io.error().error.code).toBe("data_not_fresh");
    },
  );
  it("does not turn stale data into a transport error by default", async () => {
    const io = output();
    expect(
      await runCli(["assets"], {
        ...io,
        fetch: async () => response({ assets: [], stale: true }),
      }),
    ).toBe(0);
    expect(JSON.parse(io.text()).data.stale).toBe(true);
    expect(io.stderr).not.toHaveBeenCalled();
  });
  it("preserves house precision and partial liquidation statistics without reformatting", async () => {
    for (const [command, data] of [
      [
        "house",
        {
          house: { fundsRaw: "-3765036346841189300000000" },
          sourceAt: 1791644716387,
          summarySourceAt: 1791644716000,
          stale: false,
          coverage: { approximate: true, partial: true },
        },
      ],
      [
        "liquidations",
        {
          items: [],
          nextCursor: "opaque",
          stats: { hour: { count: 1, notionalUsd: 10000000000 } },
          stale: false,
          coverage: { partial: true, projectionBackfillComplete: false },
        },
      ],
    ] as const) {
      const io = output();
      expect(
        await runCli([command, "--require-fresh"], {
          ...io,
          fetch: async () => response(data),
        }),
      ).toBe(0);
      expect(JSON.parse(io.text()).data).toEqual(data);
    }
  });
});

describe("CLI bounded request behavior", () => {
  const config = parseArgs(["overview"], {});
  it("respects Retry-After seconds before a bounded retry", async () => {
    let now = 1000;
    const sleep = vi.fn(async (ms) => {
      now += ms;
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({ error: "Slow down" }, 429, { "Retry-After": "3" }),
      )
      .mockResolvedValueOnce(response({ stale: false }));
    expect(await requestJson(config, { fetch, sleep, now: () => now })).toEqual(
      { stale: false },
    );
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("reports a long cooldown immediately and never retries earlier than requested", async () => {
    const io = output(),
      sleep = vi.fn();
    const fetch = vi.fn(async () =>
      response({ error: "Slow down" }, 429, { "Retry-After": "120" }),
    );
    expect(await runCli(["overview"], { ...io, fetch, sleep })).toBe(1);
    expect(io.error().error).toMatchObject({
      code: "rate_limited",
      status: 429,
      retryAfterMs: 120000,
      attempts: 1,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(io.text()).toBe("");
  });
  it("parses HTTP-date Retry-After and ignores malformed values", () => {
    expect(
      retryAfterMs(
        "Wed, 21 Oct 2015 07:28:00 GMT",
        Date.parse("Wed, 21 Oct 2015 07:27:50 GMT"),
      ),
    ).toBe(10000);
    expect(retryAfterMs("not-a-date", 0)).toBeNull();
    expect(retryAfterMs("999999999999999999999", 0)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
  it("bounds network retries and does not expose incidental exception text", async () => {
    const io = output(),
      fetch = vi.fn(async () => {
        throw new Error("secret internal details");
      });
    expect(
      await runCli(["overview", "--retries", "2"], {
        ...io,
        fetch,
        sleep: async () => {},
      }),
    ).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(io.error().error).toMatchObject({
      code: "network_error",
      attempts: 3,
    });
    expect(JSON.stringify(io.error())).not.toContain("secret");
  });
  it("never retries a nonretryable HTTP refusal and preserves readiness failure details", async () => {
    const io = output(),
      fetch = vi.fn(async () => response({ error: "Forbidden" }, 403));
    expect(await runCli(["overview"], { ...io, fetch })).toBe(1);
    expect(fetch).toHaveBeenCalledOnce();
    expect(io.error().error.status).toBe(403);
    const health = output();
    expect(
      await runCli(["health", "--retries", "0"], {
        ...health,
        fetch: async () =>
          response({ ready: false, reason: "storage_unavailable" }, 503),
      }),
    ).toBe(1);
    expect(health.error().error.response).toEqual({
      ready: false,
      reason: "storage_unavailable",
    });
  });
  it("rejects successful HTML/primitive responses and oversized bodies", async () => {
    for (const res of [
      new Response("<html>Login</html>"),
      response(null),
      response([]),
      response({ ok: true }, 200, {
        "Content-Length": String(9 * 1024 * 1024),
      }),
    ]) {
      const io = output(),
        fetch = vi.fn(async () => res);
      expect(await runCli(["overview"], { ...io, fetch })).toBe(1);
      expect(fetch).toHaveBeenCalledOnce();
      expect(io.text()).toBe("");
    }
  });
  it("times out the whole body read, not only the initial response", async () => {
    vi.useFakeTimers();
    try {
      const io = output();
      const fetch = vi.fn(
        async (_url, { signal }) =>
          new Response(
            new ReadableStream({
              start(controller) {
                signal.addEventListener(
                  "abort",
                  () =>
                    controller.error(new DOMException("Aborted", "AbortError")),
                  { once: true },
                );
              },
            }),
          ),
      );
      const run = runCli(
        ["overview", "--timeout-ms", "100", "--retries", "0"],
        { ...io, fetch },
      );
      await vi.advanceTimersByTimeAsync(101);
      expect(await run).toBe(1);
      expect(io.error().error.code).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });
  it("enforces total deadline instead of granting every retry a full new budget", async () => {
    let now = 0;
    const fetch = vi.fn(async () => {
      now += 9000;
      return response({ error: "busy" }, 503);
    });
    const sleep = vi.fn(async (ms) => {
      now += ms;
    });
    await expect(
      requestJson(
        { ...config, maxWaitMs: 10000 },
        { fetch, sleep, now: () => now },
      ),
    ).rejects.toMatchObject({ code: "http_error" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
  it("is executable without build steps or repository imports", async () => {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [
      "scripts/paperdash.mjs",
      "--help",
    ]);
    expect(stdout).toContain("public, read-only CLI");
    expect(stderr).toBe("");
    await expect(
      promisify(execFile)(process.execPath, [
        "scripts/paperdash.mjs",
        "no-such-command",
      ]),
    ).rejects.toMatchObject({ code: 2 });
  });
  it("runs through symlinks without executing when imported by another module", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paperclub-cli-"));
    try {
      const linkedCli = join(directory, "paperclub public.mjs");
      await symlink(resolve("scripts/paperdash.mjs"), linkedCli);
      const help = await promisify(execFile)(process.execPath, [
        linkedCli,
        "--help",
      ]);
      expect(help.stdout).toContain("Paperclub public, read-only CLI");
      expect(help.stderr).toBe("");

      const importer = join(directory, "importer.mjs");
      await writeFile(
        importer,
        `globalThis.fetch = () => { throw new Error("Unexpected network call"); };
await import(${JSON.stringify(pathToFileURL(linkedCli).href)});
console.log("imported without running");\n`,
      );
      const imported = await promisify(execFile)(process.execPath, [
        importer,
        "--help",
      ]);
      expect(imported.stdout).toBe("imported without running\n");
      expect(imported.stderr).toBe("");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
