import { describe, expect, it } from "vitest";
import type { AnnualizedStakerYield } from "../packages/shared/src/staking-yield";
import {
  formatStakerApr,
  formatStakerYield,
  formatYieldHours,
  formatPaperPrice,
  stakerYieldDelayed,
  stakerYieldRate,
} from "../apps/web/src/lib/staker-yield";

const SCALE = 10n ** 18n;
const at = Date.UTC(2026, 9, 10, 12, 25);
const measured: AnnualizedStakerYield = {
  usdPerPaperPerYearRaw: "25000000000000000",
  earnedUsdPerPaperRaw: "69206621004566",
  fromMs: at - 87_300_000,
  toMs: at,
  elapsedMs: 87_300_000,
  basis: "observed-accumulator",
  yearDays: 365,
};

describe("staker yield display", () => {
  it("marks an aging, malformed or future source or receipt clock as delayed", () => {
    const fresh = { sourceAt: at, receivedAt: at, stale: false };
    expect(stakerYieldDelayed(fresh, at)).toBe(false);
    expect(stakerYieldDelayed(fresh, at + 30_000)).toBe(false);
    expect(stakerYieldDelayed(fresh, at + 30_001)).toBe(true);
    expect(stakerYieldDelayed({ ...fresh, stale: true }, at)).toBe(true);
    expect(stakerYieldDelayed({ ...fresh, error: "Failed" }, at)).toBe(true);
    for (const time of [null, 0, Number.NaN, Infinity, at + 1, at - 30_001]) {
      expect(stakerYieldDelayed({ ...fresh, sourceAt: time }, at)).toBe(true);
      expect(stakerYieldDelayed({ ...fresh, receivedAt: time }, at)).toBe(true);
    }
  });

  it("requires a complete measured interval of at least one hour", () => {
    expect(stakerYieldRate(measured)).toBe(measured.usdPerPaperPerYearRaw);
    expect(stakerYieldRate({ ...measured, usdPerPaperPerYearRaw: "0" })).toBe("0");
    for (const value of [
      undefined,
      null,
      { ...measured, usdPerPaperPerYearRaw: null },
      { ...measured, usdPerPaperPerYearRaw: "-1" },
      { ...measured, elapsedMs: 0 },
      { ...measured, elapsedMs: 87_300_001 },
      { ...measured, fromMs: at - 3_599_999, elapsedMs: 3_599_999 },
      { ...measured, fromMs: null },
      { ...measured, toMs: Number.NaN },
      { ...measured, fromMs: at, toMs: at + 0.5, elapsedMs: 0.5 },
    ]) expect(stakerYieldRate(value)).toBeNull();
  });

  it("shows annual USDC per 1,000 PAPER without hiding a small positive rate", () => {
    expect(formatStakerYield(measured.usdPerPaperPerYearRaw)).toBe("$25.00");
    expect(formatStakerYield("0")).toBe("$0.00");
    expect(formatStakerYield("1")).toBe("<$0.01");
    expect(formatStakerYield("4999999999999")).toBe("<$0.01");
    expect(formatStakerYield("5000000000000")).toBe("$0.01");
    expect(formatStakerYield(((9007199254740993n * SCALE + 12n * 10n ** 16n) / 1000n).toString())).toBe("$9,007,199,254,740,993.12");
    for (const value of [null, undefined, "", "-1", "0.01", "1e18"])
      expect(formatStakerYield(value)).toBe("—");
  });

  it("keeps partial hours in the measured interval", () => {
    expect(formatYieldHours(87_300_000)).toBe("24.25");
    expect(formatYieldHours(3_600_123)).toBe("1.000034");
    expect(formatYieldHours(4_813_200_000)).toBe("1,337");
    for (const value of [null, undefined, 0, -1, Infinity, 0.5])
      expect(formatYieldHours(value)).toBe("—");
  });
});

describe("feed-backed PAPER price and simple APR", () => {
  it("formats the quote without floating-point loss or a false zero", () => {
    expect(formatPaperPrice("24700000000000000")).toBe("$0.0247");
    expect(formatPaperPrice("500000000000000000")).toBe("$0.5");
    expect(formatPaperPrice("1")).toBe("<$0.00000001");
    expect(formatPaperPrice("5000000000")).toBe("$0.00000001");
    expect(formatPaperPrice("999999999999999999")).toBe("$1");
    expect(formatPaperPrice("9007199254740993123456789012345678")).toBe("$9,007,199,254,740,993.12345679");
    for (const value of [null, undefined, "", "0", "-1", "0.5", "1e18", "1".repeat(79)])
      expect(formatPaperPrice(value)).toBe("—");
  });

  it("computes simple APR from raw feed values exactly, keeping zero separate from unavailable", () => {
    const half = "500000000000000000";
    expect(formatStakerApr("25000000000000000", half)).toBe("5.00%");
    expect(formatStakerApr("108590000000000000", "24700000000000000")).toBe("439.64%");
    expect(formatStakerApr("0", half)).toBe("0.00%");
    expect(formatStakerApr("1", half)).toBe("<0.01%");
    expect(formatStakerApr("24999999999999", half)).toBe("<0.01%");
    expect(formatStakerApr("25000000000000", half)).toBe("0.01%");
    expect(formatStakerApr((9007199254740993n * SCALE).toString(), (9007199254740993n * SCALE).toString())).toBe("100.00%");
    expect(formatStakerApr("1", "1")).toBe("100.00%");
    for (const price of [null, undefined, "", "0", "-1", "1e2", "no price", "1".repeat(79)])
      expect(formatStakerApr("25000000000000000", price)).toBe("—");
    expect(formatStakerApr(null, half)).toBe("—");
    expect(formatStakerApr("-1", half)).toBe("—");
  });
});
