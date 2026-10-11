import {
  canvasPng,
  fittedText,
  imageCanvas,
  wrappedText,
} from "./image-export";
import { formatChartTime } from "./chart-data";
import { formatUsd, shortAddress } from "./format";
import {
  riskBarMaximum,
  riskBarWidths,
  riskBandLabels,
  riskMoney,
  type MarginRiskExportSnapshot,
} from "./margin-risk-display";

export async function renderMarginRiskPng(
  snapshot: MarginRiskExportSnapshot,
): Promise<Blob> {
  const { canvas, ctx } = await imageCanvas(1600, 1200);
  const asset = snapshot.asset,
    maximum = riskBarMaximum(asset);
  const ink = "#252922",
    muted = "#747768",
    accent = "#9078ad";
  ctx.fillStyle = "#f5f2e9";
  ctx.fillRect(0, 0, 1600, 1200);
  ctx.fillStyle = ink;
  fittedText(ctx, "paperclub.", 70, 90, 900, 42, 700);
  ctx.fillStyle = muted;
  ctx.textAlign = "right";
  fittedText(ctx, "papertrade.club", 1530, 88, 500, 23);
  ctx.textAlign = "left";
  ctx.fillStyle = ink;
  fittedText(ctx, `${asset.symbol} · Margin at risk`, 70, 176, 1300, 49, 650);
  ctx.fillStyle = muted;
  fittedText(
    ctx,
    `${snapshot.name ? `${snapshot.name} · ` : ""}${shortAddress(snapshot.address)}`,
    70,
    220,
    1420,
    23,
  );
  ctx.fillStyle = ink;
  fittedText(
    ctx,
    `${riskMoney(asset.totals.initialMarginRaw)} USDC`,
    70,
    294,
    1420,
    52,
    650,
  );
  ctx.fillStyle = muted;
  fittedText(
    ctx,
    `Initial margin · Cash ${riskMoney(asset.totals.cashMarginRaw)} · Queued balance ${riskMoney(asset.totals.queuedMarginRaw)}`,
    70,
    332,
    1420,
    23,
  );
  fittedText(
    ctx,
    `Hyperliquid midpoint ${formatUsd(asset.reference?.priceUsd)} · approximate reference`,
    70,
    373,
    1420,
    23,
  );
  const left = 190,
    right = 880,
    barWidth = 435;
  fittedText(ctx, "Longs · lower price", left, 433, 500, 24, 600);
  fittedText(ctx, "Shorts · higher price", right, 433, 600, 24, 600);
  (asset.bands ?? []).forEach((band, index) => {
    const y = 470 + index * 58;
    ctx.fillStyle = muted;
    fittedText(ctx, riskBandLabels[band.key], 70, y + 25, 110, 18);
    for (const [side, x] of [
      [band.long, left],
      [band.short, right],
    ] as const) {
      const widths = riskBarWidths(side, maximum);
      ctx.fillStyle = "#e7e4da";
      ctx.fillRect(x, y, barWidth, 30);
      ctx.fillStyle = accent;
      ctx.fillRect(x, y, (barWidth * widths.cash) / 100, 30);
      const start = x + (barWidth * widths.cash) / 100,
        width = (barWidth * widths.queued) / 100;
      ctx.fillStyle = "#d8cde4";
      ctx.fillRect(start, y, width, 30);
      ctx.save();
      ctx.beginPath();
      ctx.rect(start, y, width, 30);
      ctx.clip();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      for (let dx = start - 30; dx < start + width; dx += 10) {
        ctx.beginPath();
        ctx.moveTo(dx, y + 30);
        ctx.lineTo(dx + 30, y);
        ctx.stroke();
      }
      ctx.restore();
      ctx.fillStyle = ink;
      fittedText(
        ctx,
        riskMoney(side.initialMarginRaw),
        x + barWidth + 12,
        y + 24,
        145,
        21,
      );
    }
  });
  ctx.fillStyle = muted;
  fittedText(
    ctx,
    "Solid = cash · Hatched = queued balance · Bands do not overlap",
    70,
    908,
    1440,
    21,
  );
  fittedText(
    ctx,
    `${snapshot.stale ? "Last available · " : ""}Wallet snapshot: ${formatChartTime(snapshot.snapshotAt)}`,
    70,
    950,
    1440,
    21,
  );
  fittedText(
    ctx,
    `Reference: ${formatChartTime(asset.reference?.sourceAt)} · Wallet coverage: ${snapshot.includedCount} included / ${snapshot.excludedCount} excluded positions`,
    70,
    985,
    1440,
    21,
  );
  ctx.font = '400 22px "DM Sans", sans-serif';
  wrappedText(
    ctx,
    "Initial margin grouped by recorded bust distance. A hypothetical price comparison, not predicted loss or current liquidation eligibility. Snapshot and reference have separate timestamps.",
    70,
    1035,
    1440,
    32,
  );
  fittedText(ctx, snapshot.address, 70, 1150, 1440, 19);
  return canvasPng(canvas);
}
