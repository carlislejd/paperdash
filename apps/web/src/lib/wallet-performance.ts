import type { WalletResponse } from "../../../../packages/shared/src/types";
import { formatRawUsd } from "./format";
import { walletAccountClock } from "./wallet-account-clock";

export const WALLET_PERFORMANCE_NOTE = "Lifetime realized trading + rewards";
export const PAPER_BREAK_EVEN_NOTE =
  "Remaining realized trading losses after claimed + pending rewards ÷ PAPER owned (staked + unstaked). Excludes open P&L and token price; not an acquisition cost.";

export interface WalletPerformance {
  pnl: string;
  pnlTone: "positive" | "negative" | "neutral";
  pnlNote: string;
  tradingPnl: string;
  tradingPnlTone: "positive" | "negative" | "neutral";
  rewards: string;
  rewardsNote: string;
  paperBreakEven: string;
  paperBreakEvenNote: string;
  paperBreakEvenStatus: "price" | "recovered" | "unavailable";
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
  const balance = rawAmount(account?.paper.balance);
  const staked = rawAmount(account?.paper.staked);
  const paper = balance !== null && staked !== null ? balance + staked : null;
  const unavailable = !account
    ? "Account snapshot unavailable"
    : rawTradingPnl === null
      ? "Trading P&L unavailable"
      : claimed === null
        ? "Claimed rewards unavailable"
        : pending === null
          ? "Pending rewards unavailable"
          : paper === null
            ? "PAPER balance unavailable"
            : paper === 0n
              ? "No PAPER owned"
              : null;
  const delayed =
    rewardsDelayed || walletAccountClock(wallet, refreshFailed, at).stale;
  let paperBreakEven = "—";
  let paperBreakEvenStatus: WalletPerformance["paperBreakEvenStatus"] =
    "unavailable";
  if (unavailable === null && rawPnl !== null && paper !== null && paper > 0n) {
    if (rawPnl >= 0n) {
      paperBreakEven = "Cost recovered";
      paperBreakEvenStatus = "recovered";
    } else {
      // Both amounts have 18 decimals. Keep their ratio exact until display;
      // a positive amount below the display precision must not look recovered.
      const micros = (-rawPnl * 1_000_000n) / paper;
      const rounded = (-rawPnl * 1_000_000n + paper / 2n) / paper;
      paperBreakEven =
        micros === 0n
          ? "<$0.000001"
          : `$${(rounded / 1_000_000n).toLocaleString("en-US")}.${(rounded % 1_000_000n).toString().padStart(6, "0")}`;
      paperBreakEvenStatus = "price";
    }
  }

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
    paperBreakEven,
    paperBreakEvenStatus,
    paperBreakEvenNote:
      unavailable ?? `USDC per PAPER${delayed ? " · last available" : ""}`,
  };
}
