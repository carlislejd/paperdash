export function fittedText(
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

export function wrappedText(
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

export async function imageCanvas(width: number, height: number) {
  await document.fonts?.ready;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Image export is unavailable in this browser.");
  return { canvas, ctx };
}

export function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Could not create the image.")),
      "image/png",
    ),
  );
}

export function downloadImage(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
