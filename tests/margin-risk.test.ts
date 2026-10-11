import { describe, expect, it } from "vitest";
import {
  buildWalletMarginRisk,
  referencePriceRaw,
  type MarginRiskContext,
  type RiskReference,
} from "../packages/shared/src/margin-risk.js";
import type { WalletSnapshot } from "../packages/shared/src/types.js";

const at = 1791700000000;
const wallet = `0x${"a".repeat(40)}`;
const unit = 10n ** 18n;
const reference = (instrumentId = 0, priceUsd = 100): RiskReference => ({
  instrumentId,
  symbol: instrumentId === 0 ? "BTC" : "ETH",
  priceUsd,
  priceRaw: referencePriceRaw(priceUsd)!,
  sourceAt: at,
  receivedAt: at,
  stale: false,
  source: "hyperliquid-bbo-mid",
});
const context = (references = [reference()]): MarginRiskContext => ({
  address: wallet,
  asOf: at,
  snapshotReceivedAt: at,
  snapshotStale: false,
  references,
});
const row = (
  id = "1",
  bust = "999",
  long = true,
  debt = false,
  instrument = 0,
  margin = unit.toString(),
): unknown[] => [
  id,
  instrument,
  long,
  debt,
  instrument === 0 ? "1000" : "10000",
  margin,
  10,
  bust,
  at - 60000,
  null,
];
const snapshot = (openPositions: unknown[]): WalletSnapshot => ({
  address: wallet,
  indexedThroughBlock: 123,
  indexedThroughTimestamp: at / 1000,
  accountRevision: 5,
  openPositions,
  balance: "0",
  queued: "0",
  locked: "0",
  lifetime: {
    depositedRaw: "0",
    withdrawnRaw: "0",
    realizedPnlRaw: "0",
    feesPaidRaw: "0",
    tradedNotionalRaw: "0",
    paperRewardsClaimedRaw: "0",
  },
  paper: { balance: "0", staked: "0" },
});

