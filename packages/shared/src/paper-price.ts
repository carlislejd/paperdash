import type { PaperPriceQuote } from "./types.js";

export const PAPER_PRICE_MAX_AGE_MS = 60000;

const rawPrice = (value: unknown): value is string =>
  typeof value === "string" && /^[1-9]\d{0,77}$/.test(value);
const timestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) &&
  value > 0 && value <= 8.64e15;

/** Validate saved data without discarding an otherwise valid, delayed quote. */
export function validPaperPrice(value: unknown): PaperPriceQuote | null {
  if (!value || typeof value !== "object") return null;
  const quote = value as Partial<PaperPriceQuote>;
  if (
    quote.source !== "hyperliquid" || quote.market !== "para:PAPER" ||
    quote.basis !== "perp-mid" || !rawPrice(quote.priceUsdRaw) ||
    !rawPrice(quote.bidUsdRaw) || !rawPrice(quote.askUsdRaw) ||
    !timestamp(quote.sourceAt) || !timestamp(quote.receivedAt) ||
    quote.sourceAt > quote.receivedAt + 30000
  ) return null;
  const bid = BigInt(quote.bidUsdRaw), ask = BigInt(quote.askUsdRaw);
  if (ask < bid || BigInt(quote.priceUsdRaw) !== (bid + ask) / 2n) return null;
  return quote as PaperPriceQuote;
}

/** A cached response cannot renew the source book or collector receipt clock. */
export function paperPriceDelayed(value: unknown, now = Date.now()): boolean {
  const quote = validPaperPrice(value);
  return !quote || !timestamp(now) ||
    [quote.sourceAt, quote.receivedAt].some((at) =>
      at > now || now - at > PAPER_PRICE_MAX_AGE_MS,
    );
}
