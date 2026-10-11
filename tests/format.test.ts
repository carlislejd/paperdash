import { describe, expect, it } from "vitest";
import {
  formatRawToken,
  formatRawUsd,
  formatUsd,
  rawToNumber,
} from "../apps/web/src/lib/format";

describe("raw amount conversion for chart display", () => {
  it("handles integer assets with zero decimals without shifting the amount", () => {
    expect(rawToNumber("12345", 0)).toBe(12345);
    expect(rawToNumber("-42", 0)).toBe(-42);
    expect(rawToNumber("0", 0)).toBe(0);
  });

  it("distinguishes native USDC units and protocol accounting units", () => {
    expect(rawToNumber("10779000000", 6)).toBe(10779);
    expect(rawToNumber("10779000000000000000000")).toBe(10779);
    expect(rawToNumber("1", 18)).toBe(1e-18);
    expect(rawToNumber("-1250000", 6)).toBe(-1.25);
  });

  it("rejects invalid raw amounts, scales and overflowing chart values", () => {
    for (const raw of [null, undefined, "", "1.2", "1e18", "NaN", "--1", "+5"])
      expect(rawToNumber(raw)).toBeNull();
    for (const scale of [-1, 0.5, Number.NaN, Infinity, 256])
      expect(rawToNumber("10", scale)).toBeNull();
    expect(rawToNumber("9".repeat(400), 0)).toBeNull();
    expect(formatUsd(Infinity)).toBe("—");
    expect(formatUsd(Number.NaN)).toBe("—");
  });
});

describe("exact raw USDC formatting", () => {
  it("rounds at half-cent boundaries using integer arithmetic", () => {
    expect(formatRawUsd("4999999999999999")).toBe("$0.00");
    expect(formatRawUsd("5000000000000000")).toBe("$0.01");
    expect(formatRawUsd("-5000000000000000")).toBe("−$0.01");
    expect(formatRawUsd("9994999999999999999")).toBe("$9.99");
    expect(formatRawUsd("9995000000000000000")).toBe("$10.00");
  });

  it("preserves cents for values above the safe floating point range", () => {
    const whole = 9007199254740993n;
    expect(
      formatRawUsd((whole * 10n ** 18n + 12n * 10n ** 16n).toString()),
    ).toBe("$9,007,199,254,740,993.12");
    expect(
      formatRawUsd((whole * 10n ** 18n + 125n * 10n ** 15n).toString()),
    ).toBe("$9,007,199,254,740,993.13");
    const maxUint256 = (2n ** 256n - 1n).toString();
    expect(formatRawUsd(maxUint256)).toBe(
      "$115,792,089,237,316,195,423,570,985,008,687,907,853,269,984,665,640,564,039,457.58",
    );
  });

  it("keeps unavailable distinct from zero", () => {
    expect(formatRawUsd(null)).toBe("—");
    expect(formatRawUsd("invalid")).toBe("—");
    expect(formatRawUsd("0")).toBe("$0.00");
    expect(formatRawUsd("-0")).toBe("$0.00");
  });
});

describe("PAPER ownership display", () => {
  it("preserves every raw decimal in the exact amount and keeps compact output bounded", () => {
    const raw = "3003199186757525433019603";
    expect(formatRawToken(raw)).toBe("3,003,199.186757525433019603");
    expect(formatRawToken(raw, true)).toBe("3M");
    expect(formatRawToken("1")).toBe("0.000000000000000001");
    expect(formatRawToken("1", true)).toBe("1E-18");
    expect(formatRawToken("1000000000000000", true)).toBe("1E-3");
    expect(formatRawToken("4900000000000000", true)).toBe("4.9E-3");
    const max = (2n ** 256n - 1n).toString();
    expect(formatRawToken(max)).toBe(
      "115,792,089,237,316,195,423,570,985,008,687,907,853,269,984,665,640,564,039,457.584007913129639935",
    );
    expect(formatRawToken(max, true)).toBe("1.16E59");
  });

  it("shows zero without inventing missing or malformed holdings", () => {
    expect(formatRawToken("0")).toBe("0");
    expect(formatRawToken("0", true)).toBe("0");
    for (const raw of [undefined, null, "", "-1", "1.5", "Infinity", "1e18"]) {
      expect(formatRawToken(raw)).toBe("—");
      expect(formatRawToken(raw, true)).toBe("—");
    }
  });
});
