import type { StakingRewardDay } from "../../../../packages/shared/src/types";
import { formatRawToken } from "./format";

const raw = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9]\d{0,77})$/.test(value);

export function participationChanges(value: StakingRewardDay["participation"]) {
  if (!value || !raw(value.supplyFromRaw) || !raw(value.supplyToRaw) ||
    !raw(value.stakedFromRaw) || !raw(value.stakedToRaw) ||
    BigInt(value.stakedFromRaw) > BigInt(value.supplyFromRaw) ||
    BigInt(value.stakedToRaw) > BigInt(value.supplyToRaw)) return null;
  return {
    supply: balanceChange(value.supplyFromRaw, value.supplyToRaw),
    staked: balanceChange(value.stakedFromRaw, value.stakedToRaw),
  };
}

function balanceChange(fromRaw: string, toRaw: string) {
  const from = BigInt(fromRaw), to = BigInt(toRaw), delta = to - from;
  const absolute = delta < 0n ? -delta : delta;
  const sign = delta < 0n ? "−" : delta > 0n ? "+" : "";
  const title = `${formatRawToken(fromRaw)} → ${formatRawToken(toRaw)} PAPER; net change ${sign}${formatRawToken(absolute.toString())} PAPER`;
  if (from === 0n) return { label: "—", title: `${title}. Percentage unavailable: starting balance was zero.` };
  if (delta === 0n) return { label: "0.00%", title };
  // Keep tiny nonzero changes visible, and never divide large raw balances
  // through Number before calculating their relative change.
  if (absolute * 10_000n < from) return { label: `${sign}<0.01%`, title };
  const hundredths = (absolute * 10_000n + from / 2n) / from;
  return {
    label: `${sign}${(hundredths / 100n).toLocaleString("en-US")}.${(hundredths % 100n).toString().padStart(2, "0")}%`,
    title,
  };
}