describe("wallet recorded-threshold margin scenarios", () => {
  it("uses inclusive upper boundaries, and exact equality belongs to at-or-beyond for both sides", () => {
    // ETH scale100 at $100 makes one raw tick exactly one basis point.
    const distances = [-1, 0, 1, 10, 11, 25, 26, 50, 51, 100, 101, 500, 501];
    const positions = distances.flatMap((bps, index) => [
      row(`${2 * index}`, `${10000 - bps}`, true, false, 1),
      row(`${2 * index + 1}`, `${10000 + bps}`, false, true, 1),
    ]);
    const result = buildWalletMarginRisk(
      snapshot(positions),
      context([reference(1)]),
    );
    const asset = result.assets[0];
    expect(result.stale).toBe(false);
    expect(
      asset.bands!.map((band) => [
        band.key,
        band.long.positionCount,
        band.short.positionCount,
      ]),
    ).toEqual([
      ["at-or-beyond", 2, 2],
      ["0-10", 2, 2],
      ["10-25", 2, 2],
      ["25-50", 2, 2],
      ["50-100", 2, 2],
      ["100-500", 2, 2],
      ["over-500", 1, 1],
    ]);
    expect(asset.totals).toEqual({
      positionCount: 26,
      initialMarginRaw: `${26n * unit}`,
      cashMarginRaw: `${13n * unit}`,
      queuedMarginRaw: `${13n * unit}`,
    });
    expect(
      asset.bands!.reduce(
        (sum, band) =>
          sum +
          BigInt(band.long.initialMarginRaw) +
          BigInt(band.short.initialMarginRaw),
        0n,
      ),
    ).toBe(26n * unit);
    expect(asset.nearest.map((p) => p.positionId)).toEqual([
      "2",
      "3",
      "0",
      "1",
      "4",
    ]);
    expect(asset.nearest.map((p) => p.atOrBeyond)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it("does not round a half protocol tick or a just-over band boundary into the previous band", () => {
    const quote = reference(0, 100.00000000000001);
    const result = buildWalletMarginRisk(snapshot([row()]), context([quote]));
    expect(
      result.assets[0].bands!.find((b) => b.key === "0-10")!.long.positionCount,
    ).toBe(0);
    expect(
      result.assets[0].bands!.find((b) => b.key === "10-25")!.long
        .positionCount,
    ).toBe(1);
    // Existing feed midpoint can have half a tick; it is an external scenario,
    // not the floored integer mark used in the official frontend.
    const half = buildWalletMarginRisk(
      snapshot([row("2", "1000")]),
      context([reference(0, 100.05)]),
    );
    expect(half.assets[0].nearest[0].atOrBeyond).toBe(false);
    expect(half.assets[0].nearest[0].distanceBps).toBeCloseTo(4.9975);
  });

  it("sums huge and sub-Number raw margins exactly, without multiplying by leverage", () => {
    const huge = (1n << 255n) - 1n;
    const largeUsd = 10_000_000_000n * unit + 1n;
    const result = buildWalletMarginRisk(
      snapshot([
        row("1", "999", true, false, 0, `${huge}`),
        row("2", "999", true, true, 0, `${largeUsd}`),
        row("3", "998", true, true, 0, "1"),
      ]),
      context(),
    );
    expect(result.assets[0].totals).toEqual({
      positionCount: 3,
      initialMarginRaw: `${huge + largeUsd + 1n}`,
      cashMarginRaw: `${huge}`,
      queuedMarginRaw: `${largeUsd + 1n}`,
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("keeps maximum uint256 bust distances finite and zero bust source rows representable", () => {
    const max = (1n << 256n) - 1n;
    const result = buildWalletMarginRisk(
      snapshot([
        row("1", `${max}`, true),
        row("2", `${max}`, false),
        row("3", "0", false),
      ]),
      context([reference(0, 1e-18)]),
    );
    expect(result.coverage.excludedCount).toBe(0);
    expect(
      result.assets[0].nearest.every((p) => Number.isFinite(p.distanceBps)),
    ).toBe(true);
    expect(result.assets[0].bands![0].long.positionCount).toBe(1);
    expect(result.assets[0].bands![0].short.positionCount).toBe(1);
    expect(result.assets[0].bands!.at(-1)!.short.positionCount).toBe(1);
  });

  it("excludes every repeated wallet ID and malformed or unknown rows, preserving valid neighbors", () => {
    const badFunding = row("4");
    badFunding[3] = "cash";
    const badTime = row("5");
    badTime[8] = at + 1;
    const badMargin = row("6");
    badMargin[5] = `${1n << 256n}`;
    const negativeBust = row("7");
    negativeBust[7] = "-1";
    const missingBust = row("8");
    missingBust[7] = null;
    const badLeverage = row("9");
    badLeverage[6] = Number.MAX_SAFE_INTEGER + 1;
    const oldSourceFutureOpen = row("10");
    oldSourceFutureOpen[8] = at - 1;
    const result = buildWalletMarginRisk(
      snapshot([
        row("1"),
        row("1", "10001", false, true, 1),
        row("2", "999", true, false, 42),
        badFunding,
        badTime,
        badMargin,
        negativeBust,
        missingBust,
        badLeverage,
        row("11"),
        null,
      ]),
      context(),
    );
    expect(result.coverage).toMatchObject({
      snapshotPositionCount: 11,
      includedCount: 1,
      excludedCount: 10,
      duplicateCount: 2,
    });
    expect(result.assets[0].totals.positionCount).toBe(1);
    expect(result.assets[0].nearest[0].positionId).toBe("11");
    const old = snapshot([oldSourceFutureOpen]);
    old.indexedThroughTimestamp -= 60;
    expect(buildWalletMarginRisk(old, context()).coverage.excludedCount).toBe(
      1,
    );
  });

  it("keeps valid zero bust and zero margin; empty and absent snapshots are distinct", () => {
    const long = row("1", "0", true, false, 0, "0");
    long[6] = 1;
    const result = buildWalletMarginRisk(snapshot([long]), context());
    expect(result.assets[0].totals.initialMarginRaw).toBe("0");
    expect(result.assets[0].bands!.at(-1)!.long.positionCount).toBe(1);
    expect(result.assets[0].nearest[0].distanceBps).toBe(10000);
    expect(buildWalletMarginRisk(snapshot([]), context())).toMatchObject({
      assets: [],
      stale: false,
      coverage: {
        snapshotPositionCount: 0,
        includedCount: 0,
        excludedCount: 0,
      },
    });
    expect(buildWalletMarginRisk(null, context())).toMatchObject({
      snapshot: null,
      assets: [],
      stale: true,
      coverage: { snapshotPositionCount: null },
    });
  });

  it("retains totals without usable reference and rejects incoherent or future references", () => {
    const invalid = [
      { ...reference(), priceUsd: 0 },
      { ...reference(), priceRaw: "1" },
      { ...reference(), sourceAt: at + 30001 },
      { ...reference(), receivedAt: at + 30001 },
      { ...reference(), symbol: "ETH" },
      { ...reference(), priceUsd: NaN },
      { ...reference(), priceUsd: 1e-30, priceRaw: null },
    ];
    for (const refs of [[], ...invalid.map((r) => [r as RiskReference])]) {
      const result = buildWalletMarginRisk(snapshot([row()]), context(refs));
      expect(result).toMatchObject({
        stale: true,
        references: [],
        assets: [
          {
            reference: null,
            bands: null,
            nearest: [],
            totals: { initialMarginRaw: unit.toString() },
          },
        ],
      });
    }
  });

  it("retains stale scenarios with separate snapshot/reference clocks and deterministic newest reference", () => {
    const old = {
      ...reference(),
      sourceAt: at - 31000,
      receivedAt: at - 31000,
    };
    const result = buildWalletMarginRisk(snapshot([row()]), {
      ...context([old]),
      snapshotStale: true,
    });
    expect(result.stale).toBe(true);
    expect(result.snapshot).toMatchObject({
      stale: true,
      sourceAt: at,
      receivedAt: at,
    });
    expect(result.assets[0].reference).toMatchObject({
      stale: true,
      sourceAt: at - 31000,
    });
    expect(result.assets[0].bands).not.toBeNull();
    const fresh = buildWalletMarginRisk(
      snapshot([row()]),
      context([old, reference(), old]),
    );
    expect(fresh.references).toHaveLength(1);
    expect(fresh.stale).toBe(false);
    expect(
      buildWalletMarginRisk(snapshot([row()]), {
        ...context(),
        snapshotReceivedAt: null,
      }).snapshot?.stale,
    ).toBe(true);
  });

  it("processes the complete allowed snapshot and rejects oversized or wrong-wallet input without truncation", () => {
    const rows = Array.from({ length: 10000 }, (_, i) => row(`${i}`));
    const result = buildWalletMarginRisk(snapshot(rows), context());
    expect(result.coverage.includedCount).toBe(10000);
    expect(result.assets[0].totals.initialMarginRaw).toBe(`${10000n * unit}`);
    expect(result.assets[0].nearest).toHaveLength(5);
    expect(
      buildWalletMarginRisk(snapshot([...rows, row("10000")]), context()),
    ).toMatchObject({ snapshot: null, stale: true, assets: [] });
    expect(
      buildWalletMarginRisk(
        { ...snapshot(rows), address: `0x${"b".repeat(40)}` },
        context(),
      ).snapshot,
    ).toBeNull();
  });

  it("represents numeric source quotes without float multiplication and rejects underflow/overflow", () => {
    expect(referencePriceRaw(10000000000.125)).toBe(
      "10000000000125000000000000000",
    );
    expect(referencePriceRaw(1e-18)).toBe("1");
    expect(referencePriceRaw(1e21)).toBe(
      "1000000000000000000000000000000000000000",
    );
    for (const value of [0, -1, NaN, Infinity, 1e-19, 1e100])
      expect(referencePriceRaw(value)).toBeNull();
  });
});
