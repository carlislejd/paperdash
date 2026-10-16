import { describe, expect, it } from "vitest";
import { allocationRateForDisplay } from "../apps/web/src/lib/allocation-rate";
import { VERIFIED_TRADING_WINDOW } from "../packages/shared/src/trading-launch";
import type { AnnualizedStakingRevenue, PaperEconomicsResponse } from "../packages/shared/src/types";

const sourceAt = VERIFIED_TRADING_WINDOW.fromMs + 2 * 86_400_000;
function response(): Pick<PaperEconomicsResponse, "annualized" | "sourceAt" | "allocatedRewardsRaw"> {
  return {
    sourceAt,
    allocatedRewardsRaw: "7",
    annualized: {
      basis: "observed-trading-window",
      cutoffBasis: VERIFIED_TRADING_WINDOW.cutoffBasis,
      fromMs: VERIFIED_TRADING_WINDOW.fromMs,
      toMs: sourceAt,
      baselineRewardsRaw: "0",
      lifetimeRewardsRaw: "7",
      allocatedSinceStartRaw: "7",
      usdPerDayRaw: "3",
      usdPerYearRaw: "1277",
      yearDays: 365,
    },
  };
}

describe("allocation rate display compatibility", () => {
  it("accepts independently rounded daily and annual rates over the verified source interval", () => {
    expect(allocationRateForDisplay(response())).toEqual({
      usdPerDayRaw: "3",
      usdPerYearRaw: "1277",
      baselineRewardsRaw: "0",
      fromMs: VERIFIED_TRADING_WINDOW.fromMs,
      toMs: sourceAt,
    });
  });

  it.each<[string, Partial<AnnualizedStakingRevenue>]>([
    ["legacy lifetime basis", { basis: "protocol-lifetime" }],
    ["unverified cutoff", { fromMs: VERIFIED_TRADING_WINDOW.fromMs - 86_400_000 }],
    ["missing cutoff provenance", { cutoffBasis: undefined }],
    ["missing baseline", { baselineRewardsRaw: undefined }],
    ["different baseline", { baselineRewardsRaw: "1" }],
    ["missing numerator", { allocatedSinceStartRaw: undefined }],
    ["inconsistent numerator", { allocatedSinceStartRaw: "8" }],
    ["mismatched summary", { lifetimeRewardsRaw: "8" }],
    ["missing daily rate", { usdPerDayRaw: undefined }],
    ["malformed annual rate", { usdPerYearRaw: "1e10" }],
    ["negative annual rate", { usdPerYearRaw: "-1" }],
    ["oversized annual rate", { usdPerYearRaw: "9".repeat(79) }],
    ["mismatched daily rate", { usdPerDayRaw: "4" }],
    ["mismatched annual rate", { usdPerYearRaw: "1278" }],
    ["missing source endpoint", { toMs: null }],
    ["mismatched source endpoint", { toMs: sourceAt - 1 }],
    ["empty interval", { toMs: VERIFIED_TRADING_WINDOW.fromMs }],
    ["reversed interval", { toMs: VERIFIED_TRADING_WINDOW.fromMs - 1 }],
  ])("does not display a corrected rate for %s", (_name, invalid) => {
    const data = response();
    Object.assign(data.annualized, invalid);
    expect(allocationRateForDisplay(data)).toBeNull();
  });

  it("keeps measured zero distinct from unavailable", () => {
    const data = response();
    data.allocatedRewardsRaw = "0";
    Object.assign(data.annualized, {
      lifetimeRewardsRaw: "0",
      allocatedSinceStartRaw: "0",
      usdPerDayRaw: "0",
      usdPerYearRaw: "0",
    });
    expect(allocationRateForDisplay(data)?.usdPerYearRaw).toBe("0");
    data.annualized.usdPerYearRaw = null;
    expect(allocationRateForDisplay(data)).toBeNull();
    expect(allocationRateForDisplay(null)).toBeNull();
  });
});
