import { canvasPng, fittedText, imageCanvas } from "./image-export";
import {
  positionReceiptModel,
  type PositionReceiptSnapshot,
  type ReceiptField,
} from "./position-receipt";

const imageValue = (field: ReceiptField) => field.exportValue ?? field.exact;

/** Character wrapping also preserves very large exact numbers without clipping digits. */
function lines(
  value: string,
  width: number,
  ctx: CanvasRenderingContext2D,
): string[] {
  const result: string[] = [];
  let line = "";
  for (const char of value) {
    if (line && ctx.measureText(line + char).width > width) {
      result.push(line);
      line = "";
    }
    line += char;
  }
  if (line) result.push(line);
  return result;
}
export async function renderPositionReceiptPng(
  snapshot: PositionReceiptSnapshot,
): Promise<Blob> {
  const model = positionReceiptModel(snapshot),
    width = 1200;
  const { canvas, ctx } = await imageCanvas(width, 1600);
  ctx.font = '500 24px "DM Sans", sans-serif';
  const rows = Array.from(
    { length: Math.ceil(model.fields.length / 2) },
    (_, index) => {
      const fields = model.fields.slice(index * 2, index * 2 + 2);
      return {
        fields,
        height: Math.max(
          120,
          ...fields.map(
            (field) => 64 + lines(imageValue(field), 488, ctx).length * 30,
          ),
        ),
      };
    },
  );
  ctx.font = '500 28px "DM Sans", sans-serif';
  const headline = imageValue(model.headline),
    headlineLines = lines(headline, 1040, ctx),
    heroHeight = Math.max(210, 140 + headlineLines.length * 34);
  const warningHeight = model.warnings.length ? 75 : 0;
  canvas.height =
    290 +
    heroHeight +
    rows.reduce((sum, row) => sum + row.height, 0) +
    220 +
    warningHeight;
  ctx.fillStyle = "#f5f2e9";
  ctx.fillRect(0, 0, width, canvas.height);
  ctx.fillStyle = "#262925";
  fittedText(ctx, "paperclub", 70, 96, 720, 50, 600);
  ctx.fillStyle = "#77796e";
  fittedText(ctx, "POSITION RECEIPT", 70, 136, 900, 17, 500);
  ctx.fillStyle = "#262925";
  fittedText(ctx, model.title, 70, 226, 820, 48, 600);
  ctx.fillStyle = "#77796e";
  fittedText(
    ctx,
    `${model.status} · ${model.identity}`,
    70,
    263,
    1060,
    20,
    400,
  );
  let y = 290;
  ctx.fillStyle = "#e7e0ed";
  ctx.fillRect(48, y, 1104, heroHeight);
  ctx.fillStyle = "#756785";
  fittedText(
    ctx,
    model.headline.label.toUpperCase(),
    72,
    y + 42,
    1000,
    17,
    500,
  );
  ctx.fillStyle = snapshot.position.adjustedPnlRaw?.startsWith("-")
    ? "#965957"
    : "#262925";
  if (headline.length < 36)
    fittedText(ctx, headline, 72, y + 122, 1040, 60, 550);
  else {
    ctx.font = '500 28px "DM Sans", sans-serif';
    lines(headline, 1040, ctx).forEach((line, i) =>
      ctx.fillText(line, 72, y + 90 + i * 34),
    );
  }
  y += heroHeight + 22;
  for (const row of rows) {
    row.fields.forEach((field, index) => {
      const x = index ? 624 : 72;
      ctx.fillStyle = "#77796e";
      fittedText(ctx, field.label, x, y + 24, 488, 19, 400);
      ctx.fillStyle = "#262925";
      ctx.font = '500 24px "DM Sans", sans-serif';
      lines(imageValue(field), 488, ctx).forEach((line, lineIndex) =>
        ctx.fillText(line, x, y + 62 + lineIndex * 30),
      );
    });
    y += row.height;
    ctx.strokeStyle = "#d1cdc2";
    ctx.beginPath();
    ctx.moveTo(72, y - 12);
    ctx.lineTo(1128, y - 12);
    ctx.stroke();
  }
  if (model.owner) {
    ctx.fillStyle = "#262925";
    fittedText(ctx, model.owner, 72, y + 28, 1056, 22, 500);
    y += 35;
  }
  ctx.fillStyle = "#77796e";
  fittedText(ctx, model.wallet, 72, y + 28, 1056, 21, 400);
  fittedText(ctx, model.clock, 72, y + 63, 1056, 18, 400);
  fittedText(ctx, model.coverage, 72, y + 95, 1056, 18, 400);
  fittedText(
    ctx,
    "Recorded values, not a settlement statement. Unavailable fields stay unavailable.",
    72,
    y + 126,
    1056,
    17,
    400,
  );
  if (model.warnings.length) {
    ctx.fillStyle = "#977341";
    fittedText(
      ctx,
      `${model.warnings.length} source field${model.warnings.length === 1 ? "" : "s"} unavailable or uncertain. See wallet details.`,
      72,
      y + 161,
      1056,
      18,
      400,
    );
  }
  return canvasPng(canvas);
}
