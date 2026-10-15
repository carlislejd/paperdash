import { describe, expect, it } from "vitest";
import {
  PNL_CARD_LAYOUTS,
  walletPnlCardModel,
  type PnlCardSnapshot,
} from "../apps/web/src/lib/wallet-pnl-card";
import {
  positionMetricsResponse,
  walletResponse,
  WALLET,
} from "./e2e/fixtures";

const at = Date.UTC(2026, 9, 13, 20);
const raw = (value: number) => (BigInt(value) * 10n ** 18n).toString();
function snapshot(): PnlCardSnapshot {
  const wallet = walletResponse(WALLET, at);
  wallet.snapshot!.indexedThroughTimestamp = at / 1000;
  wallet.snapshot!.paper = {
    balance: "154000123456789012345678",
    staked: raw(6_000_000),
  };
  wallet.snapshot!.lifetime.realizedPnlRaw = "10000000000123456789012345678";
  wallet.accountFreshness = {
    sourceAt: at,
    receivedAt: at,
    stale: false,
    refreshing: false,
  };
  wallet.stakingRewards = {
    pendingRaw: "0",
    receivedAt: at,
    sourceAt: at,
    stale: false,
  };
  const metrics = positionMetricsResponse();
  metrics.updatedAt = at;
  metrics.avgHoldMs = 5_400_000;
  metrics.avgLeverage = 555;
  metrics.coverage.historyBackfillComplete = true;
  metrics.coverage.lastHistoryIndexedAt = at;
  metrics.highlights = {
    bestTrade: { pnlRaw: raw(1250), symbol: "BTC", positionId: "123" },
    worstTrade: { pnlRaw: raw(-500), symbol: "ETH", positionId: "124" },
    tradeCount: 42,
    excludedCount: 0,
    complete: true,
  };
  return {
    wallet,
    metrics,
    displayName: "Private wallet name",
    capturedAt: at,
  };
}

