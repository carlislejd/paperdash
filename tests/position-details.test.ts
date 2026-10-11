import { describe, expect, it } from "vitest";
import {
  normalizeClosedPosition,
  normalizeOpenPosition,
  verifiedPositionInstrument,
  type PositionDetailContext,
} from "../packages/shared/src/position-details.js";

// Bounded public wallet samples captured 2026-10-10. These are outcomes and
// wallet tuples, not inferred pairs from the sampled public ticker.
const context: PositionDetailContext = {
  walletAddress: "0xb978d0714fbdfa8a4a3f6ca4a5f1403772aaa2c0",
  receivedAt: 1791669727295,
  asOf: 1791669800000,
};
const outcome = {
  kind: "PositionClosed",
  isLong: true,
  symbol: "ETH",
  txHash: "0x49a05c56b56c5edc8b3c45f26814d69d14027f727933c569c7dae676777869d8",
  retired: false,
  terminal: false,
  leverage: 1000,
  marginRaw: "4000000000000000000000",
  assetIndex: 1,
  openedAtMs: 1791640909000,
  positionId: "195",
  timestampMs: 1791640973000,
  exitPriceRaw: "249715",
  instrumentId: 1,
  entryPriceRaw: "249755",
  priceScaleRaw: "100",
  adjustedPnlRaw: "-640627815258953774699",
  paperMintedRaw: "62781525895377469920600",
  userPaidFeeRaw: "0",
  paperMintBasisRaw: "627815258953774699206",
  paperMintBatchTotalRaw: null,
  id: "a81ed8c37b999dcf3da80e7997489cefb8600a3f427e7fb0b943b20e19ba1b79:1",
};
const open = [
  "112178",
  0,
  true,
  false,
  "828175",
  "38660360000000000000000",
  215,
  "824716",
  1791690787000,
  "0xbf1c307ad5d9a52e5a6d8034b02f111d6e28491810e803204bd1246c36918996",
];
const openContext: PositionDetailContext = {
  walletAddress: "0x01cfb8e2d53cc3ce45486fe9d4face5dc454b4b7",
  receivedAt: 1791693968000,
  asOf: 1791693968000,
};

