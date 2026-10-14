export interface PositionTradeHighlight {
  /** Source adjusted P&L in 18-decimal raw units, not reconstructed net P&L. */
  pnlRaw: string;
  symbol: string | null;
  positionId: string;
}

export interface PositionHighlights {
  /** Maximum/minimum recorded adjusted P&L; either can have either sign. */
  bestTrade: PositionTradeHighlight | null;
  worstTrade: PositionTradeHighlight | null;
  /** Valid, unambiguous retained outcomes; independent of duration validity.
   * Null means unchecked/unavailable, whereas zero can be a checked-empty set. */
  tradeCount: number | null;
  excludedCount: number;
  /** Retained projection and available history scan caught up with no excluded
   * outcomes. Never a promise that the source exposed all lifetime activity. */
  complete: boolean;
}

/** Equal-weight means over retained, valid closed/liquidated positions. */
export interface PositionMetricsResponse {
  positionCount: number;
  avgHoldMs: number | null;
  avgLeverage: number | null;
  excludedCount: number;
  updatedAt: number | null;
  stale: boolean;
  /** Wallet only; omitted by older servers and on global metric responses. */
  highlights?: PositionHighlights;
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
