import type { WalletResponse } from "../../../../packages/shared/src/types";

const unsigned = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9]\d{0,77})$/.test(value);
const clock = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
const superscript = (value: number) =>
  String(value).replace(/[-0-9]/g, digit => "⁻⁰¹²³⁴⁵⁶⁷⁸⁹"["-0123456789".indexOf(digit)]);

/** Integer arithmetic preserves small stakes and very large pool totals.
 * Six decimal places normally; tiny positive shares use four significant digits. */
export function formatStakingShare(walletRaw: string, poolRaw: string): string | null {
  if (!unsigned(walletRaw) || !unsigned(poolRaw)) return null;
  const wallet = BigInt(walletRaw), pool = BigInt(poolRaw);
  if (pool === 0n || wallet > pool) return null;
  if (wallet === 0n) return "0%";
  const scaled = wallet * 100_000_000n / pool;
  if (scaled >= 100n) {
    const fraction = (scaled % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    return `${scaled / 1_000_000n}${fraction ? `.${fraction}` : ""}%`;
  }
  // Inputs have at most 78 digits, so 80 places always preserve a nonzero share.
  const digits = (wallet * 100n * 10n ** 80n / pool).toString();
  const fraction = digits.slice(1, 4).replace(/0+$/, "");
  return `${digits[0]}${fraction ? `.${fraction}` : ""} × 10${superscript(digits.length - 81)}%`;
}

/** Never recombine a cached stake with a newer independently fetched pool total. */
export function walletStakingShare(
  wallet: WalletResponse | null,
  now = Date.now(),
  refreshError = false,
) {
  const pair = wallet?.stakingParticipation;
  if (!pair || !unsigned(pair.walletStakedRaw) || !unsigned(pair.totalStakedRaw) ||
    pair.walletStakedRaw !== wallet?.snapshot?.paper.staked ||
    !clock(pair.sourceAt) || !clock(pair.receivedAt) || !clock(now) ||
    pair.sourceAt > now + 30_000 || pair.receivedAt > now + 30_000 ||
    pair.sourceAt > pair.receivedAt + 30_000) return null;
  const label = formatStakingShare(pair.walletStakedRaw, pair.totalStakedRaw);
  if (label === null) return null;
  return {
    ...pair,
    label,
    stale: pair.stale || refreshError ||
      now - pair.sourceAt > 30_000 || now - pair.receivedAt > 30_000,
  };
}
