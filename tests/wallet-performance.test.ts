import { describe, expect, it } from "vitest";
import { walletPerformance } from "../apps/web/src/lib/wallet-performance";
import { walletPnlCardModel, PNL_CARD_LAYOUTS } from "../apps/web/src/lib/wallet-pnl-card";
import { walletResponse, WALLET } from "./e2e/fixtures";

const at = Date.UTC(2026, 9, 16, 18);
const raw = (amount: number) => (BigInt(amount) * 10n ** 18n).toString();
function losingWallet() {
  const wallet = walletResponse(WALLET, at);
  wallet.snapshot!.indexedThroughTimestamp = at / 1000;
  wallet.accountFreshness = { sourceAt: at, receivedAt: at, stale: false, refreshing: false };
  wallet.snapshot!.lifetime.realizedPnlRaw = raw(-1000);
  wallet.snapshot!.lifetime.paperRewardsClaimedRaw = raw(250);
  wallet.snapshot!.paper = { balance: raw(40_000), staked: raw(60_000) };
  wallet.stakingRewards = { pendingRaw: raw(150), sourceAt: at, receivedAt: at, stale: false };
  return wallet;
}

describe("PAPER break-even", () => {
  it("offsets lifetime realized losses with claimed and pending rewards, over all owned PAPER", () => {
    const wallet = losingWallet();
    expect(walletPerformance(wallet, at)).toMatchObject({
      paperBreakEven: "$0.006000",
      paperBreakEvenStatus: "price",
      paperBreakEvenNote: "USDC per PAPER",
    });
    // Changes to deposits or an open position cannot change the realized basis.
    wallet.snapshot!.lifetime.depositedRaw = raw(1_000_000);
    wallet.snapshot!.openPositions = [];
    expect(walletPerformance(wallet, at).paperBreakEven).toBe("$0.006000");
  });

  it("uses the exact recovery threshold, even one raw unit below it", () => {
    const wallet = losingWallet();
    const remaining = BigInt(raw(750));
    wallet.stakingRewards!.pendingRaw = (remaining - 1n).toString();
    expect(walletPerformance(wallet, at)).toMatchObject({ paperBreakEven: "<$0.000001", paperBreakEvenStatus: "price" });
    wallet.stakingRewards!.pendingRaw = remaining.toString();
    expect(walletPerformance(wallet, at)).toMatchObject({ paperBreakEven: "Cost recovered", paperBreakEvenStatus: "recovered" });
    wallet.stakingRewards!.pendingRaw = (remaining + 1n).toString();
    expect(walletPerformance(wallet, at).paperBreakEven).toBe("Cost recovered");
  });

  it.each([0, 1_000])("shows recovered for a nonnegative trading result (%s) with known rewards", (pnl) => {
    const wallet = losingWallet();
    wallet.snapshot!.lifetime.realizedPnlRaw = raw(pnl);
    wallet.snapshot!.lifetime.paperRewardsClaimedRaw = "0";
    wallet.stakingRewards!.pendingRaw = "0";
    expect(walletPerformance(wallet, at).paperBreakEven).toBe("Cost recovered");
  });

  it("rounds subcent prices to six decimals without reducing a positive balance to zero", () => {
    const wallet = losingWallet();
    wallet.snapshot!.paper = { balance: raw(90_000), staked: "0" };
    expect(walletPerformance(wallet, at).paperBreakEven).toBe("$0.006667");
    wallet.snapshot!.paper.balance = raw(1_000_000_000);
    expect(walletPerformance(wallet, at).paperBreakEven).toBe("<$0.000001");
  });

  it.each([null, "invalid", "-1"])("preserves missing or invalid pending rewards (%s), without pendingBase", (pending) => {
    const wallet = losingWallet();
    wallet.stakingRewards!.pendingRaw = pending;
    wallet.snapshot!.paper.pendingBase = raw(750);
    expect(walletPerformance(wallet, at)).toMatchObject({
      paperBreakEven: "—", paperBreakEvenStatus: "unavailable", paperBreakEvenNote: "Pending rewards unavailable",
    });
  });

  it("keeps missing account, trading, claimed, PAPER and zero PAPER distinct", () => {
    const cases = [
      [(wallet: ReturnType<typeof losingWallet>) => { wallet.snapshot = null; }, "Account snapshot unavailable"],
      [(wallet: ReturnType<typeof losingWallet>) => { wallet.snapshot!.lifetime.realizedPnlRaw = "invalid"; }, "Trading P&L unavailable"],
      [(wallet: ReturnType<typeof losingWallet>) => { wallet.snapshot!.lifetime.paperRewardsClaimedRaw = "-1"; }, "Claimed rewards unavailable"],
      [(wallet: ReturnType<typeof losingWallet>) => { wallet.snapshot!.paper.staked = "invalid"; }, "PAPER balance unavailable"],
      [(wallet: ReturnType<typeof losingWallet>) => { wallet.snapshot!.paper = { balance: "0", staked: "0" }; }, "No PAPER owned"],
    ] as const;
    for (const [change, reason] of cases) {
      const wallet = losingWallet();
      change(wallet);
      expect(walletPerformance(wallet, at)).toMatchObject({ paperBreakEven: "—", paperBreakEvenStatus: "unavailable", paperBreakEvenNote: reason });
    }
  });

  it("labels last available values when either source or the account refresh is delayed", () => {
    const changes = [
      (wallet: ReturnType<typeof losingWallet>) => { wallet.stakingRewards!.stale = true; },
      (wallet: ReturnType<typeof losingWallet>) => { wallet.stakingRewards!.sourceAt = at - 30_001; },
      (wallet: ReturnType<typeof losingWallet>) => { wallet.stakingRewards!.receivedAt = at - 30_001; },
      (wallet: ReturnType<typeof losingWallet>) => { wallet.accountFreshness!.stale = true; },
      (wallet: ReturnType<typeof losingWallet>) => { wallet.accountFreshness!.receivedAt = at - 30_001; },
      (wallet: ReturnType<typeof losingWallet>) => { wallet.accountFreshness!.sourceAt = at - 1; },
    ];
    for (const change of changes) {
      const wallet = losingWallet();
      change(wallet);
      expect(walletPerformance(wallet, at)).toMatchObject({ paperBreakEven: "$0.006000", paperBreakEvenNote: "USDC per PAPER · last available" });
    }
    expect(walletPerformance(losingWallet(), at, true).paperBreakEvenNote).toContain("last available");
  });

  it("freezes the same value and freshness in every privacy-safe card layout", () => {
    const wallet = losingWallet();
    const source = { wallet, metrics: null, displayName: "Private name", capturedAt: at };
    for (const layout of PNL_CARD_LAYOUTS) {
      const model = walletPnlCardModel(source, { layout: layout.id, hideWallet: true });
      expect(model.paperBreakEven).toBe(walletPerformance(wallet, at).paperBreakEven);
      expect(model.paperBreakEvenNote).toBe("USDC per PAPER");
      expect(model.shareText).toContain("$0.006000 PAPER break-even (USDC per PAPER)");
      expect(JSON.stringify(model)).not.toContain(WALLET);
      expect(JSON.stringify(model)).not.toContain("Private name");
      const prior = wallet.stakingRewards!.pendingRaw;
      wallet.stakingRewards!.pendingRaw = raw(10_000);
      wallet.stakingRewards!.stale = true;
      expect(model.paperBreakEven).toBe("$0.006000");
      expect(model.paperBreakEvenNote).toBe("USDC per PAPER");
      wallet.stakingRewards!.pendingRaw = prior;
      wallet.stakingRewards!.stale = false;
    }
  });
});
