import {
  chartGeometry,
  formatChartNumber,
  formatChartTime,
  type ChartColor,
  type ChartKind,
  type ChartPoint,
  type ChartRange,
} from "./chart-data";

export interface ChartExportSnapshot {
  title: string;
  unit: string;
  kind: ChartKind;
  points: readonly ChartPoint[];
  range: ChartRange;
  sourceAt: number | null;
  coverage: string;
  stale: boolean;
  color: ChartColor;
  bucketMs?: number;
  valueLabel?: string;
}

export const CHART_EXPORT_SIZE = { width: 1800, height: 1000 };

export function chartExportMetadata(snapshot: ChartExportSnapshot): string[] {
  return [
    snapshot.range.label,
    `${formatChartTime(snapshot.range.from)} – ${formatChartTime(snapshot.range.to)}`,
    `Data timestamp: ${formatChartTime(snapshot.sourceAt)}`,
    `${snapshot.stale ? "Last available · " : ""}${snapshot.coverage}`,
    snapshot.kind === "bar"
      ? "Hourly UTC buckets · hatched bars are partial"
      : "Gaps indicate unavailable observations",
  ];
}

function fittedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  size: number,
  weight = 500,
) {
  ctx.font = `${weight} ${size}px "DM Sans", sans-serif`;
  while (ctx.measureText(text).width > maxWidth && size > 15) {
    size -= 1;
    ctx.font = `${weight} ${size}px "DM Sans", sans-serif`;
  }
  ctx.fillText(text, x, y, maxWidth);
}

function wrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
) {
  let line = "",
    offset = 0;
  for (const word of text.split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(candidate).width > maxWidth) {
      ctx.fillText(line, x, y + offset, maxWidth);
      offset += lineHeight;
      line = word;
    } else line = candidate;
  }
  if (line) ctx.fillText(line, x, y + offset, maxWidth);
}

/** Imported only after an explicit export/share action. No screenshot library or external images. */
export async function renderChartPng(
  snapshot: ChartExportSnapshot,
): Promise<Blob> {
  await document.fonts?.ready;
  const canvas = document.createElement("canvas");
  canvas.width = CHART_EXPORT_SIZE.width;
  canvas.height = CHART_EXPORT_SIZE.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Image export is unavailable in this browser.");
  const ink = "#252922",
    muted = "#747768",
    accent = snapshot.color === "green" ? "#506746" : "#9078ad";
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

  const plot = { x: 180, y: 302, width: 1540, height: 420 };
  const geometry = chartGeometry(
    snapshot.points,
    snapshot.range,
    snapshot.kind,
    plot.width,
    plot.height,
    snapshot.bucketMs,
  );
  const last = geometry.points.at(-1);
  ctx.fillStyle = ink;
  fittedText(
    ctx,
    snapshot.valueLabel ?? formatChartNumber(last?.value),
    80,
    263,
    1100,
    58,
    650,
  );
  ctx.fillStyle = muted;
  ctx.textAlign = "right";
  fittedText(ctx, snapshot.range.label, 1720, 255, 560, 24);
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
    ctx.fillText(formatChartNumber(tick.value), -22, tick.y + 7, 132);
  });
  ctx.textAlign = "left";
  ctx.save();
  ctx.beginPath();
  ctx.rect(-5, -5, plot.width + 10, plot.height + 10);
  ctx.clip();
  if (snapshot.kind === "bar") {
    geometry.bars.forEach((bar) => {
      ctx.fillStyle = accent;
      ctx.globalAlpha = bar.partial ? 0.38 : 0.8;
      ctx.fillRect(bar.x, bar.y, bar.width, bar.height);
      ctx.globalAlpha = 1;
      if (bar.partial) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(bar.x, bar.y, bar.width, bar.height);
        ctx.clip();
        ctx.strokeStyle = accent;
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
  ctx.fillStyle = muted;
  fittedText(ctx, metadata[2], 80, 820, 1640, 23);
  ctx.font = '22px "DM Sans", sans-serif';
  wrappedText(
    ctx,
    metadata[3] + (geometry.truncated ? " · Latest 2,048 observations" : ""),
    80,
    858,
    1640,
    30,
  );
  fittedText(ctx, metadata[4], 80, 954, 1640, 20);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("Could not create the chart image.")),
      "image/png",
    ),
  );
}
