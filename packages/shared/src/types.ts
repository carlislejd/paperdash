import type { WalletMarginRiskResponse } from "./margin-risk.js";

export type Raw = string;
export interface DataStatus {
  receivedAt: number | null;
  sourceAt: number | null;
  indexedBlock: string | null;
  stale: boolean;
  persistence: "postgres" | "local";
  stream: "connected" | "connecting" | "disconnected";
  message?: string;
}
export interface ProtocolSummary {
  ok: boolean;
  source: { block: string; at: number; genesis?: number };
  balances: { tvl: Raw; margin: Raw; lp: Raw; reserve: Raw; queue: Raw };
  activity: { volume: Raw; open: number };
  fees: { pending: Raw; lifetime: Raw };
  paper: { supply: Raw; staked: Raw; [key: string]: Raw };
}
export interface Account {
  address: string;
  leaderboardName: string | null;
  currentBalance: Raw;
  currentQueued: Raw;
  currentOpenNotional: Raw;
  /** Omitted by newer account-directory responses; null is unknown, never zero. */
  currentOpenPositionCount: number | null;
  currentUnrealizedPnl: Raw;
  realizedPnl: Raw;
  totalVolume: Raw;
  totalWindowedPnl: Raw;
  paperTotal: Raw;
  lastActiveTs: number;
  /** Retained opens, closes and liquidations in the rolling 24h window. */
  tradeCount24h?: number | null;
  tradeCount24hAt?: number;
  tradeCount24hStale?: boolean;
}
export interface AccountsResponse {
  accounts: Account[];
  count: number;
  pageInfo: { page: number; totalPages: number };
  summary: {
    uniqueAccounts: number;
    trackedBalance: Raw;
    trackedQueued: Raw;
    trackedOpenNotional: Raw;
    trackedPaper: Raw;
  };
  receivedAt: number;
  stale: boolean;
  error?: string;
  tradeCountCoverage?: {
    source: "retained-public-observations";
    partial: true;
    observedFrom: number | null;
    projectionBackfillComplete: boolean;
    receivedAt: number;
    stale: boolean;
  };
}
export interface WalletBatchResponse {
  rows: {
    address: string;
    account: Account | null;
    receivedAt: number | null;
    /** The directory source does not expose a valuation timestamp. */
    sourceAt: null;
    stale: boolean;
    refreshQueued: boolean;
  }[];
  activity: {
    items: TradeEvent[];
    windowFrom: number;
    windowTo: number;
    receivedAt: number;
    stale: boolean;
    coverage: {
      source: "retained-public-observations";
      partial: true;
      identityAmbiguous: true;
      observedFrom: number | null;
      projectionBackfillComplete: boolean;
      truncated: boolean;
    };
  };
  receivedAt: number;
  stale: boolean;
  error?: string;
}
export interface TradeEvent {
  id: string;
  ts: number;
  wallet: string;
  instrument: number;
  side: "long" | "short";
  leverage: number;
  notionalUsd: number;
  kind: "open" | "close" | "liq";
  pnlUsd: number | null;
  provenance: "public-stream" | "recent-api";
  /** Verified execution price when supplied; never part of observation identity. */
  priceUsd?: number | null;
}
export interface AssetPricePoint {
  time: number;
  priceUsd: number;
  /** First observed bucket after a connection/restart gap. */
  gapBefore?: boolean;
}
export type MarketWindow = "5m" | "15m" | "1h";
export type MarketSegment = "all" | "profitable";
export type MarketActivity = "all" | "entries" | "exits";
export const marketMinPnlUsd = [0, 1000, 10000, 100000] as const;
export type MarketMinPnlUsd = (typeof marketMinPnlUsd)[number];
export interface MarketSegmentCoverage {
  /** Activity defining the wallet cohort; absent in legacy entry-only coverage. */
  activity?: MarketActivity;
  basis: "positive-lifetime-realized-trading-pnl";
  /** Lifetime realized trading profit floor; absent in older zero-floor snapshots. */
  minPnlUsd?: MarketMinPnlUsd;
  classifiedAt: number;
  maxAccountAgeMs: number;
  /** Unique wallets with the selected activity in the saved one-hour market window. */
  observedWallets: number;
  classifiedWallets: number;
  profitableWallets: number;
  unknownWallets: number;
  oldestAccountReceivedAt: number | null;
  newestAccountReceivedAt: number | null;
}
export interface MarketTradeSample {
  windowFrom: number;
  windowTo: number;
  /** Epoch-aligned bucket width; first/current buckets can be clipped. */
  bucketMs: number;
  perBucket: 2;
  trades: TradeEvent[];
  selection: "largest-notional-per-time-bucket";
  partial: true;
}
export interface AssetFreshness {
  /** Current publication/transport delay, independent of historical completeness. */
  delayed: boolean;
  /** Retained evidence of an unresolved historical trade-ingestion gap. */
  historyGap: boolean;
}
export interface AssetMarketResponse {
  /** Explicit activity selection; absent in legacy snapshots. Exits include liquidations. */
  activity?: MarketActivity;
  /** Absent in older all-trader snapshots. */
  segment?: MarketSegment;
  segmentCoverage?: MarketSegmentCoverage;
  instrument: number;
  symbol: string;
  price: { priceUsd: number; sourceAt: number; receivedAt: number } | null;
  points: AssetPricePoint[];
  trades: TradeEvent[];
  /** Separate from the latest-trades feed; absent in older saved snapshots. */
  chartSample?: MarketTradeSample;
  windowFrom: number;
  windowTo: number;
  receivedAt: number;
  stale: boolean;
  /** Absent in older responses; aggregate stale remains conservative. */
  freshness?: AssetFreshness;
  coverage: {
    source: "retained-market-observations";
    observedFrom: number | null;
    partial: true;
    tradesCapped: boolean;
  };
}
export interface ChartPoint {
  time: number;
  value: number;
}
export interface AssetActivity {
  instrument: number;
  windowFrom: number;
  windowTo: number;
  counts: { total: number; long: number; short: number };
  notionalUsd: { total: number; long: number; short: number };
  recent: TradeEvent[];
  coverage: {
    observedFrom: number | null;
    latestObservedAt: number | null;
    projectionBackfillComplete: boolean;
    identityAmbiguous: true;
    source: "retained-public-observations";
  };
}
export interface AssetOiSample {
  instrument: number;
  time: number;
  longRaw: Raw;
  shortRaw: Raw;
  sourceBlock: string | null;
  sourceAt: number;
  receivedAt: number;
}
export interface AssetSummary {
  instrument: number;
  symbol: string;
  openInterest: {
    longRaw: Raw;
    shortRaw: Raw;
    totalRaw: Raw;
    longSharePct: number | null;
    shortSharePct: number | null;
  };
  activity: AssetActivity | null;
  history: AssetOiSample[];
}
export interface AssetsResponse {
  assets: AssetSummary[];
  sourceAt: number | null;
  indexedBlock: string | null;
  receivedAt: number | null;
  activityReceivedAt: number | null;
  stale: boolean;
  /** Absent in older responses; aggregate stale remains conservative. */
  freshness?: AssetFreshness;
  error?: string;
}
export interface LeaderboardResponse {
  window: "24h" | "current";
  /** Statistics period; PAPER ownership itself is always current. */
  statsWindow?: "24h" | "all";
  metric: "pnl" | "volume" | "trades" | "paper";
  rows: {
    address: string;
    leaderboardName: string | null;
    rank: number;
    pnlRaw: Raw | null;
    /** Current unstaked plus staked PAPER from the source account snapshot. */
    paperTotalRaw?: Raw | null;
    volumeUsd: number | null;
    /** Exact lifetime source-account volume; absent for observed 24h activity. */
    volumeRaw?: Raw | null;
    tradeCount: number | null;
    /** Lifetime counts are retained closed/liquidated records, not executions. */
    historyCoverage?: {
      indexedAt: number | null;
      backfillComplete: boolean;
      projectionPending: boolean;
      excludedCount: number;
      stale: boolean;
    };
    /** Current account snapshot, distinct from the ranking's 24h P&L. */
    currentUnrealizedPnlRaw?: Raw | null;
    /** Instrument IDs seen in retained 24h executions, not open positions. */
    assetsTraded?: number[] | null;
  }[];
  count: number;
  pageInfo: { page: number; totalPages: number };
  receivedAt: number;
  stale: boolean;
  error?: string;
  accountReceivedAt?: number | null;
  accountStale?: boolean;
  paperOwnership?: {
    /** Global tracked account holdings, including for a filtered page; not supply. */
    trackedTotalRaw: Raw;
    /** Sum of current page's source account holdings, not all filtered matches. */
    pageTotalRaw: Raw;
    pageShareBps: number | null;
  };
  activityCoverage?: {
    source: "retained-public-observations";
    partial: true;
    observedFrom: number | null;
    projectionBackfillComplete: boolean;
    receivedAt: number;
    windowFrom: number;
    windowTo: number;
    stale: boolean;
  };
  coverage: {
    source: "papertrade-leaderboard" | "retained-public-observations";
    observedFrom: number | null;
    projectionBackfillComplete: boolean;
    identityAmbiguous: boolean;
  };
}
export interface Overview {
  summary: ProtocolSummary | null;
  accountCount: number | null;
  history: ChartPoint[];
  historyCoverage: "upstream" | "observed" | "unavailable";
  trades: TradeEvent[];
  status: DataStatus;
}
export interface WalletSnapshot {
  address: string;
  indexedThroughBlock: number;
  indexedThroughTimestamp: number;
  balance: Raw;
  queued: Raw;
  locked: Raw;
  accountRevision: number;
  /** Last block that changed the wallet; older source snapshots may omit it. */
  walletRevision?: number;
  lifetime: {
    depositedRaw: Raw;
    withdrawnRaw: Raw;
    realizedPnlRaw: Raw;
    feesPaidRaw: Raw;
    tradedNotionalRaw: Raw;
    paperRewardsClaimedRaw: Raw;
  };
  paper: {
    balance: Raw;
    staked: Raw;
    /** Accrued reward component; not the complete claimable balance. */
    pendingBase?: Raw;
    /** Reward accumulator checkpoint for the account's current stake. */
    rewardDebt?: Raw;
  };
  openPositions: unknown[];
}
export interface Cashflow {
  id?: string;
  timestampMs: number;
  txHash: string;
  amountRaw: Raw;
  kind: "Deposit" | "Withdrawal";
  recipientAmountRaw: Raw | null;
  route: string | null;
  withdrawalStatus: string | null;
}
export interface ClosedTrade {
  [key: string]: unknown;
}
export interface HistoryPage<T> {
  items: T[];
  nextCursor: string | null;
  receivedAt?: number | null;
  stale?: boolean;
  coverage?: {
    backfillComplete: boolean;
    sourceComplete: boolean | null;
    identity: string;
    identityAmbiguous: boolean;
    retainedCount: number;
    retainedCountCapped?: boolean;
    indexing: boolean;
    lastIndexedAt: number | null;
    error?: string;
  };
}
export interface PortfolioHistory {
  baseTimeMs: number;
  timeOffsetsMs: number[];
  columns: { equity: number[]; pnl: number[] };
  gapIndices: number[];
  coverage: {
    availableFromMs: number | null;
    availableToMs: number | null;
    complete: boolean;
  };
}
export interface WalletResponse {
  address: string;
  /** Retained directory identity; absent when unavailable, null when unnamed. */
  leaderboardName?: string | null;
  snapshot: WalletSnapshot | null;
  /** Successful check and last indexed account-change clocks in milliseconds.
   * An inactive account's sourceAt can stay old after a fresh successful check. */
  accountFreshness?: {
    receivedAt: number | null;
    sourceAt: number | null;
    stale: boolean;
    refreshing: boolean;
  };
  cashflows: HistoryPage<Cashflow>;
  trades: HistoryPage<ClosedTrade>;
  portfolio: PortfolioHistory | null;
  receivedAt: number;
  stale: boolean;
  errors: string[];
  /** Additive scenario from this same snapshot and retained reference prices. */
  marginRisk?: WalletMarginRiskResponse;
  /** Claimable USDC, in 18-decimal units, derived from retained staking state.
   * Missing/null pendingRaw means unavailable; it must never become zero. */
  stakingRewards?: {
    pendingRaw: Raw | null;
    receivedAt: number | null;
    sourceAt: number | null;
    stale: boolean;
  };
  /** Current stake and pool total captured together, independently of rewards.
   * Unavailable pairs remain null; this is not historical wallet participation. */
  stakingParticipation?: {
    walletStakedRaw: Raw | null;
    totalStakedRaw: Raw | null;
    receivedAt: number | null;
    sourceAt: number | null;
    stale: boolean;
  };
}
export type PanelKey =
  "house" | "protocol-charts" | "paper-economics" | "liquidation-stats";