describe("wallet P&L card model", () => {
  it("uses successful check clocks for an unchanged account and unchanged trade statistics", () => {
    const source = snapshot();
    const old = at - 4 * 3600_000;
    source.wallet.snapshot!.indexedThroughTimestamp = old / 1000;
    source.wallet.accountFreshness!.sourceAt = old;
    source.metrics!.updatedAt = at - 3 * 86400_000;
    const model = walletPnlCardModel(source, {
      layout: "split",
      hideWallet: true,
    });
    expect(model.accountNote).toBe("Account checked · 2026-10-13 20:00 UTC");
    expect(model.historyNote).toBe(
      "Recorded history · checked 2026-10-13 20:00 UTC",
    );
    source.wallet.accountFreshness!.stale = true;
    expect(
      walletPnlCardModel(source, { layout: "split", hideWallet: true })
        .accountNote,
    ).toContain("Saved account checked");
  });

  it("sanitizes hidden identity across every output field and preserves canonical links", () => {
    const source = snapshot();
    for (const layout of PNL_CARD_LAYOUTS) {
      const model = walletPnlCardModel(source, {
        layout: layout.id,
        hideWallet: true,
      });
      expect(model.identity).toBe("WALLET HIDDEN");
      expect(model.address).toBeNull();
      expect(model.link).toBe("https://papertrade.club/");
      expect(model.width).toBe(layout.width);
      expect(model.height).toBe(layout.height);
      expect(JSON.stringify(model)).not.toContain(WALLET);
      expect(JSON.stringify(model)).not.toContain("Private wallet name");
    }
    const named = walletPnlCardModel(source, {
      layout: "gallery",
      hideWallet: false,
    });
    expect(named.identity).toBe("Private wallet name");
    expect(named.address).toBe(WALLET);
    expect(named.link).toBe(`https://papertrade.club/?wallet=${WALLET}`);
  });

  it("uses exact large account totals, independent retained trade counts and immutable presentation fields", () => {
    const source = snapshot();
    source.metrics!.positionCount = 30;
    source.wallet.snapshot!.lifetime.paperRewardsClaimedRaw = raw(1000);
    const model = walletPnlCardModel(source, {
      layout: "gallery",
      hideWallet: true,
    });
    expect(model.pnl).toBe("+$10,000,001,000.12");
    expect(model.tradingPnl).toBe("+$10,000,000,000.12");
    expect(model.rewards).toBe("+$1,000.00");
    expect(model.shareText).toContain("total P&L");
    expect(model.shareText).toContain("realized trading P&L");
    expect(model.shareText).toContain("+$1,000.00 rewards");
    expect(model.paper).toBe("6,154,000.12");
    expect(
      model.stats.find((item) => item.label === "Recorded closed trades")
        ?.value,
    ).toBe("42");
    expect(
      model.stats.find((item) => item.label === "Average hold")?.value,
    ).toBe("1h 30m");
    expect(
      model.stats.find((item) => item.label === "Best recorded trade")?.value,
    ).toBe("+$1,250.00");
    source.wallet.snapshot!.lifetime.realizedPnlRaw = raw(-8);
    source.wallet.snapshot!.lifetime.paperRewardsClaimedRaw = raw(9999);
    source.wallet.stakingRewards!.pendingRaw = raw(9999);
    source.metrics!.highlights!.bestTrade!.pnlRaw = raw(9999);
    expect(model.pnl).toBe("+$10,000,001,000.12");
    expect(model.tradingPnl).toBe("+$10,000,000,000.12");
    expect(model.rewards).toBe("+$1,000.00");
    expect(
      model.stats.find((item) => item.label === "Best recorded trade")?.value,
    ).toBe("+$1,250.00");
  });

  it("counts claimed and pending rewards in the headline even when trading lost money", () => {
    const source = snapshot();
    source.wallet.snapshot!.lifetime.realizedPnlRaw = raw(-200_000);
    source.wallet.snapshot!.lifetime.paperRewardsClaimedRaw = raw(100_000);
    source.wallet.stakingRewards!.pendingRaw = raw(200_000);
    expect(
      walletPnlCardModel(source, { layout: "split", hideWallet: true }),
    ).toMatchObject({
      pnl: "+$100,000.00",
      pnlTone: "positive",
      tradingPnl: "−$200,000.00",
      tradingPnlTone: "negative",
      rewards: "+$300,000.00",
      rewardsNote: "Claimed + pending · USDC",
    });
  });

  it("sums raw trading, claimed and pending amounts exactly before rounding", () => {
    const source = snapshot();
    const huge = 9_007_199_254_740_993n * 10n ** 18n;
    source.wallet.snapshot!.lifetime.realizedPnlRaw = (-huge).toString();
    source.wallet.snapshot!.lifetime.paperRewardsClaimedRaw = (
      huge + 100_000_000_000_000_000n
    ).toString();
    source.wallet.stakingRewards!.pendingRaw = "200000000000000000";
    const exact = walletPnlCardModel(source, {
      layout: "split",
      hideWallet: true,
    });
    expect(exact.pnl).toBe("+$0.30");
    expect(exact.rewards).toBe("+$9,007,199,254,740,993.30");

    source.wallet.snapshot!.lifetime.realizedPnlRaw = "4000000000000000";
    source.wallet.snapshot!.lifetime.paperRewardsClaimedRaw = "4000000000000000";
    source.wallet.stakingRewards!.pendingRaw = "4000000000000000";
    const rounded = walletPnlCardModel(source, {
      layout: "split",
      hideWallet: true,
    });
    expect(rounded.pnl).toBe("+$0.01");
    expect(rounded.rewards).toBe("+$0.01");
  });

  it("keeps unavailable pending rewards unknown even when pendingBase is present", () => {
    const source = snapshot();
    source.wallet.snapshot!.lifetime.realizedPnlRaw = raw(-200_000);
    source.wallet.snapshot!.lifetime.paperRewardsClaimedRaw = raw(300_000);
    source.wallet.snapshot!.paper.pendingBase = raw(99);
    delete source.wallet.stakingRewards;
    expect(
      walletPnlCardModel(source, { layout: "split", hideWallet: true }),
    ).toMatchObject({
      pnl: "—",
      pnlTone: "neutral",
      tradingPnl: "−$200,000.00",
      rewards: "—",
      pnlNote: "Pending rewards unavailable",
      rewardsNote: "Claimed +$300,000.00 · pending unavailable",
    });
  });

  it.each([null, "invalid", "-1"])(
    "does not turn invalid pending rewards (%s) into zero",
    (pendingRaw) => {
      const source = snapshot();
      source.wallet.stakingRewards!.pendingRaw = pendingRaw;
      expect(
        walletPnlCardModel(source, { layout: "split", hideWallet: true }),
      ).toMatchObject({ pnl: "—", pnlTone: "neutral", rewards: "—" });
    },
  );

  it("labels delayed pending rewards while preserving their last known total", () => {
    const source = snapshot();
    source.wallet.snapshot!.lifetime.realizedPnlRaw = raw(-200_000);
    source.wallet.snapshot!.lifetime.paperRewardsClaimedRaw = raw(100_000);
    source.wallet.stakingRewards!.pendingRaw = raw(200_000);
    source.wallet.stakingRewards!.stale = true;
    source.wallet.stakingRewards!.receivedAt = at - 120_000;
    const model = walletPnlCardModel(source, {
      layout: "split",
      hideWallet: true,
    });
    expect(model).toMatchObject({
      pnl: "+$100,000.00",
      rewards: "+$300,000.00",
      rewardsNote: "Claimed + pending · USDC · delayed",
    });
    expect(model.shareText).toContain("USDC · delayed");
  });

  it("cannot form a headline from missing trading or claimed rewards", () => {
    const source = snapshot();
    source.wallet.snapshot!.lifetime.realizedPnlRaw = "invalid";
    source.wallet.snapshot!.lifetime.paperRewardsClaimedRaw = raw(100);
    const missingTrading = walletPnlCardModel(source, {
      layout: "split",
      hideWallet: true,
    });
    expect(missingTrading).toMatchObject({
      pnl: "—",
      tradingPnl: "—",
      rewards: "+$100.00",
    });
    source.wallet.snapshot!.lifetime.realizedPnlRaw = raw(100);
    source.wallet.snapshot!.lifetime.paperRewardsClaimedRaw = "invalid";
    expect(
      walletPnlCardModel(source, { layout: "split", hideWallet: true }),
    ).toMatchObject({ pnl: "—", tradingPnl: "+$100.00", rewards: "—" });
  });

  it("marks rewards delayed when a cached response ages before capture", () => {
    const source = snapshot();
    source.wallet.stakingRewards!.receivedAt = at - 30_001;
    const model = walletPnlCardModel(source, { layout: "split", hideWallet: true });
    expect(model.rewardsNote).toBe("Claimed + pending · USDC · delayed");
    expect(model.rewards).toBe("$0.00");
  });

  it("keeps unavailable values distinct from zero and labels partial or delayed history", () => {
    const source = snapshot();
    source.wallet.snapshot = null;
    source.metrics = null;
    const missing = walletPnlCardModel(source, {
      layout: "portrait",
      hideWallet: true,
    });
    expect(missing.pnl).toBe("—");
    expect(missing.tradingPnl).toBe("—");
    expect(missing.rewards).toBe("—");
    expect(missing.paper).toBe("—");
    expect(missing.stats.every((item) => item.value === "—")).toBe(true);
    expect(missing.historyNote).toBe("Trade statistics unavailable");
    const zero = snapshot();
    zero.wallet.snapshot!.paper = { balance: "0", staked: "0" };
    zero.wallet.snapshot!.lifetime.realizedPnlRaw = "0";
    zero.metrics!.highlights = {
      bestTrade: null,
      worstTrade: null,
      tradeCount: 0,
      excludedCount: 0,
      complete: true,
    };
    expect(
      walletPnlCardModel(zero, { layout: "gallery", hideWallet: true }),
    ).toMatchObject({
      pnl: "$0.00",
      paper: "0.00",
      pnlTone: "neutral",
      tradingPnl: "$0.00",
      rewards: "$0.00",
    });
    zero.metrics!.stale = true;
    zero.metrics!.highlights.complete = false;
    expect(
      walletPnlCardModel(zero, { layout: "gallery", hideWallet: true })
        .historyNote,
    ).toContain("Partial recorded history · delayed");
  });

  it("does not relabel extrema as wins or losses and preserves stale account evidence", () => {
    const source = snapshot();
    source.metrics!.highlights!.bestTrade!.pnlRaw = raw(-10);
    source.metrics!.highlights!.worstTrade!.pnlRaw = raw(-200);
    source.wallet.accountFreshness!.receivedAt = at - 120_000;
    const negative = walletPnlCardModel(source, {
      layout: "split",
      hideWallet: true,
    });
    expect(
      negative.stats.find((item) => item.label === "Best recorded trade")
        ?.value,
    ).toBe("−$10.00");
    expect(
      negative.stats.find((item) => item.label === "Worst recorded trade")
        ?.value,
    ).toBe("−$200.00");
    expect(negative.accountNote).toContain("Saved account");
    source.wallet.accountFreshness!.receivedAt = at;
    source.metrics!.highlights!.bestTrade!.pnlRaw = raw(200);
    source.metrics!.highlights!.worstTrade!.pnlRaw = raw(10);
    const positive = walletPnlCardModel(source, {
      layout: "split",
      hideWallet: true,
    });
    expect(
      positive.stats.find((item) => item.label === "Worst recorded trade")
        ?.value,
    ).toBe("+$10.00");
  });
});
