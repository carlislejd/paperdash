import { describe, expect, it } from "vitest";
import type { PaperPriceQuote } from "../packages/shared/src/types";
import { addPaperValueRaw, formatParagonValue, paperValueRaw } from "../apps/web/src/lib/paragon-valuation";

const scale = 10n ** 18n;
const quote: PaperPriceQuote = {
  source: "hyperliquid", market: "para:PAPER", basis: "perp-mid",
  priceUsdRaw: "24700000000000000", bidUsdRaw: "24600000000000000", askUsdRaw: "24800000000000000",
  sourceAt: 1792386000000, receivedAt: 1792386000000,
};

describe("optional Paragon reference valuations", () => {
  it("values fractional and large PAPER holdings with exact integer arithmetic", () => {
    expect(paperValueRaw((1000n * scale).toString(), quote)).toBe("24700000000000000000");
    expect(paperValueRaw("1500000000000000000", quote)).toBe("37050000000000000");
    const large = 9007199254740993n * scale + 123456789n;
    expect(paperValueRaw(large.toString(), quote)).toBe((large * 247n / 10000n).toString());
    expect(paperValueRaw("1", quote)).toBe("0");
  });

  it("keeps unknown or invalid balances and prices distinct from known zero", () => {
    expect(paperValueRaw("0", quote)).toBe("0");
    for (const value of [null, undefined, "", "-1", "1e18", "1.5", "1".repeat(79)])
      expect(paperValueRaw(value, quote)).toBeNull();
    expect(paperValueRaw("0", null)).toBeNull();
    expect(paperValueRaw("1", { ...quote, priceUsdRaw: "1" })).toBeNull();
    expect(paperValueRaw("1", { ...quote, market: "other:PAPER" } as unknown as PaperPriceQuote)).toBeNull();
  });

  it("adds token value to signed lifetime P&L without substituting zero for missing inputs", () => {
    expect(addPaperValueRaw((-100n * scale).toString(), (1000n * scale).toString(), quote)).toBe((-753n * scale / 10n).toString());
    expect(addPaperValueRaw((100n * scale).toString(), (1000n * scale).toString(), quote)).toBe((1247n * scale / 10n).toString());
    expect(addPaperValueRaw("0", "0", quote)).toBe("0");
    expect(addPaperValueRaw(null, "0", quote)).toBeNull();
    expect(addPaperValueRaw("0", null, quote)).toBeNull();
    expect(addPaperValueRaw("0", "0", null)).toBeNull();
  });

  it("formats exact amounts without hiding small nonzero estimates", () => {
    expect(formatParagonValue("24700000000000000000")).toBe("$24.70");
    expect(formatParagonValue("0")).toBe("$0.00");
    expect(formatParagonValue("1")).toBe("<$0.01");
    expect(formatParagonValue("-1")).toBe(">−$0.01");
    expect(formatParagonValue("5000000000000000")).toBe("$0.01");
    expect(formatParagonValue((9007199254740993n * scale + 12n * 10n ** 16n).toString())).toBe("$9,007,199,254,740,993.12");
    expect(formatParagonValue(null)).toBe("Unavailable");
    expect(formatParagonValue("NaN")).toBe("Unavailable");
  });
});