/** Advisory publication hints; REST remains the snapshot/recovery authority. */
export interface PanelRevisions {
  version: 1;
  publishedAt: number;
  panels: Partial<
    Record<
      PanelKey,
      {
        revision: string;
        receivedAt: number;
        sourceAt: number | null;
        /** House health covers its valuation; PAPER has an independent panel. */
        stale: boolean;
      }
    >
  >;
}
export type StreamMessage =
  | { type: "overview"; data: Overview; panels?: PanelRevisions }
  | { type: "panel-revisions"; data: PanelRevisions }
  | {
      type: "metrics";
      data: Pick<Overview, "summary" | "accountCount" | "status">;
    }
  | { type: "history"; data: Pick<Overview, "history" | "historyCoverage"> }
  | { type: "trade"; data: TradeEvent }
  | {
      type: "asset-price";
      data: { instrument: number; point: AssetPricePoint; receivedAt: number };
    }
  | { type: "status"; data: DataStatus };

export interface HouseResponse {
  /** Exact saved publication content revision, when push delivery is available. */
  panelRevision?: string;
  sourceAt: number | null;
  receivedAt: number | null;
  stale: boolean;
  /** House source and collector freshness, independent of the PAPER summary. */
  houseStale?: boolean;
  house: {
    fundsRaw: Raw;
    lpRaw: Raw;
    openPnlRaw: Raw;
    queueDebtRaw: Raw;
  } | null;
  paper: {
    supplyRaw: Raw | null;
    stakedRaw: Raw | null;
    stakerRewardsRaw: Raw | null;
    pendingRewardsRaw: Raw | null;
  };
  /** This block belongs to the independent protocol summary, not the house valuation. */
  sourceBlock: string | null;
  summarySourceAt: number | null;
  history: {
    time: number;
    fundsRaw: Raw;
    lpRaw?: Raw;
    openPnlRaw?: Raw;
    queueDebtRaw?: Raw;
    gapBefore?: boolean;
  }[];
  /** Signed endpoint changes over the newest coherent retained run; not a cash-flow attribution. */
  change?: {
    fromMs: number;
    toMs: number;
    sampleCount: number;
    fundsRaw: Raw;
    lpRaw: Raw;
    openPnlRaw: Raw;
    /** Change in queue debt itself; its contribution to funds is the negative of this value. */
    queueDebtRaw: Raw;
  } | null;
  coverage: {
    source: "retained-house-observations";
    approximate: true;
    observedFrom: number | null;
    partial: true;
  };
  error?: string;
  annualizedStakingRevenue?: AnnualizedStakingRevenue;
}

