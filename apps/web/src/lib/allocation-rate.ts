import { VERIFIED_TRADING_WINDOW } from "../../../../packages/shared/src/trading-launch";
import type { PaperEconomicsResponse } from "../../../../packages/shared/src/types";
import { validChartTime } from "./chart-data";

const DAY_MS = 86_400_000n;

function unsignedRaw(value: string | null | undefined): bigint | null {
  return typeof value === "string" && /^(0|[1-9]\d{0,77})$/.test(value)
    ? BigInt(value)
    : null;
}

/** A legacy cached rate must never inherit the corrected trading-window label. */
export function allocationRateForDisplay(
  data: Pick<PaperEconomicsResponse, "annualized" | "sourceAt" | "allocatedRewardsRaw"> | null | undefined,
) {
  const value = data?.annualized;
  if (
    !value ||
    value.basis !== "observed-trading-window" ||
    value.cutoffBasis !== VERIFIED_TRADING_WINDOW.cutoffBasis ||
    value.fromMs !== VERIFIED_TRADING_WINDOW.fromMs ||
    value.baselineRewardsRaw !== VERIFIED_TRADING_WINDOW.baselineRewardsRaw ||
    value.yearDays !== 365 ||
    !validChartTime(value.toMs) ||
    value.toMs <= value.fromMs ||
    value.toMs !== data.sourceAt ||
    value.lifetimeRewardsRaw !== data.allocatedRewardsRaw
  )
    return null;

  const lifetime = unsignedRaw(value.lifetimeRewardsRaw),
    baseline = unsignedRaw(value.baselineRewardsRaw),
    allocated = unsignedRaw(value.allocatedSinceStartRaw),
    daily = unsignedRaw(value.usdPerDayRaw),
    annual = unsignedRaw(value.usdPerYearRaw);
  if (
    lifetime === null || baseline === null || allocated === null ||
    daily === null || annual === null ||
    lifetime < baseline || lifetime - baseline !== allocated
  )
    return null;

  const elapsed = BigInt(value.toMs - value.fromMs);
  if (
    daily !== allocated * DAY_MS / elapsed ||
    annual !== allocated * DAY_MS * 365n / elapsed
  )
    return null;

  return {
    usdPerDayRaw: daily.toString(),
    usdPerYearRaw: annual.toString(),
    baselineRewardsRaw: baseline.toString(),
    fromMs: value.fromMs,
    toMs: value.toMs,
  };
}

export function allocationWindowTime(time: number): string {
  return `${new Date(time).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  })} UTC`;
}
