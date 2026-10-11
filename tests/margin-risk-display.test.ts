import { describe, expect, it } from "vitest";
import {
  riskBarWidths,
  riskMatchesSnapshot,
  riskMoney,
  riskDistanceText,
} from "../apps/web/src/lib/margin-risk-display";
import { buildWalletMarginRisk } from "../packages/shared/src/margin-risk";
import { walletResponse, WALLET } from "./e2e/fixtures";

describe("wallet margin display", () => {
  it("keeps positive sub-display distances distinct from an at-or-beyond threshold", () => {
    expect(riskDistanceText({ atOrBeyond: false, distanceBps: 0 })).toBe(
      "<0.001%",
    );
    expect(riskDistanceText({ atOrBeyond: false, distanceBps: 0.0001 })).toBe(
      "<0.001%",
    );
    expect(riskDistanceText({ atOrBeyond: true, distanceBps: 0 })).toBe(
      "At / beyond",
    );
    expect(riskDistanceText({ atOrBeyond: false, distanceBps: 25 })).toBe(
      "0.25%",
    );
  });
  it("keeps segment proportions finite for giant exact margins and zero", () => {
    const giant = 2n ** 255n;
    const totals = {
      positionCount: 2,
      initialMarginRaw: String(giant * 2n),
      cashMarginRaw: String(giant),
      queuedMarginRaw: String(giant),
    };
    expect(riskBarWidths(totals, giant * 2n)).toEqual({ cash: 50, queued: 50 });
    expect(
      riskBarWidths(
        { ...totals, cashMarginRaw: "0", queuedMarginRaw: "0" },
        0n,
      ),
    ).toEqual({ cash: 0, queued: 0 });
    expect(riskMoney(String(giant))).toMatch(/^\$[\d.]+E\d+$/);
  });

  it("requires revision, block, time and wallet identity to match the displayed snapshot", () => {
    const at = 1791732000000;
    const wallet = walletResponse(WALLET, at);
    wallet.snapshot!.indexedThroughTimestamp = at / 1000;
    const risk = buildWalletMarginRisk(wallet.snapshot, {
      address: WALLET,
      asOf: at,
      snapshotReceivedAt: at,
      snapshotStale: false,
      references: [],
    });
    expect(riskMatchesSnapshot(risk, wallet.snapshot, WALLET)).toBe(true);
    for (const patch of [
      { accountRevision: 4 },
      { indexedThroughBlock: 9999 },
      { indexedThroughTimestamp: at / 1000 - 1 },
      { address: `0x${"2".repeat(40)}` },
    ]) {
      expect(
        riskMatchesSnapshot(risk, { ...wallet.snapshot!, ...patch }, WALLET),
      ).toBe(false);
    }
    expect(riskMatchesSnapshot(undefined, wallet.snapshot, WALLET)).toBe(false);
    expect(riskMatchesSnapshot(risk, null, WALLET)).toBe(false);
  });
});