export interface AnnualizedStakingRevenue {
  usdPerYearRaw: Raw | null;
  /** Direct daily run rate; absent in older deployment-lifetime responses. */
  usdPerDayRaw?: Raw | null;
  /** Source lifetime counter, preserved independently of the rate's window. */
  lifetimeRewardsRaw: Raw | null;
  /** Verified cumulative allocations immediately before the trading cutoff. */
  baselineRewardsRaw?: Raw | null;
  /** Lifetime counter minus the cutoff baseline; the rate's numerator. */
  allocatedSinceStartRaw?: Raw | null;
  fromMs: number | null;
  toMs: number | null;
  /** Legacy cached responses must not be presented as trading-window rates. */
  basis: "protocol-lifetime" | "observed-trading-window";
  cutoffBasis?: "announced-trading-start";
  yearDays: 365;
  reason?: string;
}
/** Historical distributed USDC earned per continuously staked PAPER. This is
 * a simple annual reward rate; a purchase price is required for percent APR. */
export interface AnnualizedStakerYield {
  /** 18-decimal USDC per one PAPER per 365-day year. */
  usdPerPaperPerYearRaw: Raw | null;
  /** 18-decimal USDC per one PAPER over the measured observation window. */
  earnedUsdPerPaperRaw: Raw | null;
  fromMs: number | null;
  toMs: number | null;
  /** Exact source elapsed time, including partial hours. */
  elapsedMs: number | null;
  basis: "observed-accumulator";
  yearDays: 365;
  reason?: string;
}
/** Timestamped Hyperliquid Paragon perpetual reference, denominated in USDC. */
export interface PaperPriceQuote {
  source: "hyperliquid";
  market: "para:PAPER";
  basis: "perp-mid";
  /** Exact 18-decimal prices; midpoint rounds down at the final raw unit. */
  priceUsdRaw: Raw;
  bidUsdRaw: Raw;
  askUsdRaw: Raw;
  sourceAt: number;
  receivedAt: number;
}
export type ProtocolChartMetric =
  | "tvl"
  | "openPositions"
  | "volume"
  | "paperSupply"
  | "paperStaked"
  | "stakingRewards";
