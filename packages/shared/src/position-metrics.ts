/** Equal-weight means over retained, valid closed/liquidated positions. */
export interface PositionMetricsResponse {
  positionCount: number;
  avgHoldMs: number | null;
  avgLeverage: number | null;
  excludedCount: number;
  updatedAt: number | null;
  stale: boolean;
  coverage: {
    source: "retained-closed-positions";
    projectionBackfillComplete: boolean;
    pending: boolean;
    /** Wallet source-history scan only; never a global completeness promise. */
    historyBackfillComplete: boolean | null;
    lastHistoryIndexedAt: number | null;
    walletsDiscovered: number | null;
    totalWallets: number | null;
  };
}
