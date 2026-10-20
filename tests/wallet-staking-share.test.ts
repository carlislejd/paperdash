import { describe, expect, it } from "vitest";
import type { WalletResponse } from "../packages/shared/src/types";
import { formatStakingShare, walletStakingShare } from "../apps/web/src/lib/wallet-staking-share";

const at = 1_800_000_000_000;
const wallet = () => ({
  snapshot: { paper: { staked: "10" } },
  stakingParticipation: {
    walletStakedRaw: "10", totalStakedRaw: "1000",
    sourceAt: at, receivedAt: at, stale: false,
  },
}) as WalletResponse;

describe("wallet staking share display", () => {
  it("formats exact ratios without coercing raw amounts to floating point", () => {
    expect(formatStakingShare("0", "100")).toBe("0%");
    expect(formatStakingShare("1", "1")).toBe("100%");
    expect(formatStakingShare("1", "3")).toBe("33.333333%");
    expect(formatStakingShare("1", "1000000")).toBe("0.0001%");
    expect(formatStakingShare("1", "1000000000")).toBe("1 × 10⁻⁷%");
    expect(formatStakingShare("12345", "1000000000000")).toBe("1.234 × 10⁻⁶%");
    expect(formatStakingShare("1", "1" + "0".repeat(77))).toBe("1 × 10⁻⁷⁵%");
    expect(formatStakingShare("1" + "0".repeat(76), "1" + "0".repeat(77))).toBe("10%");
  });

  it("never turns impossible or unavailable participation into zero", () => {
    for (const pair of [["-1", "100"], ["0", "0"], ["101", "100"], ["1.5", "100"], ["1e18", "100"], ["1", "9".repeat(79)]]) {
      expect(formatStakingShare(pair[0], pair[1])).toBeNull();
    }
    const current = wallet();
    current.snapshot!.paper.staked = "20";
    expect(walletStakingShare(current, at)).toBeNull();
    delete current.stakingParticipation;
    expect(walletStakingShare(current, at)).toBeNull();
  });

  it("ages the paired summary and receipt clocks and retains refresh failures", () => {
    expect(walletStakingShare(wallet(), at)).toMatchObject({ label: "1%", stale: false });
    expect(walletStakingShare(wallet(), at + 30001)).toMatchObject({ label: "1%", stale: true });
    expect(walletStakingShare(wallet(), at, true)?.stale).toBe(true);
    const current = wallet();
    current.stakingParticipation!.sourceAt = at - 30001;
    expect(walletStakingShare(current, at)?.stale).toBe(true);
    current.stakingParticipation!.sourceAt = at + 30001;
    expect(walletStakingShare(current, at)).toBeNull();
  });
});
