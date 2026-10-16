import type { Page } from "@playwright/test";
import type { PositionMetricsResponse } from "../../packages/shared/src/position-metrics";
import { VERIFIED_TRADING_WINDOW } from "../../packages/shared/src/trading-launch";
import type {
  Account,
  AnnualizedStakingRevenue,
  AccountsResponse,
  AssetsResponse,
  AssetMarketResponse,
  Cashflow,
  DepositDailyResponse,
  LeaderboardResponse,
  Overview,
  ProtocolChartsResponse,
  PaperEconomicsResponse,
  WalletResponse,
  WalletBatchResponse,
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
  statsWindow: "all" | "24h" = metric === "paper" ? "all" : "24h",
): LeaderboardResponse {
  const sourceRanked = metric === "pnl" || metric === "paper";
  const lifetime = metric === "paper" && statsWindow === "all";
  return {
    window: metric === "paper" ? "current" : "24h",
    statsWindow: lifetime ? "all" : "24h",
    metric,
    rows: [
      {
        address: page === 0 ? WALLET : SECOND_WALLET,
        leaderboardName: page === 0 ? "Aoi" : "Yuki",
        rank: page * 25 + 1,
        pnlRaw: sourceRanked
          ? usd(page === 0 ? (lifetime ? 50010 : 5001) : -50)
          : null,
        paperTotalRaw: sourceRanked ? "3003199186757525433019603" : null,
        volumeUsd: lifetime ? null : 3000000,
        ...(lifetime
          ? {
              volumeRaw: "30000000000123456789012345678",
              historyCoverage: {
                indexedAt: Date.now(),
                backfillComplete: true,
                projectionPending: false,
                excludedCount: 0,
                stale,
              },
            }
          : {}),
        tradeCount: lifetime ? 1247 : 23,
        currentUnrealizedPnlRaw: sourceRanked
          ? usd(page === 0 ? 1250000 : -125)
          : null,
        assetsTraded: lifetime ? null : [0, 1],
      },
    ],
    count: 26,
    pageInfo: { page, totalPages: 2 },
    receivedAt: Date.now(),
    stale,
    accountReceivedAt: sourceRanked ? Date.now() : null,
    accountStale: sourceRanked && stale,
    paperOwnership: sourceRanked
      ? {
          trackedTotalRaw: "12012796747030101732078412",
          pageTotalRaw: "3003199186757525433019603",
          pageShareBps: 2500,
        }
      : undefined,
    activityCoverage: lifetime
      ? undefined
      : {
          source: "retained-public-observations",
          partial: true,
          observedFrom: Date.now() - 7200000,
          projectionBackfillComplete: true,
          receivedAt: Date.now(),
          windowFrom: Date.now() - 86400000,
          windowTo: Date.now(),
          stale,
        },
    coverage: {
      source: sourceRanked
        ? "papertrade-leaderboard"
        : "retained-public-observations",
      observedFrom: sourceRanked ? null : Date.now() - 7200000,
      projectionBackfillComplete: sourceRanked,
      identityAmbiguous: !sourceRanked,
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

export function depositDailyResponse(at = Date.now()): DepositDailyResponse {
  const day = 86400000,
    today = Math.floor(at / day) * day;
  return {
    intervalMs: 86400000,
    timeZone: "UTC",
    days: [0, 1, 3, 4, 5, 6].map((index) => ({
      time: today - (6 - index) * day,
      depositVolumeRaw: usd(index === 6 ? 125 : (index + 1) * 1000),
      depositCount: index + 4,
      firstDepositors: index === 6 ? 1 : Math.min(index + 1, 3),
    })),
    observedFrom: today - 6 * day,
    updatedAt: at - 1000,
    stale: false,
    coverage: {
      partial: true,
      identityAmbiguous: true,
      projectionBackfillComplete: true,
      pending: false,
      excludedRecords: 0,
    },
  };
}

export function protocolChartsResponse(
  at = Date.now(),
): ProtocolChartsResponse {
  const hour = 3600000,
    base = Math.floor(at / hour) * hour;
  const keys = [
    "tvl",
    "openPositions",
    "volume",
    "paperSupply",
    "paperStaked",
    "stakingRewards",
  ] as const;
  const series = Object.fromEntries(
    keys.map((key) => [
      key,
      {
        unit:
          key === "openPositions"
            ? "positions"
            : key.startsWith("paper")
              ? "PAPER"
              : "USD",
        aggregation:
          key === "volume"
            ? "hourly-change"
            : key === "stakingRewards"
              ? "cumulative"
              : "snapshot",
        points: Array.from({ length: 24 }, (_, i) => ({
          time: base - (23 - i) * hour,
          value:
            i === 7
              ? null
              : key === "openPositions"
                ? 1200 + i * 35
                : key === "volume"
                  ? (i + 1) * 1_000_000_000
                  : 60_000_000 + i * 1_000_000,
          ...(i === 8 ? { gapBefore: true } : {}),
          ...(i === 23 ? { partial: true } : {}),
        })),
        source:
          key === "openPositions"
            ? "retained-summary-observations"
            : "protocol-history-and-retained-summary",
        coverage: { observedFrom: base - 23 * hour, partial: true },
      },
    ]),
  ) as ProtocolChartsResponse["series"];
  return {
    receivedAt: at,
    sourceAt: at,
    stale: false,
    intervalMs: 3600000,
    series,
    deposits: depositDailyResponse(at),
  };
}

export function allocationRateResponse(at = Date.now()): AnnualizedStakingRevenue {
  const elapsed = at - VERIFIED_TRADING_WINDOW.fromMs;
  const allocations = BigInt(usd(16271));
  return {
    usdPerYearRaw: elapsed > 0
      ? (allocations * 86_400_000n * 365n / BigInt(elapsed)).toString()
      : null,
    usdPerDayRaw: elapsed > 0
      ? (allocations * 86_400_000n / BigInt(elapsed)).toString()
      : null,
    lifetimeRewardsRaw: allocations.toString(),
    allocatedSinceStartRaw: allocations.toString(),
    baselineRewardsRaw: VERIFIED_TRADING_WINDOW.baselineRewardsRaw,
    fromMs: VERIFIED_TRADING_WINDOW.fromMs,
    toMs: at,
    basis: "observed-trading-window",
    cutoffBasis: VERIFIED_TRADING_WINDOW.cutoffBasis,
    yearDays: 365,
  };
}

export function paperEconomicsResponse(
  at = Date.now(),
): PaperEconomicsResponse {
  const base = Math.floor(at / 3600000) * 3600000;
  const series = (
    kind:
      "supply" | "staked" | "supplyChange" | "rewardAllocation" | "allocated",
  ): PaperEconomicsResponse["series"]["supply"] => ({
    unit: kind === "rewardAllocation" || kind === "allocated" ? "USD" : "PAPER",
    aggregation:
      kind === "supply" || kind === "staked"
        ? "snapshot"
        : kind === "allocated"
          ? "cumulative"
          : "hourly-change",
    points: Array.from({ length: 30 }, (_, index) => ({
      time: base - (29 - index) * 3600000,
      value:
        index === 7
          ? null
          : kind === "supply"
            ? 100_000_000 + index * 1_000_000
            : kind === "staked"
              ? 0
              : kind === "allocated"
                ? 16271 - (29 - index) * 100
                : kind === "supplyChange"
                  ? index === 18
                    ? -2_000_000
                    : 1_000_000
                  : 500 + index * 5,
      ...(index === 8 ? { gapBefore: true } : {}),
      ...(index === 29 ? { partial: true } : {}),
    })),
    source: "protocol-history-and-retained-summary",
    coverage: { observedFrom: base - 29 * 3600000, partial: true },
  });
  return {
    sourceAt: at,
    receivedAt: at,
    stale: false,
    supplyRaw: usd(125571374),
    stakedRaw: "0",
    allocatedRewardsRaw: usd(16271),
    pendingRewardsRaw: usd(324),
    stakeRatioBps: 0,
    annualized: allocationRateResponse(at),
    series: {
      supply: series("supply"),
      allocated: series("allocated"),
      staked: series("staked"),
      supplyChange: series("supplyChange"),
      rewardAllocation: series("rewardAllocation"),
    },
    daily: {
      intervalMs: 86400000,
      timeZone: "UTC",
      ...(Object.fromEntries(
        (["supplyChange", "rewardAllocation"] as const).map((kind) => [
          kind,
          {
            unit: kind === "rewardAllocation" ? "USD" : "PAPER",
            aggregation: "daily-change",
            points: Array.from({ length: 7 }, (_, index) => {
              const time =
                Math.floor(at / 86400000) * 86400000 - (6 - index) * 86400000;
              const value =
                index === 2
                  ? null
                  : index === 1
                    ? 0
                    : kind === "supplyChange"
                      ? index === 3
                        ? -2_000_000
                        : (index + 1) * 1_000_000
                      : index === 6
                        ? 125
                        : (index + 1) * 100;
              return {
                time,
                value,
                ...(value === null
                  ? {}
                  : {
                      valueRaw: usd(value),
                      observedFromMs: time,
                      observedToMs: index === 6 ? at : time + 86400000,
                    }),
                ...(index === 3 ? { gapBefore: true } : {}),
                ...(index === 6 ? { partial: true } : {}),
              };
            }),
            source: "protocol-history-and-retained-summary",
            coverage: {
              observedFrom: Math.floor(at / 86400000) * 86400000 - 6 * 86400000,
              partial: true,
            },
          },
        ]),
      ) as Pick<
        NonNullable<PaperEconomicsResponse["daily"]>,
        "supplyChange" | "rewardAllocation"
      >),
    },
    coverage: { partial: true, historyApproximate: true },
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
        body: `data: ${JSON.stringify({ type: "overview", data: overview(options.stale) })}\n\n`,
      });
      return;
    }
    if (url.pathname === "/api/overview") {
      await route.fulfill({ json: overview(options.stale) });
      return;
    }
    if (url.pathname === "/api/paper/economics") {
      await route.fulfill({
        json: { ...paperEconomicsResponse(), stale: Boolean(options.stale) },
      });
      return;
    }
    if (url.pathname === "/api/protocol/charts") {
      await route.fulfill({ json: protocolChartsResponse() });
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
          url.searchParams.get("window") === "24h" ? "24h" : "all",
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
    if (url.pathname === "/api/wallets/batch") {
      const now = Date.now();
      const result: WalletBatchResponse = {
        rows: (url.searchParams.get("addresses") ?? "")
          .split(",")
          .filter(Boolean)
          .map((address) => ({
            address,
            account: account(
              address,
              address === WALLET
                ? "Aoi"
                : address === SECOND_WALLET
                  ? "Yuki"
                  : "Test wallet",
            ),
            sourceAt: null,
            receivedAt: options.stale ? now - 120000 : now,
            stale: Boolean(options.stale),
            refreshQueued: false,
          })),
        activity: {
          items: [],
          windowFrom: now - 86400000,
          windowTo: now,
          receivedAt: now,
          stale: Boolean(options.stale),
          coverage: {
            source: "retained-public-observations",
            partial: true,
            identityAmbiguous: true,
            projectionBackfillComplete: true,
            observedFrom: now - 86400000,
            truncated: false,
          },
        },
        receivedAt: now,
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
