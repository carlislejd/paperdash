import { describe, expect, it } from "vitest";
import type {
  MarketTradeSample,
  TradeEvent,
} from "../packages/shared/src/types";
import {
  MARKET_WINDOWS,
  selectMarketSample,
  validMarketSample,
} from "../apps/web/src/lib/market-sample";

const now = 10_815_000;
const trade = (
  id: string,
  ts: number,
  notionalUsd = 100_000,
  extra: Partial<TradeEvent> = {},
): TradeEvent => ({
  id,
  ts,
  notionalUsd,
  wallet: `0x${"a".repeat(40)}`,
  instrument: 0,
  side: "long",
  kind: "open",
  leverage: 1000,
  pnlUsd: null,
  provenance: "public-stream",
  priceUsd: 82_000,
  ...extra,
});

describe("windowed chart sample reconciliation", () => {
  it("selects exits before applying caps and includes liquidations without mixing entries", () => {
    const rows = [
      trade("entry-one", now - 1000, 10_000_000),
      trade("entry-two", now - 1000, 9_000_000),
      trade("exit", now - 1000, 200, { kind: "close" }),
      trade("liquidation", now - 1000, 100, { kind: "liq" }),
    ];
    expect(selectMarketSample(rows, [], 0, "15m", now, "exits").map((t) => t.id))
      .toEqual(["liquidation", "exit"]);
    expect(selectMarketSample(rows, [], 0, "15m", now, "entries").map((t) => t.id))
      .toEqual(["entry-two", "entry-one"]);
    expect(selectMarketSample(rows, [], 0, "15m", now).map((t) => t.id))
      .toEqual(["entry-two", "entry-one"]);
  });
  it("retains older buckets and the largest live arrivals through a busy latest bucket", () => {
    const old = trade("old-large", now - 850_000, 10_000_000);
    let selected = [old];
    for (let i = 0; i < 500; i++) {
      selected = selectMarketSample(
        selected,
        [trade(`burst-${i}`, now - 5_000 + i, i === 0 ? 5_000_000 : 1000 + i)],
        0,
        "15m",
        now,
      );
    }
    expect(selected.map((t) => t.id)).toContain("old-large");
    expect(selected.map((t) => t.id)).toContain("burst-0");
    expect(selected.map((t) => t.id)).toContain("burst-499");
    expect(selected).toHaveLength(3);
  });

  it("spreads up to two trades across every inclusive epoch bucket and preserves actual coordinates", () => {
    const from = now - MARKET_WINDOWS["15m"];
    const rows = [trade("first-edge", from), trade("last-edge", now)];
    for (let at = Math.ceil(from / 30_000) * 30_000; at < now; at += 30_000) {
      rows.push(
        trade(`small-${at}`, at, 1),
        trade(`big-${at}`, at + 1, 10_000_000_000),
        trade(`middle-${at}`, at + 2, 1_000_000),
      );
    }
    const selected = selectMarketSample(rows, [], 0, "15m", now);
    expect(selected.length).toBeLessThanOrEqual(62);
    expect(selected.at(-1)?.id).toBe("first-edge");
    expect(selected.every((t) => rows.includes(t))).toBe(true);
    expect(selected.some((t) => t.id.startsWith("small-"))).toBe(false);
    expect(new Set(selected.map((t) => Math.floor(t.ts / 30_000))).size).toBe(
      31,
    );
  });

  it("matches source multiplicity without unpriced rows suppressing real executions", () => {
    const base = trade("stream-1", now - 1000);
    const values = [
      base,
      { ...base, id: "stream-2" },
      { ...base, id: "recent-1", provenance: "recent-api" as const },
      {
        ...base,
        id: "recent-unpriced",
        provenance: "recent-api" as const,
        priceUsd: null,
      },
    ];
    expect(
      selectMarketSample(values, [base], 0, "15m", now)
        .map((t) => t.id)
        .sort(),
    ).toEqual(["stream-1", "stream-2"]);
    values.push({ ...base, id: "recent-2", provenance: "recent-api" });
    expect(
      selectMarketSample(values, [], 0, "15m", now)
        .map((t) => t.id)
        .sort(),
    ).toEqual(["recent-1", "recent-2"]);
    expect(
      selectMarketSample(
        [base],
        [{ ...base, priceUsd: null }],
        0,
        "15m",
        now,
      )[0].priceUsd,
    ).toBe(82_000);
  });

  it("uses deterministic notional, time and id ties and rejects wrong asset, unpriced and out-of-window rows", () => {
    const rows = [
      trade("a", now - 1000),
      trade("b", now - 1000),
      trade("c", now - 1000),
      trade("bad-price", now, 1e10, { priceUsd: NaN }),
      trade("old", now - 900_001, 1e10),
      trade("future", now + 1, 1e10),
      trade("eth", now, 1e10, { instrument: 1 }),
      trade("bad-notional", now, Infinity),
    ];
    expect(
      selectMarketSample(rows, [], 0, "15m", now).map((t) => t.id),
    ).toEqual(["c", "b"]);
    expect(
      selectMarketSample(
        [
          trade("large", now - 500, 200_000),
          trade("new", now - 100, 100_000),
          trade("old", now - 1000, 100_000),
        ],
        [],
        0,
        "15m",
        now,
      ).map((t) => t.id),
    ).toEqual(["new", "large"]);
  });

  it("requires the requested cohort metadata and preserves legacy absence", () => {
    const sample: MarketTradeSample = {
      windowFrom: now - 900_000,
      windowTo: now,
      bucketMs: 30_000,
      perBucket: 2,
      trades: [],
      selection: "largest-notional-per-time-bucket",
      partial: true,
    };
    expect(validMarketSample(sample, "15m", now)).toBe(true);
    expect(validMarketSample(sample, "5m", now)).toBe(false);
    expect(validMarketSample(undefined, "15m", now)).toBe(false);
    expect(validMarketSample({ ...sample, bucketMs: 10_000 }, "15m", now)).toBe(
      false,
    );
    expect(
      validMarketSample(
        {
          ...sample,
          trades: Array.from({ length: 63 }, (_, i) => trade(String(i), now)),
        },
        "15m",
        now,
      ),
    ).toBe(false);
  });
});
