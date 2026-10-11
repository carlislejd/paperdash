import { describe, expect, it, vi } from "vitest";
import {
  normalizeClosedPosition,
  normalizeOpenPosition,
} from "../packages/shared/src/position-details";
import {
  exactScaledValue,
  freezePositionReceipt,
  positionReceiptModel,
  positionWalletLink,
} from "../apps/web/src/lib/position-receipt";
import { renderPositionReceiptPng } from "../apps/web/src/lib/position-receipt-export";
const at = Date.UTC(2026, 9, 10),
  wallet = `0x${"a".repeat(40)}`,
  raw = (value: number) => (BigInt(value) * 10n ** 18n).toString();
const closed = () =>
  normalizeClosedPosition(
    {
      positionId: "12",
      instrumentId: 0,
      symbol: "BTC",
      priceScaleRaw: "10",
      isLong: true,
      kind: "Liquidated",
      timestampMs: at,
      openedAtMs: at - 60_000,
      entryPriceRaw: "800001",
      exitPriceRaw: "799201",
      marginRaw: raw(10_000_000_000),
      leverage: 1000,
      adjustedPnlRaw: raw(-10_000_000_000),
      userPaidFeeRaw: "0",
      paperMintedRaw: raw(400),
      paperMintBasisRaw: raw(10_000_000_000),
      txHash: `0x${"b".repeat(64)}`,
    },
    { walletAddress: wallet, receivedAt: at, asOf: at },
  )!;

describe("frozen position receipt presentation", () => {
  it("keeps exact large accounting values and explicit price scales without number rounding", () => {
    const huge = (2n ** 256n - 1n).toString();
    expect(exactScaledValue(huge)).toBe(
      "115,792,089,237,316,195,423,570,985,008,687,907,853,269,984,665,640,564,039,457.584007913129639935",
    );
    expect(exactScaledValue("800001", "10")).toBe("80,000.1");
    expect(exactScaledValue("1", "8")).toBe("0.125");
    expect(exactScaledValue("1", "3")).toBe("1 ÷ 3");
    expect(exactScaledValue("0")).toBe("0");
    expect(exactScaledValue(null)).toBeNull();
    expect(exactScaledValue("1", "0")).toBeNull();
    const model = positionReceiptModel(
      freezePositionReceipt(closed(), null, false),
    );
    expect(model.headline.value).toBe("−10,000,000,000 USDC");
    expect(model.fields.find((f) => f.label === "Entry notional")?.exact).toBe(
      "10,000,000,000,000 USD",
    );
    expect(model.fields.find((f) => f.label === "Margin funding")?.value).toBe(
      "—",
    );
    expect(model.fields.find((f) => f.label === "User fee")?.exact).toBe(
      "0 USDC",
    );
    expect(
      model.fields.find((f) => f.label === "Eligible loss basis")?.exact,
    ).toBe("10,000,000,000 USD");
  });
  it("freezes selected source state and keeps clocks, queued balance and unknown prices truthful", () => {
    const source = closed(),
      frozen = freezePositionReceipt(source, "Name", true);
    source.adjustedPnlRaw = "0";
    source.warnings.push("changed");
    expect(frozen.position.adjustedPnlRaw).not.toBe("0");
    expect(frozen.position.warnings).toHaveLength(0);
    expect(positionReceiptModel(frozen).clock).toContain("History checked");
    const open = normalizeOpenPosition(
      ["13", 99, false, true, "123", raw(10), 1000, "100", at - 60_000, null],
      { walletAddress: wallet, receivedAt: null, asOf: at },
    )!;
    const model = positionReceiptModel(
      freezePositionReceipt(open, null, false),
    );
    expect(model.fields.find((f) => f.label === "Margin funding")?.value).toBe(
      "Queued balance",
    );
    expect(model.fields.find((f) => f.label === "Entry price")?.value).toBe(
      "—",
    );
    expect(model.fields.find((f) => f.label === "Age at snapshot")?.value).toBe(
      "1m",
    );
    expect(model.clock).toContain("Snapshot time");
    expect(
      positionWalletLink(
        wallet,
        "https://papertrade.club/?q=secret&chart=tvl&view=following#x",
      ),
    ).toBe(`https://papertrade.club/?wallet=${wallet}`);
  });
  it("exports the same frozen exact values, unavailable fields and source clock without clipping large digits", async () => {
    const p = closed();
    p.initialMarginRaw = (2n ** 256n - 1n).toString();
    p.entryNotionalRaw = (BigInt(p.initialMarginRaw) * 1000n).toString();
    p.adjustedPnlRaw = null;
    const labels: string[] = [],
      boxes: { x: number; y: number }[] = [];
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      font: "",
      fillRect() {},
      fillText(text: string, x: number, y: number) {
        labels.push(text);
        boxes.push({ x, y });
      },
      measureText(text: string) {
        return { width: text.length * 14 };
      },
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ctx,
      toBlob: (callback: (blob: Blob) => void) =>
        callback(new Blob(["png"], { type: "image/png" })),
    };
    vi.stubGlobal("document", {
      fonts: { ready: Promise.resolve() },
      createElement: () => canvas,
    });
    try {
      await renderPositionReceiptPng(freezePositionReceipt(p, null, false));
      expect(labels).toContain("paperclub");
      expect(labels).toContain("Unavailable");
      expect(labels.some((t) => t.startsWith("History checked"))).toBe(true);
      const exact = exactScaledValue(p.entryNotionalRaw)! + " USD";
      expect(labels.join("")).toContain(exact);
      expect(Math.max(...boxes.map((b) => b.y))).toBeLessThan(canvas.height);
      expect(canvas.width).toBe(1200);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
