import type { Page } from "@playwright/test";
import type { PositionMetricsResponse } from "../../packages/shared/src/position-metrics";
import type {
  Account,
  AccountsResponse,
  AssetsResponse,
  AssetMarketResponse,
  Cashflow,
  LeaderboardResponse,
  Overview,
  WalletResponse,
} from "../../packages/shared/src/types";

// Synthetic, test-only source data. No production module imports these fixtures.
export const WALLET = `0x${"11".repeat(20)}`;
export const SECOND_WALLET = `0x${"22".repeat(20)}`;
const usd = (amount: number) => (BigInt(amount) * 10n ** 18n).toString();

export function account(address: string, name: string): Account {
  return {
    address,
    leaderboardName: name,
    currentBalance: usd(10779),
    currentQueued: "0",
    currentOpenNotional: "0",
    currentOpenPositionCount: 0,
    currentUnrealizedPnl: "0",
    realizedPnl: "0",
    totalVolume: "0",
    totalWindowedPnl: "0",
    paperTotal: "0",
    lastActiveTs: Date.now(),
  };
}

export function overview(stale = false): Overview {
  const at = Date.now() - (stale ? 120_000 : 0);
  return {
    summary: {
      ok: true,
      source: { block: "12345", at },
      balances: {
        tvl: usd(66320000),
        margin: "0",
        lp: usd(66320000),
        reserve: "0",
        queue: "0",
      },
      activity: { volume: "0", open: 0 },
      fees: { pending: "0", lifetime: "0" },
      paper: { supply: "0", staked: "0" },
    },
    accountCount: 5902,
    history: [
      { time: at - 86400000, value: 64000000 },
      { time: at, value: 66320000 },
    ],
    historyCoverage: "upstream",
    trades: [],
    status: {
      receivedAt: at,
      sourceAt: at,
      indexedBlock: "12345",
      stale,
      persistence: "postgres",
      stream: "connected",
    },
  };
}

export function deposit(
  amount: number,
  suffix: string,
  timestampMs = Date.now() - 86400000,
): Cashflow {
  return {
    timestampMs,
    txHash: `0x${suffix.repeat(64)}`,
    amountRaw: usd(amount),
    kind: "Deposit",
    recipientAmountRaw: null,
    route: null,
    withdrawalStatus: null,
  };
}

export function walletResponse(
  address = WALLET,
  at = Date.now(),
): WalletResponse {
  return {
    address,
    snapshot: {
      address,
      indexedThroughBlock: 12345,
      indexedThroughTimestamp: at,
      balance: usd(10779),
      queued: "0",
      locked: "0",
      accountRevision: 3,
      lifetime: {
        depositedRaw: usd(10779),
        withdrawnRaw: "0",
        realizedPnlRaw: "0",
        feesPaidRaw: "0",
        tradedNotionalRaw: "0",
        paperRewardsClaimedRaw: "0",
      },
      paper: { balance: "0", staked: "0" },
      openPositions: [],
    },
    cashflows: {
      items: [deposit(3000, "a", at - 86400000)],
      nextCursor: "older-deposits",
    },
    trades: { items: [], nextCursor: null },
    portfolio: {
      baseTimeMs: at - 86400000,
      timeOffsetsMs: [0, 43200000, 86400000],
      columns: { equity: [3000, 7000, 10779], pnl: [0, 0, 0] },
      gapIndices: [1],
      coverage: {
        availableFromMs: at - 86400000,
        availableToMs: at,
        complete: false,
      },
    },
    receivedAt: at,
    stale: false,
    errors: [],
  };
}