export interface ProtocolChartPoint {
  /** UTC bucket start (hourly by default; daily for daily-change series). */
  time: number;
  value: number | null;
  gapBefore?: boolean;
  partial?: boolean;
  /** Actual cumulative endpoints used for a daily change, when available. */
  observedFromMs?: number;
  observedToMs?: number;
  /** Exact 18-decimal endpoint difference, when both endpoints retain raw values. */
  valueRaw?: Raw;
}
export interface ProtocolChartSeries {
  unit: "USD" | "PAPER" | "positions";
  aggregation: "snapshot" | "hourly-change" | "daily-change" | "cumulative";
  points: ProtocolChartPoint[];
  source:
    "protocol-history-and-retained-summary" | "retained-summary-observations";
  coverage: { observedFrom: number | null; partial: true };
}
export interface DepositDailyResponse {
  intervalMs: 86400000;
  timeZone: "UTC";
  /** Sparse retained totals. Missing days are unknown until local projection catches up. */
  days: {
    time: number;
    depositVolumeRaw: Raw;
    depositCount: number;
    firstDepositors: number;
  }[];
  /** Earliest retained positive deposit, not the beginning of complete history. */
  observedFrom: number | null;
  /** Last projection change, not a promise of source freshness. */
  updatedAt: number | null;
  stale: boolean;
  coverage: {
    partial: true;
    identityAmbiguous: true;
    projectionBackfillComplete: boolean;
    pending: boolean;
    excludedRecords: number;
  };
  error?: string;
}
export interface ProtocolChartsResponse {
  panelRevision?: string;
  receivedAt: number | null;
  sourceAt: number | null;
  stale: boolean;
  intervalMs: 3600000;
  series: Record<ProtocolChartMetric, ProtocolChartSeries>;
  /** Shares the saved chart response; no per-viewer ledger scan. */
  deposits?: DepositDailyResponse;
  error?: string;
}

