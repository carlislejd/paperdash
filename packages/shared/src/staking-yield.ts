import type { AnnualizedStakerYield } from "./types.js";
export type { AnnualizedStakerYield } from "./types.js";

export const VERIFIED_PROTOCOL_GENESIS = 1791326520000;
const YEAR_MS = 365n * 24n * 60n * 60n * 1000n;
const ACCUMULATOR_TO_USDC_RAW = 10n ** 9n;
const HOUR_MS = 3600000;
export interface StakingYieldObservation {
  at: number;
  genesis: number;
  accumulatorRaw: string;
}
const validClock = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) &&
  value >= 0 && value <= 8.64e15;

export function validYieldObservation(
  value: StakingYieldObservation | null | undefined,
  now: number,
): value is StakingYieldObservation {
  return Boolean(value && validClock(now) && validClock(value.at) &&
    value.genesis === VERIFIED_PROTOCOL_GENESIS &&
    value.at >= value.genesis && value.at <= now + 30000 &&
    typeof value.accumulatorRaw === "string" &&
    /^(0|[1-9]\d{0,77})$/.test(value.accumulatorRaw));
}

/** The 1e27 accumulator integrates stake share at every actual distribution.
 * Use a measured delta, never an assumed zero accumulator at genesis. Keep
 * full precision through annualization, including partial hours and zero-
 * reward intervals; truncate only the final result to 18-decimal USDC. */
export function annualizedStakerYield(
  from: StakingYieldObservation | null,
  to: StakingYieldObservation | null,
  now = Date.now(),
): AnnualizedStakerYield {
  const base: AnnualizedStakerYield = {
    usdPerPaperPerYearRaw: null,
    earnedUsdPerPaperRaw: null,
    fromMs: null,
    toMs: null,
    elapsedMs: null,
    basis: "observed-accumulator",
    yearDays: 365,
  };
  if (!validYieldObservation(from, now) || !validYieldObservation(to, now))
    return { ...base, reason: "Waiting for comparable staking reward observations." };
  if (to.at < from.at || BigInt(to.accumulatorRaw) < BigInt(from.accumulatorRaw))
    return { ...base, reason: "Staking reward observations are inconsistent." };
  const elapsedMs = to.at - from.at;
  const delta = BigInt(to.accumulatorRaw) - BigInt(from.accumulatorRaw);
  const observed = {
    ...base,
    fromMs: from.at,
    toMs: to.at,
    elapsedMs,
    earnedUsdPerPaperRaw: (delta / ACCUMULATOR_TO_USDC_RAW).toString(),
  };
  if (elapsedMs < HOUR_MS)
    return { ...observed, reason: "Collecting the first hour of staking rewards." };
  return {
    ...observed,
    usdPerPaperPerYearRaw: (
      (delta * YEAR_MS) / (ACCUMULATOR_TO_USDC_RAW * BigInt(elapsedMs))
    ).toString(),
  };
}
