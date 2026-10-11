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
  currentOpenPositionCount: number;
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
export interface AssetMarketResponse {
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
  error?: string;
}
export interface LeaderboardResponse {
  window: "24h";
  metric: "pnl" | "volume" | "trades";
  rows: {
    address: string;
    leaderboardName: string | null;
    rank: number;
    pnlRaw: Raw | null;
    volumeUsd: number | null;
    tradeCount: number | null;
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
  lifetime: {
    depositedRaw: Raw;
    withdrawnRaw: Raw;
    realizedPnlRaw: Raw;
    feesPaidRaw: Raw;
    tradedNotionalRaw: Raw;
    paperRewardsClaimedRaw: Raw;
  };
  paper: { balance: Raw; staked: Raw; pendingBase?: Raw };
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
  snapshot: WalletSnapshot | null;
  cashflows: HistoryPage<Cashflow>;
  trades: HistoryPage<ClosedTrade>;
  portfolio: PortfolioHistory | null;
  receivedAt: number;
  stale: boolean;
  errors: string[];
}
export type StreamMessage =
  | { type: "overview"; data: Overview }
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
  sourceAt: number | null;
  receivedAt: number | null;
  stale: boolean;
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
  history: { time: number; fundsRaw: Raw; gapBefore?: boolean }[];
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
  lifetimeRewardsRaw: Raw | null;
  fromMs: number | null;
  toMs: number | null;
  basis: "protocol-lifetime";
  yearDays: 365;
  reason?: string;
}
export type ProtocolChartMetric =
  | "tvl"
  | "openPositions"
  | "volume"
  | "paperSupply"
  | "paperStaked"
  | "stakingRewards";
export interface ProtocolChartPoint {
  /** UTC hour start; values are the latest available endpoint in that hour. */
  time: number;
  value: number | null;
  gapBefore?: boolean;
  partial?: boolean;
}
export interface ProtocolChartSeries {
  unit: "USD" | "PAPER" | "positions";
  aggregation: "snapshot" | "hourly-change" | "cumulative";
  points: ProtocolChartPoint[];
  source:
    "protocol-history-and-retained-summary" | "retained-summary-observations";
  coverage: { observedFrom: number | null; partial: true };
}
export interface ProtocolChartsResponse {
  receivedAt: number | null;
  sourceAt: number | null;
  stale: boolean;
  intervalMs: 3600000;
  series: Record<ProtocolChartMetric, ProtocolChartSeries>;
  error?: string;
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
