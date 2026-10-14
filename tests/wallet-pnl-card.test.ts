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
  const metrics = positionMetricsResponse();
  metrics.updatedAt = at;
  metrics.avgHoldMs = 5_400_000;
  metrics.avgLeverage = 555;
  metrics.coverage.historyBackfillComplete = true;
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
    const model = walletPnlCardModel(source, {
      layout: "gallery",
      hideWallet: true,
    });
    expect(model.pnl).toBe("+$10,000,000,000.12");
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
    source.metrics!.highlights!.bestTrade!.pnlRaw = raw(9999);
    expect(model.pnl).toBe("+$10,000,000,000.12");
    expect(
      model.stats.find((item) => item.label === "Best recorded trade")?.value,
    ).toBe("+$1,250.00");
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
    ).toMatchObject({ pnl: "$0.00", paper: "0.00", pnlTone: "neutral" });
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