export interface StakingRewardDay {
  /** Legacy rows without this field were observed through the Papertrade API. */
  source?: "papertrade-api" | "hyperevm-rpc";
  /** UTC date assigned to this measured interval. Boundary samples may be approximate. */
  dayMs: number;
  fromMs: number | null;
  toMs: number | null;
  /** Actual observed USDC per 1,000 staked PAPER, 18 decimals; never annualized. */
  earnedUsdPer1kPaperRaw: Raw | null;
  partial: boolean;
  /** Missing or inconsistent observations; null rewards must not become zero. */
  missing: boolean;
  /** Exact 18-decimal PAPER totals from these same reward interval endpoints.
   * Legacy or conflicting observations remain unavailable, never backfilled. */
  participation?: {
    supplyFromRaw: Raw;
    supplyToRaw: Raw;
    stakedFromRaw: Raw;
    stakedToRaw: Raw;
  } | null;
}
export interface StakingRewardHistory {
  basis: "observed-accumulator";
  timeZone: "UTC";
  /** Ascending dates, including explicit unknown gaps; at most 365 UTC days. */
  days: StakingRewardDay[];
  /** First retained accumulator endpoint, not an assumed protocol-launch zero. */
  observedFromMs: number | null;
  /** First date in this bounded response. Older completed days remain stored. */
  availableFromMs: number | null;
  truncated: boolean;
}

