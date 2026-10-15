import { useState } from "react";
import { createRoot } from "react-dom/client";
import { WalletPnlCardDialog } from "../components/WalletPnlCardDialog";
import type { PnlCardSnapshot } from "../lib/wallet-pnl-card";
import "../styles.css";

// This standalone HTML entry is served by Vite dev only, not the production build.
const now = Math.floor(Date.now() / 1000) * 1000,
  address = `0x${"d".repeat(40)}`;
const raw = (n: number) =>
  (BigInt(Math.round(n * 100)) * 10n ** 16n).toString();
const example: PnlCardSnapshot = {
  demo: true,
  displayName: "Demo trader",
  capturedAt: now,
  wallet: {
    address,
    snapshot: {
      address,
      indexedThroughBlock: 1,
      indexedThroughTimestamp: Math.floor(now / 1000),
      accountRevision: 1,
      balance: raw(25000),
      queued: "0",
      locked: raw(12000),
      lifetime: {
        depositedRaw: raw(100000),
        withdrawnRaw: "0",
        realizedPnlRaw: raw(128492.76),
        feesPaidRaw: raw(1038),
        tradedNotionalRaw: raw(422000000),
        paperRewardsClaimedRaw: raw(2180),
      },
      paper: {
        balance: raw(153856.53),
        staked: raw(6000000),
        pendingBase: "0",
      },
      openPositions: Array.from({ length: 12 }, () => []),
    },
    accountFreshness: {
      receivedAt: now,
      sourceAt: now,
      stale: false,
      refreshing: false,
    },
    stakingRewards: {
      pendingRaw: raw(520),
      receivedAt: now,
      sourceAt: now,
      stale: false,
    },
    cashflows: { items: [], nextCursor: null },
    trades: { items: [], nextCursor: null },
    portfolio: null,
    receivedAt: now,
    stale: false,
    errors: [],
  },
  metrics: {
    positionCount: 1284,
    avgHoldMs: 758000,
    avgLeverage: 347,
    excludedCount: 0,
    updatedAt: now,
    stale: false,
    coverage: {
      source: "retained-closed-positions",
      projectionBackfillComplete: true,
      pending: false,
      historyBackfillComplete: false,
      lastHistoryIndexedAt: now,
      walletsDiscovered: null,
      totalWallets: null,
    },
    highlights: {
      bestTrade: { pnlRaw: raw(42850), symbol: "BTC", positionId: "10" },
      worstTrade: { pnlRaw: raw(-18240.5), symbol: "ETH", positionId: "11" },
      tradeCount: 1284,
      excludedCount: 0,
      complete: false,
    },
  },
};
function Preview() {
  const [snapshot, setSnapshot] = useState<PnlCardSnapshot | null>(null);
  return (
    <main style={{ padding: "56px", maxWidth: "880px", margin: "auto" }}>
      <p style={{ color: "#897398", fontSize: "12px" }}>
        LOCAL DESIGN REVIEW · DEMO DATA
      </p>
      <h1
        style={{ fontSize: "48px", letterSpacing: "-.05em", margin: "16px 0" }}
      >
        A card worth sharing.
      </h1>
      <p style={{ color: "#79786f", lineHeight: 1.7 }}>
        Try Spotlight, Gallery, and Portrait. Toggle wallet visibility, download
        a PNG, or test sharing. These are sample figures. Nothing has been
        published.
      </p>
      <div className="pnl-actions" style={{ marginTop: "26px" }}>
        <button
          type="button"
          onClick={() => setSnapshot(structuredClone(example))}
        >
          Try profit example ↗
        </button>
        <button
          type="button"
          onClick={() => {
            const loss = structuredClone(example);
            loss.wallet.snapshot!.lifetime.realizedPnlRaw = raw(-18240.5);
            setSnapshot(loss);
          }}
        >
          Try loss example ↗
        </button>
        <button
          type="button"
          onClick={() => {
            const rewardsWin = structuredClone(example);
            rewardsWin.wallet.snapshot!.lifetime.realizedPnlRaw = raw(-200000);
            rewardsWin.wallet.snapshot!.lifetime.paperRewardsClaimedRaw =
              raw(250000);
            rewardsWin.wallet.stakingRewards!.pendingRaw = raw(50000);
            setSnapshot(rewardsWin);
          }}
        >
          Try rewards win ↗
        </button>
      </div>
      {snapshot && (
        <WalletPnlCardDialog
          snapshot={snapshot}
          onClose={() => setSnapshot(null)}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
