import type { PaperPriceQuote } from "../../../../packages/shared/src/types";
import { validPaperPrice } from "../../../../packages/shared/src/paper-price";
import { formatRawUsd } from "./format";

export const PARAGON_LABEL = "Paragon premarket price";
export const PARAGON_STORAGE_KEY = "paperclub:paragon-estimates:v1";
export const PARAGON_VALUE_NOTE =
  "Current PAPER × the Paragon PAPER perpetual midpoint on Hyperliquid. Estimated USDC value; sale proceeds depend on liquidity and execution.";
export const PARAGON_PNL_NOTE =
  "Adds current PAPER value to the displayed lifetime P&L. PAPER acquisition costs are unknown, so this is a combined estimate rather than token investment profit.";

function rawAmount(value: unknown, signed = false): bigint | null {
  return typeof value === "string" &&
    (signed ? /^-?\d{1,78}$/ : /^\d{1,78}$/).test(value)
    ? BigInt(value) : null;
}

/** Both inputs have 18 decimals. Round only at the final raw USDC unit. */
export function paperValueRaw(
  paperRaw: string | null | undefined,
  quote: PaperPriceQuote | null | undefined,
): string | null {
  const paper = rawAmount(paperRaw);
  const price = validPaperPrice(quote);
  return paper === null || !price ? null
    : (paper * BigInt(price.priceUsdRaw) / 10n ** 18n).toString();
}

export function addPaperValueRaw(
  baseRaw: string | null | undefined,
  paperRaw: string | null | undefined,
  quote: PaperPriceQuote | null | undefined,
): string | null {
  const base = rawAmount(baseRaw, true);
  const value = paperValueRaw(paperRaw, quote);
  return base === null || value === null ? null : (base + BigInt(value)).toString();
}

export function formatParagonValue(raw: string | null | undefined, compact = false): string {
  // A product of two bounded raw amounts can be larger than either input.
  if (typeof raw !== "string" || !/^-?\d{1,156}$/.test(raw)) return "Unavailable";
  const amount = BigInt(raw);
  if (amount !== 0n && amount > -5_000_000_000_000_000n && amount < 5_000_000_000_000_000n)
    return amount < 0n ? ">−$0.01" : "<$0.01";
  return formatRawUsd(raw, compact);
}
