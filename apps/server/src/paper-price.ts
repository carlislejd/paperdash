import type { PaperPriceQuote } from "../../../packages/shared/src/types.js";
import {
  PAPER_PRICE_MAX_AGE_MS,
  validPaperPrice,
} from "../../../packages/shared/src/paper-price.js";
import type { Store } from "./store.js";
import { retryAfter } from "./upstream.js";

export const PAPER_PRICE_INTERVAL_MS = 10000;
export const PAPER_PRICE_KEY = "paper-price";
const STATUS_KEY = "paper-price-status";
const TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 32768;
type Context = Pick<Store, "get" | "put">;
interface RefreshStatus { failures: number; retryAt: number }

class PaperPriceError extends Error {
  constructor(message: string, public retryAt = 0) { super(message); }
}

function decimalRaw(value: unknown): bigint | null {
  if (typeof value !== "string" || value.length > 79 ||
      !/^(0|[1-9]\d{0,59})(?:\.\d{1,18})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const raw = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
  return raw > 0n ? raw : null;
}

/** L2 snapshots carry a source timestamp; allMids has no equivalent clock. */
export function decodePaperPrice(input: unknown, receivedAt = Date.now()): PaperPriceQuote | null {
  if (!input || typeof input !== "object") return null;
  const book = input as { coin?: unknown; time?: unknown; levels?: unknown };
  if (book.coin !== "para:PAPER" || !Array.isArray(book.levels) ||
      book.levels.length !== 2 || !Number.isSafeInteger(book.time) ||
      typeof book.time !== "number" || receivedAt - book.time > PAPER_PRICE_MAX_AGE_MS)
    return null;
  const prices = book.levels.map((levels: unknown) => {
    if (!Array.isArray(levels) || levels.length < 1 || levels.length > 20) return null;
    const level = levels[0];
    return level && typeof level === "object" ? decimalRaw(level.px) : null;
  });
  const [bid, ask] = prices;
  if (bid === null || ask === null || ask < bid) return null;
  return validPaperPrice({
    source: "hyperliquid", market: "para:PAPER", basis: "perp-mid",
    priceUsdRaw: ((bid + ask) / 2n).toString(),
    bidUsdRaw: bid.toString(), askUsdRaw: ask.toString(),
    sourceAt: book.time, receivedAt,
  });
}

async function readBook(response: Response): Promise<unknown> {
  if (!response.body) throw new PaperPriceError("PAPER price response is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES)
        throw new PaperPriceError("PAPER price response exceeds its size limit.");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** One invocation per collector loop. Viewers only read the saved projection. */
export async function refreshPaperPrice(
  store: Context,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
): Promise<void> {
  const [saved, savedStatus] = await Promise.all([
    store.get<PaperPriceQuote>(PAPER_PRICE_KEY),
    store.get<RefreshStatus>(STATUS_KEY),
  ]);
  const previous = validPaperPrice(saved?.value);
  const status = savedStatus?.value;
  const failures = Number.isSafeInteger(status?.failures) && status!.failures > 0
    ? Math.min(status!.failures, 6) : 0;
  if (Number.isSafeInteger(status?.retryAt) && status!.retryAt > clock())
    throw new PaperPriceError("PAPER reference price is waiting to retry.", status!.retryAt);
  try {
    const response = await fetcher("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "l2Book", coin: "para:PAPER" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
    if (!response.ok) {
      const deadline = retryAfter(response.headers.get("Retry-After"), clock());
      await response.body?.cancel();
      throw new PaperPriceError(`PAPER reference price HTTP ${response.status}.`, deadline);
    }
    const book = await readBook(response);
    const quote = decodePaperPrice(book, clock());
    if (!quote) throw new PaperPriceError("PAPER reference book is invalid or delayed.");
    if (previous && (quote.sourceAt < previous.sourceAt ||
        (quote.sourceAt === previous.sourceAt &&
          (quote.bidUsdRaw !== previous.bidUsdRaw || quote.askUsdRaw !== previous.askUsdRaw))))
      throw new PaperPriceError("PAPER reference book moved backward; retaining the saved quote.");
    // The same source snapshot cannot renew its receipt clock after a retry.
    if (!previous || quote.sourceAt > previous.sourceAt)
      await store.put(PAPER_PRICE_KEY, quote, quote.receivedAt);
    if (failures || status?.retryAt)
      await store.put(STATUS_KEY, { failures: 0, retryAt: 0 }, clock());
  } catch (error) {
    const failedAt = clock();
    const retryAt = Math.max(
      failedAt + Math.min(PAPER_PRICE_INTERVAL_MS * 2 ** failures, 300000),
      error instanceof PaperPriceError ? error.retryAt : 0,
    );
    // Persist only bounded control state, never untrusted response/error text.
    await store.put(STATUS_KEY, { failures: Math.min(failures + 1, 6), retryAt }, failedAt);
    throw new PaperPriceError(
      error instanceof PaperPriceError ? error.message : "PAPER reference price refresh failed.",
      retryAt,
    );
  }
}