export interface PaperEconomicsResponse {
  panelRevision?: string;
  sourceAt: number | null;
  receivedAt: number | null;
  stale: boolean;
  error?: string;
  supplyRaw: Raw | null;
  stakedRaw: Raw | null;
  /** Lifetime USDC allocated to stakers; not distributed or claimed USDC. */
  allocatedRewardsRaw: Raw | null;
  /** Source-reported protocol pending rewards, not wallet claimable rewards. */
  pendingRewardsRaw: Raw | null;
  /** Same-summary staked/supply ratio, truncated to integer basis points. */
  stakeRatioBps: number | null;
  annualized: AnnualizedStakingRevenue;
  /** Additive rollout field, independent of allocated protocol revenue. */
  stakingYield?: AnnualizedStakerYield;
  /** Collector-owned daily observed rewards; unavailable before capture began. */
  stakingRewardHistory?: StakingRewardHistory;
  /** Independent current supply/stake and reward-accumulator observation.
   * Allocation totals and existing protocol charts retain their API clocks. */
  onchain?: {
    source: "hyperevm-rpc";
    chainId: 999;
    blockNumber: string;
    /** Subsequently fetched canonical header; latest state is not hash-pinned. */
    blockHash: string;
    consistency: "atomic-multicall";
    /** Canonical header time; sourceAt is the actual eth_call execution clock. */
    blockTimestampMs: number;
    sourceAt: number;
    receivedAt: number;
    stale: boolean;
    accumulatorRaw: Raw;
  };
  /** Collector-owned reference quote. Its clocks age independently of rewards. */
  paperPrice?: PaperPriceQuote | null;
  series: {
    supply: ProtocolChartSeries;
    staked: ProtocolChartSeries;
    allocated: ProtocolChartSeries;
    /** Signed net supply change; not a mint-event total. */
    supplyChange: ProtocolChartSeries;
    /** Nonnegative change in cumulative allocated USDC; not distributions. */
    rewardAllocation: ProtocolChartSeries;
  };
  /** Optional until all collectors have published the additive daily payload. */
  daily?: {
    intervalMs: 86400000;
    timeZone: "UTC";
    /** Signed net supply change, not a sum of mint events. */
    supplyChange: ProtocolChartSeries;
    /** Change in lifetime staker allocations, not distributions or claims. */
    rewardAllocation: ProtocolChartSeries;
  };
  coverage: { partial: true; historyApproximate: true };
}

export interface LiquidationTotals {
  /** Approximate initial margin: sum(notionalUsd / leverage), not exact collateral accounting. Null until every retained observation in this window is covered. */
  estimatedMarginUsd?: number | null;
  marginObservationCount?: number;
  count: number;
  longCount: number;
  shortCount: number;
  /** Approximate USD execution notional, not lost collateral or realized PnL. */
  notionalUsd: number;
}
export interface LiquidationsResponse {
  panelRevision?: string;
  items: TradeEvent[];
  nextCursor: string | null;
  stats: { hour: LiquidationTotals; day: LiquidationTotals };
  /** Optional during rollout; zeros mean no retained observations, not complete source coverage. */
  hourly?: {
    intervalMs: 3600000;
    from: number;
    to: number;
    buckets: {
      /** UTC hour start; first/current buckets can cover only part of that hour. */
      time: number;
      partial: boolean;
      assets: { instrument: number; count: number; notionalUsd: number }[];
    }[];
  };
  windowTo: number;
  receivedAt: number | null;
  stale: boolean;
  coverage: {
    source: "retained-public-observations";
    partial: true;
    identityAmbiguous: true;
    projectionBackfillComplete: boolean;
    observedFrom: number | null;
    latestObservedAt: number | null;
  };
  error?: string;
}
