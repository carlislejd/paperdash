import { describe, expect, it } from "vitest";
import {
  annualizedStakerYield,
  VERIFIED_PROTOCOL_GENESIS,
  type StakingYieldObservation,
} from "../packages/shared/src/staking-yield.js";

const HOUR = 3_600_000;
const start = VERIFIED_PROTOCOL_GENESIS + 37 * HOUR + 123_456;
const initialAccumulator = 98_765_432_109_876_543_210_987_654n;
const observation = (
  at: number,
  accumulator = initialAccumulator,
): StakingYieldObservation => ({
  at,
  genesis: VERIFIED_PROTOCOL_GENESIS,
  accumulatorRaw: accumulator.toString(),
});

describe("annualized per-PAPER staking yield", () => {
  it("annualizes a measured 90-minute reward delta without using bucket boundaries or genesis as zero", () => {
    // $0.003 per PAPER in 1.5 hours is $17.52 per PAPER over 8,760 hours.
    const finish = start + 1.5 * HOUR;
    const result = annualizedStakerYield(
      observation(start),
      observation(finish, initialAccumulator + 3n * 10n ** 24n),
      finish,
    );
    expect(result).toMatchObject({
      earnedUsdPerPaperRaw: "3000000000000000",
      usdPerPaperPerYearRaw: "17520000000000000000",
      fromMs: start,
      toMs: finish,
      elapsedMs: 5_400_000,
    });
  });

  it("keeps sub-wei accumulator precision until after annualization", () => {
    const hugeBaseline = 10n ** 70n;
    const result = annualizedStakerYield(
      observation(start, hugeBaseline),
      observation(start + HOUR, hugeBaseline + 999_999_999n),
      start + HOUR,
    );
    expect(result.earnedUsdPerPaperRaw).toBe("0");
    // Less than one raw USDC unit per hour still annualizes to 8,759 units.
    expect(result.usdPerPaperPerYearRaw).toBe("8759");
  });

  it("uses the source interval even when the result is read much later", () => {
    const from = observation(start);
    const to = observation(start + HOUR, initialAccumulator + 10n ** 24n);
    const atSourceTime = annualizedStakerYield(from, to, to.at);
    const readAfterOutage = annualizedStakerYield(from, to, to.at + 4 * HOUR);
    expect(readAfterOutage.usdPerPaperPerYearRaw).toBe("8760000000000000000");
    expect(readAfterOutage).toEqual(atSourceTime);
  });

  it("includes zero-reward time in the denominator and distinguishes zero from unavailable", () => {
    const zero = annualizedStakerYield(
      observation(start),
      observation(start + 2.25 * HOUR),
      start + 2.25 * HOUR,
    );
    expect(zero.usdPerPaperPerYearRaw).toBe("0");
    expect(zero.earnedUsdPerPaperRaw).toBe("0");
    expect(zero.elapsedMs).toBe(8_100_000);
    expect(annualizedStakerYield(null, null, start).usdPerPaperPerYearRaw).toBeNull();
  });

  it("waits for one complete hour of elapsed observations, then includes later partial hours", () => {
    const from = observation(start);
    const beforeHour = observation(start + HOUR - 1, initialAccumulator + 10n ** 24n);
    expect(annualizedStakerYield(from, beforeHour, beforeHour.at)).toMatchObject({
      earnedUsdPerPaperRaw: "1000000000000000",
      usdPerPaperPerYearRaw: null,
      elapsedMs: HOUR - 1,
    });
    const exactHour = observation(start + HOUR, initialAccumulator + 10n ** 24n);
    expect(annualizedStakerYield(from, exactHour, exactHour.at).usdPerPaperPerYearRaw)
      .toBe("8760000000000000000");
  });

  it.each([
    ["different deployment", { genesis: VERIFIED_PROTOCOL_GENESIS + 1 }],
    ["before deployment", { at: VERIFIED_PROTOCOL_GENESIS - 1 }],
    ["fractional timestamp", { at: start + 0.5 }],
    ["future timestamp", { at: start + HOUR + 30_001 }],
    ["unsafe timestamp", { at: Number.MAX_SAFE_INTEGER + 1 }],
    ["negative accumulator", { accumulatorRaw: "-1" }],
    ["leading-zero accumulator", { accumulatorRaw: "01" }],
    ["fractional accumulator", { accumulatorRaw: "1.5" }],
    ["scientific accumulator", { accumulatorRaw: "1e27" }],
    ["oversized accumulator", { accumulatorRaw: "9".repeat(79) }],
  ])("rejects %s observations", (_name, invalid) => {
    const from = observation(start);
    const to = { ...observation(start + HOUR), ...invalid };
    expect(annualizedStakerYield(from, to, start + HOUR).usdPerPaperPerYearRaw)
      .toBeNull();
    expect(annualizedStakerYield(to, from, start + HOUR).usdPerPaperPerYearRaw)
      .toBeNull();
  });

  it.each([NaN, Infinity, -1, start + 0.5])("rejects invalid reference clock %s", (now) => {
    expect(annualizedStakerYield(
      observation(start), observation(start + HOUR), now,
    ).usdPerPaperPerYearRaw).toBeNull();
  });

  it("does not turn a reversed clock or reward counter into a yield", () => {
    expect(annualizedStakerYield(
      observation(start + HOUR), observation(start), start + HOUR,
    ).usdPerPaperPerYearRaw).toBeNull();
    expect(annualizedStakerYield(
      observation(start), observation(start + HOUR, initialAccumulator - 1n), start + HOUR,
    ).usdPerPaperPerYearRaw).toBeNull();
  });
});
