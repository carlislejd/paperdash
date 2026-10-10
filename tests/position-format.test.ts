import { describe, expect, it } from "vitest";
import {
  closedHoldingTimeMs,
  formatHoldingTime,
  formatLeverage,
  holdingTimeMs,
  openPositionRows,
} from "../apps/web/src/lib/position-format";

describe("position display values", () => {
  it("distinguishes an empty cohort from valid zero-length holds", () => {
    expect(formatHoldingTime(null)).toBe("—");
    expect(formatHoldingTime(0)).toBe("0s");
    expect(formatHoldingTime(400)).toBe("<1s");
    expect(formatLeverage(null)).toBe("—");
    expect(formatLeverage(0)).toBe("—");
  });
  it("formats elapsed time across minute, hour and day boundaries", () => {
    expect(formatHoldingTime(59_000)).toBe("59s");
    expect(formatHoldingTime(60_000)).toBe("1m");
    expect(formatHoldingTime(3_661_000)).toBe("1h 1m");
    expect(formatHoldingTime(90_000_000)).toBe("1d 1h");
  });
  it("rejects malformed or reversed timestamps rather than inventing a hold", () => {
    expect(holdingTimeMs(0, 0)).toBe(0);
    expect(holdingTimeMs(5, 4)).toBeNull();
    expect(holdingTimeMs("1000", 2000)).toBeNull();
    expect(holdingTimeMs(-1, 2000)).toBeNull();
    expect(holdingTimeMs(1, Infinity)).toBeNull();
    expect(holdingTimeMs(0, Number.MAX_SAFE_INTEGER + 1)).toBeNull();
  });
  it("formats fractional cohort means while keeping invalid leverage unknown", () => {
    expect(formatLeverage(6.25)).toBe("6.25×");
    expect(formatLeverage(20)).toBe("20×");
    expect(formatLeverage(-1)).toBe("—");
    expect(formatLeverage(Infinity)).toBe("—");
  });
  it("does not display future closes or nonterminal activity as closed holding time", () => {
    const receivedAt = Date.now() - 60_000;
    expect(
      closedHoldingTimeMs(
        {
          kind: "PositionClosed",
          openedAtMs: receivedAt - 1000,
          timestampMs: receivedAt,
        },
        receivedAt,
      ),
    ).toBe(1000);
    expect(
      closedHoldingTimeMs(
        {
          kind: "Liquidated",
          openedAtMs: receivedAt - 1000,
          timestampMs: receivedAt + 30_001,
        },
        receivedAt,
      ),
    ).toBeNull();
    expect(
      closedHoldingTimeMs(
        {
          kind: "PositionOpened",
          openedAtMs: receivedAt - 1000,
          timestampMs: receivedAt,
        },
        receivedAt,
      ),
    ).toBeNull();
  });
  it("uses the supplied snapshot time for open ages and keeps invalid rows visible", () => {
    const positions = openPositionRows(
      [
        ["one", 0, true, false, "1", "1", 10, "1", 1000, null],
        ["two", 1, false, false, "1", "1", 20, "1", 5000, null],
        { bad: "tuple" },
      ],
      3000,
    );
    expect(positions).toHaveLength(3);
    expect(positions[0]).toMatchObject({
      symbol: "BTC",
      side: "Long",
      leverage: 10,
      heldMs: 2000,
    });
    expect(positions[1]).toMatchObject({
      symbol: "ETH",
      side: "Short",
      leverage: 20,
      heldMs: null,
    });
    expect(positions[2]).toMatchObject({
      symbol: "Market",
      side: "—",
      leverage: null,
      heldMs: null,
    });
  });
});
