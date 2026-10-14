import { formatAxisTick } from "./chart-axis";
import {
  fittedText,
  wrappedText,
  imageCanvas,
  canvasPng,
} from "./image-export";
import {
  chartGeometry,
  chartBucketCaption,
  chartColorValue,
  chartStackGeometry,
  formatChartNumber,
  formatChartTime,
  type ChartColor,
  type ChartKind,
  type ChartPoint,
  type ChartRange,
  type ChartSegment,
} from "./chart-data";
import type { ChartSummary } from "./chart-summary";

export interface ChartExportSnapshot {
  title: string;
  unit: string;
  kind: ChartKind;
  points: readonly ChartPoint[];
  segments?: readonly ChartSegment[];
  range: ChartRange;
  sourceAt: number | null;
  timestampLabel?: string;
  coverage: string;
  stale: boolean;
  color: ChartColor;
  bucketMs?: number;
  valueLabel?: string;
  valueCaption?: string;
  /** Frozen with the displayed points before asynchronous image generation. */
  summary?: ChartSummary;
}

export const CHART_EXPORT_SIZE = { width: 1800, height: 1000 };

export function chartExportMetadata(snapshot: ChartExportSnapshot): string[] {
  return [
    snapshot.range.label,
    `${formatChartTime(snapshot.range.from)} – ${formatChartTime(snapshot.range.to)}`,
    `${snapshot.timestampLabel ?? "Data timestamp"}: ${formatChartTime(snapshot.sourceAt)}`,
    `${snapshot.stale ? "Last available · " : ""}${snapshot.coverage}`,
    snapshot.kind === "bar"
      ? chartBucketCaption(snapshot.bucketMs)
      : "Gaps indicate unavailable observations",
    ...(snapshot.kind === "bar" && snapshot.segments?.length
      ? [
          `${snapshot.segments.map((segment) => segment.label).join(" + ")} · ${snapshot.unit}`,
        ]
      : []),
    ...(snapshot.summary
      ? [
          snapshot.summary.coverage,
          ...(snapshot.summary.total
            ? [
                `${snapshot.summary.total.label}: ${formatChartNumber(snapshot.summary.total.value, false)} ${snapshot.unit}`,
              ]
            : []),
        ]
      : []),
  ];
}

