import { describe, expect, it } from "vitest";
import { acceptsMarketSegment } from "../apps/web/src/lib/market-segment";
import type { AssetMarketResponse } from "../packages/shared/src/types";

const NOW = Date.UTC(2026, 9, 16, 16);
const data = (): AssetMarketResponse => ({
  instrument: 0,
  symbol: "BTC",
  segment: "profitable",
  segmentCoverage: {
    basis: "positive-lifetime-realized-trading-pnl",
    classifiedAt: NOW,
    maxAccountAgeMs: 300_000,
    observedWallets: 3,
    classifiedWallets: 2,
    profitableWallets: 1,
    unknownWallets: 1,
    oldestAccountReceivedAt: NOW - 300_000,
    newestAccountReceivedAt: NOW - 1_000,
  },
  price: null,
  points: [],
  trades: [],
  windowFrom: NOW - 3_600_000,
  windowTo: NOW,
  receivedAt: NOW,
  stale: false,
  coverage: {
    source: "retained-market-observations",
    observedFrom: NOW - 3_600_000,
    partial: true,
    tradesCapped: false,
  },
});

describe("profitable market cohort acceptance", () => {
  it("accepts a recent classified cohort, including valid empty or partial coverage", () => {
    expect(acceptsMarketSegment(data(), 0, "profitable", NOW)).toBe(true);
    const empty = data();
    Object.assign(empty.segmentCoverage!, {
      classifiedWallets: 0,
      profitableWallets: 0,
      unknownWallets: 3,
      oldestAccountReceivedAt: null,
      newestAccountReceivedAt: null,
    });
    expect(acceptsMarketSegment(empty, 0, "profitable", NOW)).toBe(true);
  });

  it("keeps legacy all-trader data usable without relabeling it as profitable", () => {
    const legacy = data();
    delete legacy.segment;
    delete legacy.segmentCoverage;
    expect(acceptsMarketSegment(legacy, 0, "all", NOW)).toBe(true);
    expect(acceptsMarketSegment(legacy, 0, "profitable", NOW)).toBe(false);
    expect(acceptsMarketSegment(data(), 0, "all", NOW)).toBe(false);
    expect(acceptsMarketSegment(data(), 1, "profitable", NOW)).toBe(false);
    expect(acceptsMarketSegment(null, 0, "profitable", NOW)).toBe(false);
  });

  it("hides a failed or expired classification even while price updates remain fresh", () => {
    expect(acceptsMarketSegment(data(), 0, "profitable", NOW, true)).toBe(false);
    expect(acceptsMarketSegment(data(), 0, "profitable", NOW + 60_000)).toBe(true);
    expect(acceptsMarketSegment(data(), 0, "profitable", NOW + 60_001)).toBe(false);
    expect(acceptsMarketSegment(data(), 0, "profitable", NOW - 30_001)).toBe(false);
  });

  it.each([
    { observedWallets: 2 },
    { classifiedWallets: -1 },
    { profitableWallets: 3 },
    { unknownWallets: Number.NaN },
    { basis: "trading-plus-rewards" },
    { maxAccountAgeMs: 600_000 },
    { classifiedAt: Infinity },
    { oldestAccountReceivedAt: NOW - 300_001 },
    { newestAccountReceivedAt: NOW + 1 },
    { newestAccountReceivedAt: null },
  ])("rejects malformed classification metadata: %o", (patch) => {
    const invalid = data();
    Object.assign(invalid.segmentCoverage!, patch);
    expect(acceptsMarketSegment(invalid, 0, "profitable", NOW)).toBe(false);
  });
});