export function assetResponse(stale = false): AssetsResponse {
  const at = Date.now() - (stale ? 120_000 : 0);
  return {
    assets: [0, 1].map((instrument) => ({
      instrument,
      symbol: instrument === 0 ? "BTC" : "ETH",
      openInterest: {
        longRaw: usd(instrument === 0 ? 6000000 : 0),
        shortRaw: usd(instrument === 0 ? 2000000 : 0),
        totalRaw: usd(instrument === 0 ? 8000000 : 0),
        longSharePct: instrument === 0 ? 75 : null,
        shortSharePct: instrument === 0 ? 25 : null,
      },
      activity: {
        instrument,
        windowFrom: at - 86400000,
        windowTo: at,
        counts: {
          total: instrument === 0 ? 3 : 0,
          long: instrument === 0 ? 2 : 0,
          short: instrument === 0 ? 1 : 0,
        },
        notionalUsd: {
          total: instrument === 0 ? 400000 : 0,
          long: instrument === 0 ? 300000 : 0,
          short: instrument === 0 ? 100000 : 0,
        },
        recent:
          instrument === 0
            ? [
                {
                  id: "observed-test-open",
                  ts: at - 30000,
                  wallet: WALLET,
                  instrument: 0,
                  side: "long",
                  leverage: 10,
                  notionalUsd: 200000,
                  kind: "open",
                  pnlUsd: null,
                  provenance: "public-stream",
                },
              ]
            : [],
        coverage: {
          observedFrom: at - 7200000,
          latestObservedAt: at - 30000,
          projectionBackfillComplete: false,
          identityAmbiguous: true,
          source: "retained-public-observations",
        },
      },
      history: [0, 1, 2].map((index) => ({
        instrument,
        time: at - (2 - index) * 60000,
        longRaw: usd(instrument === 0 ? 5000000 + index * 500000 : 0),
        shortRaw: usd(instrument === 0 ? 2000000 : 0),
        sourceBlock: "12345",
        receivedAt: at,
      })),
    })),
    sourceAt: at,
    indexedBlock: null,
    receivedAt: at,
    activityReceivedAt: at,
    stale,
  };
}

export function marketResponse(
  instrument = 0,
  stale = false,
  now = Date.now(),
): AssetMarketResponse {
  const at = now - (stale ? 120_000 : 0);
  const base = instrument === 1 ? 2_500 : 82_000;
  const points = Array.from({ length: 180 }, (_, index) => ({
    time: at - (179 - index) * 5_000,
    priceUsd: base + (Math.sin(index / 12) * 0.0005 + index * 0.000006) * base,
  }));
  return {
    instrument,
    symbol: instrument === 1 ? "ETH" : "BTC",
    price: { priceUsd: points.at(-1)!.priceUsd, sourceAt: at, receivedAt: at },
    points,
    trades: Array.from({ length: 12 }, (_, index) => ({
      id: `market-${instrument}-${index}`,
      ts: at - 5_000 - index * 30_000,
      wallet: index % 2 ? SECOND_WALLET : WALLET,
      instrument,
      side: index % 2 ? ("short" as const) : ("long" as const),
      leverage: 10,
      notionalUsd: 50_000 * (index + 1),
      kind: index % 3 ? ("open" as const) : ("close" as const),
      pnlUsd: index % 3 ? null : 200,
      provenance: "public-stream" as const,
      priceUsd: points[178 - index * 6].priceUsd,
    })),
    windowFrom: at - 3_600_000,
    windowTo: at,
    receivedAt: at,
    stale,
    coverage: {
      source: "retained-market-observations",
      observedFrom: points[0].time,
      partial: true,
      tradesCapped: false,
    },
  };
}

export function leaderboardResponse(
  metric: LeaderboardResponse["metric"] = "pnl",
  page = 0,
  stale = false,
): LeaderboardResponse {
  return {
    window: "24h",
    metric,
    rows: [
      {
        address: page === 0 ? WALLET : SECOND_WALLET,
        leaderboardName: page === 0 ? "Aoi" : "Yuki",
        rank: page * 25 + 1,
        pnlRaw: metric === "pnl" ? usd(page === 0 ? 5001 : -50) : null,
        volumeUsd: metric !== "pnl" ? 3000000 : null,
        tradeCount: metric !== "pnl" ? 23 : null,
      },
    ],
    count: 26,
    pageInfo: { page, totalPages: 2 },
    receivedAt: Date.now(),
    stale,
    coverage: {
      source:
        metric === "pnl"
          ? "papertrade-leaderboard"
          : "retained-public-observations",
      observedFrom: metric === "pnl" ? null : Date.now() - 7200000,
      projectionBackfillComplete: metric === "pnl",
      identityAmbiguous: metric !== "pnl",
    },
  };
}

