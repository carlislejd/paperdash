import type { Account } from "../../../packages/shared/src/types.js";
import type { Store } from "../src/store.js";
import { sampleNow as now, sampleTrade } from "./market-sampling-fixtures.js";

export const segmentWallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
export const segmentAccount = (n: number, pnl = "1"): Account => ({
  address: segmentWallet(n),
  leaderboardName: null,
  currentBalance: "999999999999999999999999999",
  currentQueued: "0",
  currentOpenNotional: "0",
  currentOpenPositionCount: 0,
  currentUnrealizedPnl: "999999999999999999999999999",
  realizedPnl: pnl,
  totalVolume: "0",
  totalWindowedPnl: "999999999999999999999999999",
  paperTotal: "999999999999999999999999999",
  lastActiveTs: 1,
});

export async function seedProfitableMarket(store: Store) {
  const rows = [
    { n: 1, pnl: "1000000000000000000", notional: 1 },
    { n: 2, pnl: "1", notional: 2 },
    { n: 3, pnl: "-1", notional: 1e12 },
    { n: 4, pnl: "0", notional: 1e11 },
    { n: 5, pnl: "1", age: 300001 },
    { n: 6, pnl: "1", missing: true },
    { n: 7, pnl: "1", age: -1 },
    { n: 8, pnl: "1x" },
    { n: 9, pnl: "1", address: segmentWallet(100) },
    { n: 10, pnl: "9".repeat(79), notional: 0.5 },
    { n: 11, pnl: "1", age: 300000, notional: 0.25 },
    ...["+1", "01", "-0", "1.0", "", 1, null, "9".repeat(80)].map((pnl, index) => ({ n: 12 + index, pnl })),
  ];
  for (const row of rows) {
    await store.recordTrade(sampleTrade(`wallet-${row.n}`, {
      wallet: segmentWallet(row.n), notionalUsd: row.notional ?? 1e9,
    }));
    if (!row.missing) await store.put(`account-summary:${segmentWallet(row.n)}`, {
      ...segmentAccount(row.n),
      realizedPnl: row.pnl,
      ...(row.address ? { address: row.address } : {}),
      // These unrelated values must never rescue zero or negative trading P&L.
      claimedRewards: "999999999999999999999999999",
      pendingRewards: "999999999999999999999999999",
    }, now - (row.age ?? 0));
  }
  await store.recordTrade(sampleTrade("profitable-close", {
    wallet: segmentWallet(1), kind: "close", pnlUsd: 20, notionalUsd: 1e13,
  }));
  await store.recordTrade(sampleTrade("profitable-liquidation", {
    wallet: segmentWallet(1), kind: "liq", pnlUsd: -20, notionalUsd: 1e14,
  }));
  return { observedWallets: rows.length, classifiedWallets: 6, profitableWallets: 4, unknownWallets: rows.length - 6 };
}

/** Exact 18-decimal boundaries plus a tiny-profit wallet with huge executions. */
export async function seedProfitFloors(store: Store) {
  const rows = [
    { n: 21, pnl: 20n * 10n ** 18n, notional: 1e12 },
    { n: 22, pnl: 1000n * 10n ** 18n - 1n, notional: 1e11 },
    { n: 23, pnl: 1000n * 10n ** 18n, notional: 1 },
    { n: 24, pnl: 10000n * 10n ** 18n - 1n, notional: 2 },
    { n: 25, pnl: 10000n * 10n ** 18n, notional: 3 },
    { n: 26, pnl: 100000n * 10n ** 18n, notional: 4 },
    { n: 27, pnl: BigInt("9".repeat(79)), notional: 0.5 },
    { n: 28, pnl: 100000n * 10n ** 18n - 1n, notional: 5 },
  ];
  for (const row of rows) {
    await store.recordTrade(sampleTrade(`floor-${row.n}`, {
      wallet: segmentWallet(row.n), notionalUsd: row.notional,
    }));
    await store.put(`account-summary:${segmentWallet(row.n)}`,
      segmentAccount(row.n, row.pnl.toString()), now);
  }
}
