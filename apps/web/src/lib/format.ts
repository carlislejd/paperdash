export function rawToNumber(
  raw: string | null | undefined,
  decimals = 18,
): number | null {
  if (
    raw == null ||
    !/^-?\d+$/.test(raw) ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255
  )
    return null;
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(decimals + 1, "0");
  const decimal =
    decimals === 0
      ? digits
      : `${digits.slice(0, -decimals) || "0"}.${digits.slice(-decimals)}`;
  const value = Number(`${negative ? "-" : ""}${decimal}`);
  return Number.isFinite(value) ? value : null;
}
// Charts format many executions on each live update. Reuse the two immutable
// formatters so rendering does not repeatedly construct locale machinery.
const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "standard",
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});
const compactUsdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

export function formatUsd(
  value: number | null | undefined,
  compact = false,
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return (compact ? compactUsdFormatter : usdFormatter).format(value);
}
export function formatRawUsd(
  raw: string | null | undefined,
  compact = false,
): string {
  if (compact) return formatUsd(rawToNumber(raw), true);
  if (raw == null || !/^-?\d+$/.test(raw)) return "—";
  const value = BigInt(raw);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const cents = (absolute + 5_000_000_000_000_000n) / 10_000_000_000_000_000n;
  return `${negative ? "−" : ""}$${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
}
/** Exact 18-decimal token amounts; compact output is only a display approximation. */
export function formatRawToken(
  raw: string | null | undefined,
  compact = false,
): string {
  if (raw == null || !/^\d+$/.test(raw)) return "—";
  if (compact) {
    const value = rawToNumber(raw);
    if (value === null) return "—";
    return new Intl.NumberFormat("en-US", {
      notation:
        value >= 1e15 || (value > 0 && value < 0.01) ? "scientific" : "compact",
      maximumFractionDigits: 2,
    }).format(value);
  }
  const value = BigInt(raw);
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n)
    .toString()
    .padStart(18, "0")
    .replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}
export const shortAddress = (address: string) =>
  `${address.slice(0, 6)}…${address.slice(-4)}`;
export function relativeTime(time: number | null | undefined): string {
  if (!time) return "Awaiting data";
  const milliseconds = time < 1e12 ? time * 1000 : time;
  const seconds = Math.max(0, Math.floor((Date.now() - milliseconds) / 1000));
  if (seconds < 5) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