/** Imported only after an explicit export/share action. No screenshot library or external images. */
export async function renderChartPng(
  snapshot: ChartExportSnapshot,
): Promise<Blob> {
  const { canvas, ctx } = await imageCanvas(
    CHART_EXPORT_SIZE.width,
    CHART_EXPORT_SIZE.height,
  );
  const ink = "#252922",
    muted = "#747768",
    accent = chartColorValue(snapshot.color);
  ctx.fillStyle = "#f5f2e9";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = ink;
  fittedText(ctx, "paperclub.", 80, 90, 1000, 38, 700);
  ctx.fillStyle = muted;
  ctx.textAlign = "right";
  fittedText(ctx, "papertrade.club", 1720, 86, 650, 22);
  ctx.textAlign = "left";
  ctx.strokeStyle = "#d2d4c6";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(80, 118);
  ctx.lineTo(1720, 118);
  ctx.stroke();
  ctx.fillStyle = ink;
  fittedText(ctx, snapshot.title, 80, 190, 1280, 48, 650);
  ctx.fillStyle = muted;
  ctx.textAlign = "right";
  fittedText(ctx, snapshot.unit, 1720, 189, 280, 25);
  ctx.textAlign = "left";

  const plot = { x: 180, y: 318, width: 1540, height: 404 };
  const geometry = chartGeometry(
    snapshot.points,
    snapshot.range,
    snapshot.kind,
    plot.width,
    plot.height,
    snapshot.bucketMs,
    snapshot.unit === "positions" ||
      snapshot.unit === "liquidations" ||
      snapshot.unit === "wallets",
  );
  const last = geometry.points.at(-1);
  const stack =
    snapshot.kind === "bar" && snapshot.segments?.length
      ? chartStackGeometry(geometry, snapshot.segments)
      : null;
  ctx.fillStyle = ink;
  fittedText(
    ctx,
    snapshot.valueLabel ?? formatChartNumber(last?.value),
    80,
    263,
    snapshot.valueCaption ? 700 : 1100,
    58,
    650,
  );
  ctx.fillStyle = muted;
  if (snapshot.valueCaption)
    fittedText(
      ctx,
      snapshot.valueCaption,
      snapshot.summary?.total ? 80 : 820,
      snapshot.summary?.total ? 295 : 255,
      snapshot.summary?.total ? 700 : 300,
      22,
    );
  ctx.textAlign = "right";
  if (snapshot.summary?.total) {
    fittedText(ctx, snapshot.summary.total.label, 1720, 224, 700, 22);
    ctx.fillStyle = ink;
    fittedText(
      ctx,
      `${formatChartNumber(snapshot.summary.total.value)} ${snapshot.unit}`,
      1720,
      272,
      700,
      38,
      650,
    );
  } else {
    fittedText(ctx, snapshot.range.label, 1720, 255, 560, 24);
  }
  ctx.textAlign = "left";

  ctx.save();
  ctx.translate(plot.x, plot.y);
  ctx.font = '20px "DM Sans", sans-serif';
  geometry.ticks.forEach((tick) => {
    ctx.strokeStyle = "#d8d9cb";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, tick.y);
    ctx.lineTo(plot.width, tick.y);
    ctx.stroke();
    ctx.fillStyle = muted;
    ctx.textAlign = "right";
    ctx.fillText(
      formatAxisTick(
        tick.value,
        geometry.ticks.map((item) => item.value),
      ),
      -22,
      tick.y + 7,
      132,
    );
  });
  ctx.textAlign = "left";
  ctx.save();
  ctx.beginPath();
  ctx.rect(-5, -5, plot.width + 10, plot.height + 10);
  ctx.clip();
  if (snapshot.kind === "bar") {
    (stack?.bars ?? geometry.bars).forEach((bar) => {
      const barColor =
        "color" in bar ? chartColorValue(bar.color as ChartColor) : accent;
      ctx.fillStyle = barColor;
      ctx.globalAlpha = bar.partial ? 0.38 : 0.8;
      ctx.fillRect(bar.x, bar.y, bar.width, bar.height);
      ctx.globalAlpha = 1;
      if (bar.partial) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(bar.x, bar.y, bar.width, bar.height);
        ctx.clip();
        ctx.strokeStyle = barColor;
        ctx.lineWidth = 2;
        for (let x = bar.x - bar.height; x < bar.x + bar.width; x += 10) {
          ctx.beginPath();
          ctx.moveTo(x, bar.y + bar.height);
          ctx.lineTo(x + bar.height, bar.y);
          ctx.stroke();
        }
        ctx.restore();
      }
    });
  } else {
    ctx.strokeStyle = accent;
    ctx.lineWidth = 4;
    ctx.lineJoin = "round";
    ctx.stroke(new Path2D(geometry.path));
    geometry.markers.forEach((point) => {
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  if (!geometry.points.some((point) => point.value !== null)) {
    ctx.fillStyle = muted;
    ctx.font = '26px "DM Sans", sans-serif';
    ctx.textAlign = "center";
    ctx.fillText(
      "No observations in this range",
      plot.width / 2,
      plot.height / 2,
    );
  }
  ctx.restore();
  ctx.fillStyle = muted;
  ctx.font = '20px "DM Sans", sans-serif';
  ctx.textAlign = "left";
  ctx.fillText(formatChartTime(geometry.from), 0, plot.height + 40);
  ctx.textAlign = "right";
  ctx.fillText(formatChartTime(geometry.to), plot.width, plot.height + 40);
  ctx.restore();

  const metadata = chartExportMetadata(snapshot);
  if (stack) {
    // Fixed cells keep both the series name and unit visible without touching the plot.
    const cellWidth = 1640 / stack.segments.length;
    stack.segments.forEach((segment, index) => {
      const x = 80 + index * cellWidth;
      ctx.fillStyle = chartColorValue(segment.color);
      ctx.fillRect(x, 778, 15, 15);
      ctx.fillStyle = muted;
      fittedText(
        ctx,
        `${segment.label} · ${snapshot.unit}`,
        x + 24,
        792,
        cellWidth - 40,
        21,
      );
    });
  }
  ctx.fillStyle = muted;
  fittedText(
    ctx,
    `${metadata[2]} · ${snapshot.range.label}`,
    80,
    820,
    1640,
    23,
  );
  ctx.font = '22px "DM Sans", sans-serif';
  wrappedText(
    ctx,
    metadata[3] + (geometry.truncated ? " · Latest 2,048 observations" : ""),
    80,
    858,
    1640,
    30,
  );
  if (snapshot.summary)
    fittedText(ctx, snapshot.summary.coverage, 80, 922, 1640, 20);
  fittedText(ctx, metadata[4], 80, 954, 1640, 20);
  return canvasPng(canvas);
}
