import { describe, expect, it } from "vitest";
import type { TradeEvent } from "../packages/shared/src/types";
import {
  mergeMarketPoints,
  mergeMarketTrades,
} from "../apps/web/src/lib/market-data";

const now = 10_000_000;
const trade = (
  id: string,
  overrides: Partial<TradeEvent> = {},
): TradeEvent => ({
  id,
  ts: now - 1_000,
  wallet: `0x${"1".repeat(40)}`,
  instrument: 0,
  side: "long",
  leverage: 10,
  notionalUsd: 50_000,
  kind: "open",
  pnlUsd: null,
  provenance: "public-stream",
  ...overrides,
});

describe("market snapshot and live reconciliation", () => {
  it("preserves newer quotes in each bucket when a delayed snapshot arrives", () => {
    expect(
      mergeMarketPoints(
        [
          { time: now - 4_000, priceUsd: 100 },
          { time: now - 10_000, priceUsd: 90 },
        ],
        [
          { time: now - 2_000, priceUsd: 110 },
          { time: now - 6_000, priceUsd: 95 },
        ],
        now,
      ),
    ).toEqual([
      { time: now - 6_000, priceUsd: 95 },
      { time: now - 2_000, priceUsd: 110 },
    ]);
  });

  it("keeps source gaps and rejects invalid, expired, and future points", () => {
    const points = [
      { time: now - 60_000, priceUsd: 100 },
      { time: now, priceUsd: 110 },
      { time: now - 3_600_001, priceUsd: 10 },
      { time: now + 30_001, priceUsd: 20 },
      { time: now - 5_000, priceUsd: NaN },
      { time: now - 15_000, priceUsd: -1 },
    ];
    expect(mergeMarketPoints(points, [], now)).toEqual([points[0], points[1]]);
  });

  it("preserves a known reconnect gap through same-bucket quote replacements", () => {
    expect(
      mergeMarketPoints(
        [{ time: now - 3_000, priceUsd: 100, gapBefore: true }],
        [{ time: now - 1_000, priceUsd: 101 }],
        now,
      ),
    ).toEqual([{ time: now - 1_000, priceUsd: 101, gapBefore: true }]);
    expect(
      mergeMarketPoints(
        [{ time: now - 1_000, priceUsd: 101 }],
        [{ time: now - 3_000, priceUsd: 100, gapBefore: true }],
        now,
      ),
    ).toEqual([{ time: now - 1_000, priceUsd: 101, gapBefore: true }]);
  });

  it("bounds retained client data without mixing assets or duplicating replayed trades", () => {
    const points = Array.from({ length: 721 }, (_, i) => ({
      time: now - i * 5_000,
      priceUsd: 100,
    }));
    expect(mergeMarketPoints(points, [], now)).toHaveLength(720);
    const trades = Array.from({ length: 210 }, (_, i) =>
      trade(`event-${i}`, { ts: now - i }),
    );
    const merged = mergeMarketTrades(
      trades,
      [trades[0], trade("other", { instrument: 1 })],
      0,
      now,
    );
    expect(merged).toHaveLength(200);
    expect(merged.filter((t) => t.id === trades[0].id)).toHaveLength(1);
    expect(merged.every((t) => t.instrument === 0)).toBe(true);
  });

  it("keeps unpriced trades in the feed without inventing a quote price", () => {
    const [unpriced] = mergeMarketTrades([trade("missing")], [], 0, now);
    expect(unpriced.priceUsd).toBeNull();
    const [priced] = mergeMarketTrades(
      [trade("same", { priceUsd: 100 })],
      [trade("same")],
      0,
      now,
    );
    expect(priced.priceUsd).toBe(100);
    expect(
      mergeMarketTrades(
        [
          trade("future", { ts: now + 30_001 }),
          trade("expired", { ts: now - 3_600_001 }),
        ],
        [],
        0,
        now,
      ),
    ).toEqual([]);
  });
});
