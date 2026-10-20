import { describe, expect, it } from "vitest";
import { participationChanges } from "../apps/web/src/lib/reward-dilution";

const token = (amount: bigint) => (amount * 10n ** 18n).toString();
const context = (supplyFrom: bigint, supplyTo: bigint, stakedFrom: bigint, stakedTo: bigint) => ({
  supplyFromRaw: token(supplyFrom), supplyToRaw: token(supplyTo),
  stakedFromRaw: token(stakedFrom), stakedToRaw: token(stakedTo),
});

describe("reward participation changes", () => {
  it("distinguishes total supply growth from a shrinking staking pool", () => {
    const changes = participationChanges(context(1000n, 1100n, 800n, 600n))!;
    expect(changes.supply.label).toBe("+10.00%");
    expect(changes.staked.label).toBe("−25.00%");
    expect(changes.staked.title).toContain("800 → 600 PAPER; net change −200 PAPER");
  });

  it("keeps tiny signed changes distinct from measured zero with large exact balances", () => {
    const large = 10n ** 40n;
    const changes = participationChanges(context(large, large + 1n, large / 2n, large / 2n - 1n))!;
    expect(changes.supply.label).toBe("+<0.01%");
    expect(changes.staked.label).toBe("−<0.01%");
    expect(participationChanges(context(large, large, large, large))!.supply.label).toBe("0.00%");
  });

  it("does not invent a percentage for zero starting supply or zero starting stake", () => {
    const changes = participationChanges(context(0n, 100n, 0n, 10n))!;
    expect(changes.supply.label).toBe("—");
    expect(changes.staked.label).toBe("—");
    expect(changes.staked.title).toContain("starting balance was zero");
  });

  it("rejects missing or impossible paired totals", () => {
    expect(participationChanges(undefined)).toBeNull();
    expect(participationChanges(null)).toBeNull();
    expect(participationChanges(context(100n, 110n, 101n, 90n))).toBeNull();
    expect(participationChanges(context(100n, 110n, 90n, 111n))).toBeNull();
    expect(participationChanges({ ...context(100n, 110n, 90n, 100n), supplyToRaw: "1e20" })).toBeNull();
  });
});