export function positionMetricsResponse(
  stale = false,
): PositionMetricsResponse {
  return {
    positionCount: 0,
    avgHoldMs: null,
    avgLeverage: null,
    excludedCount: 0,
    updatedAt: Date.now(),
    stale,
    coverage: {
      source: "retained-closed-positions",
      projectionBackfillComplete: true,
      pending: false,
      historyBackfillComplete: null,
      lastHistoryIndexedAt: Date.now(),
      walletsDiscovered: 2,
      totalWallets: 2,
    },
  };
}

export async function mockSources(
  page: Page,
  options: {
    stale?: boolean;
    walletFailure?: boolean;
    missingWalletSnapshot?: boolean;
  } = {},
) {
  const walletDataAt = Date.now();
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/events") {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: ": deterministic test stream\n\n",
      });
      return;
    }
    if (url.pathname === "/api/overview") {
      await route.fulfill({ json: overview(options.stale) });
      return;
    }
    if (url.pathname === "/api/assets") {
      await route.fulfill({ json: assetResponse(options.stale) });
      return;
    }
    const marketMatch = url.pathname.match(/^\/api\/assets\/([01])\/market$/);
    if (marketMatch) {
      await route.fulfill({
        json: marketResponse(Number(marketMatch[1]), options.stale),
      });
      return;
    }
    if (
      url.pathname === "/api/position-metrics" ||
      /^\/api\/wallets\/0x[0-9a-f]{40}\/position-metrics$/i.test(url.pathname)
    ) {
      await route.fulfill({ json: positionMetricsResponse(options.stale) });
      return;
    }
    if (url.pathname === "/api/leaderboard") {
      await route.fulfill({
        json: leaderboardResponse(
          (url.searchParams.get("metric") ||
            "pnl") as LeaderboardResponse["metric"],
          Number(url.searchParams.get("page") || 0),
          options.stale,
        ),
      });
      return;
    }
    if (url.pathname === "/api/accounts") {
      const query = (url.searchParams.get("q") ?? "").toLowerCase();
      const number = Number(url.searchParams.get("page") ?? "0");
      const all = [account(WALLET, "Aoi"), account(SECOND_WALLET, "Yuki")];
      const accounts = query
        ? all.filter((a) =>
            `${a.address} ${a.leaderboardName}`.toLowerCase().includes(query),
          )
        : [all[Math.min(number, 1)]];
      const result: AccountsResponse = {
        accounts,
        count: 2,
        pageInfo: { page: number, totalPages: query ? 1 : 2 },
        summary: {
          uniqueAccounts: 2,
          trackedBalance: usd(21558),
          trackedQueued: "0",
          trackedOpenNotional: "0",
          trackedPaper: "0",
        },
        receivedAt: Date.now(),
        stale: Boolean(options.stale),
      };
      await route.fulfill({ json: result });
      return;
    }
    const match = url.pathname.match(
      /^\/api\/wallets\/(0x[0-9a-f]{40})(\/cashflows|\/trades)?$/i,
    );
    if (match) {
      if (options.walletFailure) {
        await route.fulfill({
          status: 503,
          json: { message: "Source temporarily unavailable" },
        });
        return;
      }
      if (match[2]) {
        await route.fulfill({
          json: {
            items:
              match[2] === "/cashflows"
                ? [deposit(7779, "b", walletDataAt - 172800000)]
                : [],
            nextCursor: null,
          },
        });
        return;
      }
      const wallet = walletResponse(match[1], walletDataAt);
      if (options.missingWalletSnapshot) {
        wallet.snapshot = null;
        wallet.errors = ["Wallet snapshot unavailable"];
      }
      await route.fulfill({ json: wallet });
      return;
    }
    await route.fulfill({
      status: 404,
      json: { message: "Unexpected test API route" },
    });
  });
}