describe("shared retained position details", () => {
  it("preserves the real 64-second ETH loss and exact distinct PAPER issuance basis", () => {
    const d = normalizeClosedPosition(Object.freeze(outcome), context)!;
    expect(d).toMatchObject({
      positionId: "195",
      status: "closed",
      symbol: "ETH",
      side: "long",
      initialMarginRaw: "4000000000000000000000",
      entryNotionalRaw: "4000000000000000000000000",
      priceScaleRaw: "100",
      heldMs: 64000,
      ageMs: null,
      adjustedPnlRaw: "-640627815258953774699",
      userPaidFeeRaw: "0",
      paperMintedRaw: "62781525895377469920600",
      paperMintBasisRaw: "627815258953774699206",
      paperMintBatchTotalRaw: null,
      funding: "unknown",
      bustPriceRaw: null,
      intentId: null,
      provenance: {
        source: "wallet-trade-outcome",
        retainedId: outcome.id,
        receivedAt: context.receivedAt,
        priceScaleSource: "outcome",
        partial: true,
      },
      warnings: [],
    });
    expect(d.paperMintBasisRaw).not.toBe(d.adjustedPnlRaw!.slice(1));
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });

  it("keeps a winning source P&L separate from its reported user fee", () => {
    const d = normalizeClosedPosition(
      {
        ...outcome,
        symbol: "BTC",
        instrumentId: 0,
        positionId: "15593",
        marginRaw: "9000000000000000000000",
        leverage: 100,
        openedAtMs: 1791648472000,
        timestampMs: 1791653679000,
        entryPriceRaw: "829655",
        exitPriceRaw: "830255",
        priceScaleRaw: "10",
        adjustedPnlRaw: "449264341827924961576",
        userPaidFeeRaw: "8985286836558499231",
        paperMintedRaw: "0",
        paperMintBasisRaw: "0",
      },
      context,
    )!;
    expect(d.adjustedPnlRaw).toBe("449264341827924961576");
    expect(d.userPaidFeeRaw).toBe("8985286836558499231");
    expect(d.paperMintedRaw).toBe("0");
    expect(d.heldMs).toBe(5_207_000);
    expect(d.entryNotionalRaw).toBe("900000000000000000000000");
  });

  it("preserves a real open tuple, supplied bust price and intent without inventing a close", () => {
    const d = normalizeOpenPosition(Object.freeze(open), openContext)!;
    expect(d).toMatchObject({
      status: "open",
      positionId: "112178",
      symbol: "BTC",
      side: "long",
      funding: "cash",
      leverage: 215,
      entryPriceRaw: "828175",
      bustPriceRaw: "824716",
      priceScaleRaw: "10",
      entryNotionalRaw: "8311977400000000000000000",
      ageMs: 3_181_000,
      heldMs: null,
      exitPriceRaw: null,
      closedAt: null,
      adjustedPnlRaw: null,
      userPaidFeeRaw: null,
      paperMintedRaw: null,
      txHash: null,
      intentId: open[9],
      warnings: [],
    });
    const debt = [...open];
    debt[3] = true;
    expect(normalizeOpenPosition(debt, openContext)?.funding).toBe(
      "queued-balance",
    );
  });

  it("does not infer closed funding/bust from extra fields or instrument lifecycle flags", () => {
    const d = normalizeClosedPosition(
      {
        ...outcome,
        terminal: true,
        retired: true,
        useDebt: true,
        bustPriceRaw: "200000",
        kind: "Liquidated",
      },
      context,
    )!;
    expect(d.status).toBe("liquidated");
    expect(d.funding).toBe("unknown");
    expect(d.bustPriceRaw).toBeNull();
    expect(d.heldMs).toBe(64000);
  });

  it("uses explicit source scales and never guesses an unknown instrument's price", () => {
    expect(verifiedPositionInstrument(1)).toEqual({
      id: 1,
      symbol: "ETH",
      priceScaleRaw: "100",
    });
    expect(verifiedPositionInstrument(2)).toBeUndefined();
    const tuple = [...open];
    tuple[1] = 12;
    const unknown = normalizeOpenPosition(tuple, openContext)!;
    expect(unknown.entryPriceRaw).toBe("828175");
    expect(unknown.priceScaleRaw).toBeNull();
    expect(unknown.symbol).toBeNull();
    const explicit = normalizeOpenPosition(tuple, {
      ...openContext,
      instrument: { id: 12, symbol: "NEW", priceScaleRaw: "1000" },
    })!;
    expect(explicit.priceScaleRaw).toBe("1000");
    expect(explicit.symbol).toBe("NEW");
    expect(
      normalizeClosedPosition({ ...outcome, priceScaleRaw: "0" }, context)
        ?.priceScaleRaw,
    ).toBeNull();
    expect(
      normalizeClosedPosition({ ...outcome, priceScaleRaw: "1000" }, context)
        ?.priceScaleRaw,
    ).toBe("1000");
    expect(
      normalizeOpenPosition(open, {
        ...openContext,
        instrument: { id: 1, symbol: "ETH", priceScaleRaw: "100" },
      })?.priceScaleRaw,
    ).toBeNull();
  });

  it("keeps exact large accounting integers and rejects overflow, unsafe leverage and malformed amounts", () => {
    const large = "10000000000000000000000000001";
    expect(
      normalizeClosedPosition({ ...outcome, marginRaw: large }, context)
        ?.entryNotionalRaw,
    ).toBe("10000000000000000000000000001000");
    const max = ((1n << 256n) - 1n).toString();
    expect(
      normalizeClosedPosition(
        { ...outcome, marginRaw: max, leverage: 1 },
        context,
      )?.initialMarginRaw,
    ).toBe(max);
    for (const marginRaw of [
      (1n << 256n).toString(),
      "9".repeat(10000),
      "1e18",
      "-1",
      "01",
      1,
    ]) {
      const d = normalizeClosedPosition({ ...outcome, marginRaw }, context)!;
      expect(d.initialMarginRaw).toBeNull();
      expect(d.entryNotionalRaw).toBeNull();
      expect(d.paperMintedRaw).toBe(outcome.paperMintedRaw);
    }
    for (const leverage of [
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Infinity,
      "1000",
    ]) {
      expect(
        normalizeClosedPosition({ ...outcome, leverage }, context)
          ?.entryNotionalRaw,
      ).toBeNull();
    }
    expect(
      normalizeClosedPosition(
        { ...outcome, adjustedPnlRaw: (1n << 255n).toString() },
        context,
      )?.adjustedPnlRaw,
    ).toBeNull();
    expect(
      normalizeClosedPosition({ ...outcome, marginRaw: "0" }, context)
        ?.entryNotionalRaw,
    ).toBe("0");
  });

  it("guards execution clocks without using unrelated aggregate wallet age", () => {
    expect(
      normalizeClosedPosition(outcome, {
        ...context,
        receivedAt: outcome.timestampMs,
      })?.heldMs,
    ).toBe(64000);
    expect(
      normalizeClosedPosition(outcome, {
        ...context,
        receivedAt: outcome.timestampMs - 30_000,
      })?.heldMs,
    ).toBe(64000);
    expect(
      normalizeClosedPosition(outcome, {
        ...context,
        receivedAt: outcome.timestampMs - 30_001,
      })?.heldMs,
    ).toBeNull();
    expect(
      normalizeClosedPosition(outcome, { ...context, receivedAt: null })
        ?.heldMs,
    ).toBe(64000);
    for (const timestampMs of [
      -1,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER,
      8_640_000_000_000_001,
    ]) {
      const d = normalizeClosedPosition({ ...outcome, timestampMs }, context)!;
      expect(d.closedAt).toBeNull();
      expect(d.heldMs).toBeNull();
    }
    expect(
      normalizeClosedPosition(
        { ...outcome, openedAtMs: outcome.timestampMs + 1 },
        context,
      )?.heldMs,
    ).toBeNull();
    expect(
      normalizeClosedPosition(
        { ...outcome, timestampMs: context.asOf + 30_001 },
        { ...context, receivedAt: null },
      )?.heldMs,
    ).toBeNull();
    const future = [...open];
    future[8] = openContext.asOf + 1;
    expect(normalizeOpenPosition(future, openContext)?.ageMs).toBeNull();
    expect(
      normalizeOpenPosition(open, {
        ...openContext,
        asOf: Number.MAX_SAFE_INTEGER,
      }),
    ).toBeNull();
  });

  it("carries ambiguity and unavailable fields rather than turning absent data into zero", () => {
    const d = normalizeClosedPosition(
      { ...outcome, adjustedPnlRaw: undefined, paperMintedRaw: null },
      { ...context, identityAmbiguous: true },
    )!;
    expect(d.provenance.identityAmbiguous).toBe(true);
    expect(d.warnings).toContain(
      "Retained history has ambiguous observation identity.",
    );
    expect(d.adjustedPnlRaw).toBeNull();
    expect(d.paperMintedRaw).toBeNull();
    expect(d.paperMintBatchTotalRaw).toBeNull();
    expect(d.heldMs).toBe(64000); // Disclosure, not a claim of canonical completeness.
    expect(
      normalizeClosedPosition({ ...outcome, kind: "open" }, context),
    ).toBeNull();
    expect(
      normalizeClosedPosition({ ...outcome, isLong: "true" }, context),
    ).toBeNull();
    expect(
      normalizeClosedPosition(outcome, { ...context, walletAddress: "bad" }),
    ).toBeNull();
    expect(normalizeOpenPosition([], openContext)).toBeNull();
    expect(normalizeClosedPosition(null, context)).toBeNull();
  });
});
