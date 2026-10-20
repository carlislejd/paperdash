import type { WalletResponse } from "../../../../packages/shared/src/types";
import { formatRawUsd } from "./format";
import { walletAccountClock } from "./wallet-account-clock";

export const WALLET_PERFORMANCE_NOTE = "Lifetime realized trading + rewards";
export const LOSS_RECOVERY_NOTE =
  "Remaining realized trading losses after claimed + claimable USDC rewards. Excludes open P&L and PAPER holdings.";

export interface WalletPerformance {
  pnl: string;
  pnlTone: "positive" | "negative" | "neutral";
  pnlNote: string;
  tradingPnl: string;
  tradingPnlTone: "positive" | "negative" | "neutral";
  rewards: string;
  rewardsNote: string;
  unrecoveredLoss: string;
  unrecoveredLossNote: string;
  unrecoveredLossStatus: "loss" | "recovered" | "unavailable";
}

function signedUsd(raw: bigint | null): string {
  const formatted = formatRawUsd(raw?.toString());
  return raw !== null && raw > 0n ? `+${formatted}` : formatted;
}

function rawAmount(
  raw: string | null | undefined,
  signed = false,
): bigint | null {
  return raw != null && (signed ? /^-?\d+$/ : /^\d+$/).test(raw)
    ? BigInt(raw)
    : null;
}

function pnlTone(raw: bigint | null): WalletPerformance["pnlTone"] {
  return raw === null || raw === 0n
    ? "neutral"
    : raw < 0n
      ? "negative"
      : "positive";
}

/** Shared account performance for the live wallet and its captured P&L card. */
export function walletPerformance(
  wallet: WalletResponse,
  at = Date.now(),
  refreshFailed = false,
): WalletPerformance {
  const account = wallet.snapshot;
  const rawTradingPnl = rawAmount(account?.lifetime.realizedPnlRaw, true);
  const claimed = rawAmount(account?.lifetime.paperRewardsClaimedRaw);
  // pendingBase is only an accrued component, not verified claimable rewards.
  const pending = account ? rawAmount(wallet.stakingRewards?.pendingRaw) : null;
  const rawRewards =
    claimed !== null && pending !== null ? claimed + pending : null;
  const rawPnl =
    rawTradingPnl !== null && rawRewards !== null
      ? rawTradingPnl + rawRewards
      : null;
  const rewardsDelayed =
    wallet.stakingRewards?.stale ||
    [wallet.stakingRewards?.receivedAt, wallet.stakingRewards?.sourceAt].some(
      (observedAt) =>
        observedAt == null ||
        !Number.isSafeInteger(observedAt) ||
        observedAt <= 0 ||
        observedAt > at + 30_000 ||
        at - observedAt > 30_000,
    );
  const unavailable = !account
    ? "Account snapshot unavailable"
    : rawTradingPnl === null
      ? "Trading P&L unavailable"
      : claimed === null
        ? "Claimed rewards unavailable"
        : pending === null
          ? "Pending rewards unavailable"
          : null;
  const accountDelayed = walletAccountClock(wallet, refreshFailed, at).stale;
  const delayed = rewardsDelayed || accountDelayed;
  const remainingLoss = rawPnl === null ? null : rawPnl < 0n ? -rawPnl : 0n;
  const unrecoveredLoss = remainingLoss !== null && remainingLoss > 0n && remainingLoss < 10n ** 16n
    ? "<$0.01"
    : formatRawUsd(remainingLoss?.toString());
  const unrecoveredLossStatus: WalletPerformance["unrecoveredLossStatus"] =
    remainingLoss === null ? "unavailable" : remainingLoss === 0n ? "recovered" : "loss";

  return {
    pnl: signedUsd(rawPnl),
    pnlTone: pnlTone(rawPnl),
    pnlNote:
      pending === null
        ? "Pending rewards unavailable"
        : claimed === null
          ? "Claimed rewards unavailable"
          : WALLET_PERFORMANCE_NOTE,
    tradingPnl: signedUsd(rawTradingPnl),
    tradingPnlTone: pnlTone(rawTradingPnl),
    rewards: signedUsd(rawRewards),
    rewardsNote:
      pending === null
        ? claimed === null
          ? "Claimed + pending unavailable"
          : `Claimed ${signedUsd(claimed)} · pending unavailable`
        : claimed === null
          ? "Claimed rewards unavailable"
          : `Claimed + pending · USDC${rewardsDelayed ? " · delayed" : ""}`,
    unrecoveredLoss,
    unrecoveredLossStatus,
    unrecoveredLossNote:
      unavailable ?? `USDC after rewards${delayed ? " · last available" : ""}`,
  };
}
