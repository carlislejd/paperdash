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
  }[];
  count: number;
  pageInfo: { page: number; totalPages: number };
  receivedAt: number;
  stale: boolean;
  error?: string;
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
  | { type: "status"; data: DataStatus };
