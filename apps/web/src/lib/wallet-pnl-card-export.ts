import { canvasPng, fittedText, imageCanvas } from "./image-export";
import { PNL_CARD_ART, type PnlCardModel } from "./wallet-pnl-card";

const C = {
  paper: "#f5f2e9",
  ink: "#282c27",
  muted: "#77776e",
  line: "#d6d0c5",
  lilac: "#c5b2d6",
  lavender: "#e7dfea",
  green: "#526e51",
  red: "#a25865",
};
let artPromise: Promise<HTMLImageElement> | null = null;
function artwork() {
  if (!artPromise)
    artPromise = new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      const cleanup = () => {
        clearTimeout(timer);
        image.onload = null;
        image.onerror = null;
      };
      const fail = () => {
        cleanup();
        artPromise = null;
        image.src = "";
        reject(new Error("The card artwork could not load. Try again."));
      };
      const timer = setTimeout(fail, 8_000);
      image.onload = () => {
        cleanup();
        resolve(image);
      };
      image.onerror = fail;
      image.src = PNL_CARD_ART;
    });
  return artPromise;
}
function mark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 48, size / 48);
  ctx.translate(0, 3.5);
  ctx.fillStyle = C.lilac;
  for (const [path, opacity] of [
    ["M8 12 27 25 19 31Z", 0.55],
    ["M2 22 18 28 23 36 14 31Z", 0.75],
    ["m23 5 7 22-8 7-6-5Z", 1],
    ["m16 29 14-2 6-11h3l7 7-8-2-3 10-12 5Z", 0.85],
    ["m16 29 14-2-7 9Z", 0.75],
  ] as const) {
    ctx.globalAlpha = opacity;
    ctx.fill(new Path2D(path));
  }
  ctx.restore();
}

/** The dialog preview and the downloaded file use these exact same pixels. */
export async function renderWalletPnlCardPng(
  input: PnlCardModel,
  { signal }: { signal?: AbortSignal } = {},
): Promise<Blob> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  const expiresAt = performance.now() + 12_000;
  const timeout = () =>
    controller.abort(new Error("Creating the card took too long. Try again."));
  const check = () => {
    if (performance.now() >= expiresAt) timeout();
    controller.signal.throwIfAborted();
  };
  let rejectAbort: () => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  signal?.addEventListener("abort", forwardAbort, { once: true });
  if (signal?.aborted) forwardAbort();
  const deadline = setTimeout(timeout, 12_000);
  try {
    // The shared artwork load survives a cancelled preview; another preview
    // may still need it. Checks in the pipeline prevent cancelled work encoding.
    return await Promise.race([renderCard(input, check), aborted]);
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", forwardAbort);
    controller.signal.removeEventListener("abort", rejectAbort!);
  }
}

async function renderCard(
  input: PnlCardModel,
  check: () => void,
): Promise<Blob> {
  check();
  const m = structuredClone(input);
  const fonts = document.fonts?.load('600 36px "DM Sans"');
  const [{ canvas, ctx }, art] = await Promise.all([
    imageCanvas(m.width, m.height),
    artwork(),
    fonts,
  ]);
  check();
  const w = m.width,
    h = m.height;
  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, w, h);
  const text = (
    value: string,
    x: number,
    y: number,
    width: number,
    size: number,
    color: string = C.ink,
    weight = 500,
  ) => {
    ctx.fillStyle = color;
    fittedText(ctx, value, x, y, width, size, weight);
  };
  const line = (x: number, y: number, width: number) => {
    ctx.fillStyle = C.line;
    ctx.fillRect(x, y, width, 1);
  };
  const artRect = (
    x: number,
    y: number,
    width: number,
    height: number,
    focus = 0.5,
  ) => {
    const scale = Math.max(width / art.width, height / art.height);
    const sw = width / scale,
      sh = height / scale;
    ctx.drawImage(
      art,
      (art.width - sw) * focus,
      (art.height - sh) / 2,
      sw,
      sh,
      x,
      y,
      width,
      height,
    );
  };
  const brand = (x: number, y: number, size = 34) => {
    mark(ctx, x, y - size, size + 8);
    text("paperclub", x + size + 18, y, 270, size, C.ink, 650);
    text("P&L CARD", w - 190, y - 3, 145, 13, C.muted, 500);
  };
  const identity = (x: number, y: number, width: number) => {
    text(m.identity, x, y, width, 19, C.ink, 600);
    if (
      m.address &&
      m.identity !== `${m.address.slice(0, 6)}…${m.address.slice(-4)}`
    )
      text(
        `${m.address.slice(0, 6)}…${m.address.slice(-4)}`,
        x,
        y + 23,
        width,
        14,
        C.muted,
      );
  };
  const hero = (x: number, y: number, width: number, size = 90) => {
    text("LIFETIME REALIZED P&L", x, y, width, 14, C.muted, 500);
    text(
      m.pnl,
      x - 3,
      y + size + 2,
      width,
      size,
      m.pnlTone === "positive"
        ? C.green
        : m.pnlTone === "negative"
          ? C.red
          : C.ink,
      600,
    );
  };
  const paper = (x: number, y: number, width: number, size = 42) => {
    text("PAPER OWNED", x, y, width, 14, C.muted);
    text(m.paper, x, y + size + 4, width, size, C.ink, 600);
    text("Staked + unstaked", x, y + size + 30, width, 14, C.muted);
  };
  const stats = (
    x: number,
    y: number,
    width: number,
    columns: number,
    rowHeight: number,
    size: number,
    limit = 6,
  ) => {
    const cell = width / columns;
    m.stats.slice(0, limit).forEach((s, i) => {
      const left = x + (i % columns) * cell,
        top = y + Math.floor(i / columns) * rowHeight;
      line(left, top, cell - 26);
      text(s.label, left, top + 30, cell - 28, 15, C.muted);
      text(s.value, left, top + 73, cell - 28, size, C.ink, 550);
      if (s.detail) text(s.detail, left, top + 96, cell - 28, 13, C.muted);
    });
  };
  const footer = (x: number, y: number, width: number) => {
    line(x, y - 22, width);
    text(m.accountNote, x, y, width - 260, 13, C.muted);
    text(m.historyNote, x, y + 22, width - 260, 13, C.muted);
    text("papertrade.club", x + width - 230, y + 16, 230, 22, C.ink, 550);
  };
  if (m.layout === "gallery") {
    brand(46, 62);
    artRect(26, 90, w - 52, 305);
    identity(48, 442, 360);
    hero(48, 497, 720, 88);
    paper(831, 497, 315, 36);
    stats(48, 626, w - 70, 4, 120, 31, 4);
    footer(48, 833, w - 96);
  } else if (m.layout === "split") {
    artRect(565, 0, 635, 432, 0.83);
    ctx.fillStyle = C.lavender;
    ctx.fillRect(0, 0, 565, 432);
    brand(36, 55, 30);
    identity(38, 112, 482);
    hero(38, 181, 492, 67);
    paper(38, 306, 475, 39);
    stats(38, 459, w - 50, 4, 108, 30, 4);
    footer(38, 617, w - 76);
  } else {
    brand(48, 70, 38);
    artRect(24, 102, w - 48, 366, 0.72);
    identity(48, 518, w - 96);
    hero(48, 584, w - 96, 106);
    ctx.fillStyle = C.lavender;
    ctx.fillRect(32, 733, w - 64, 137);
    paper(56, 769, w - 112, 48);
    stats(48, 906, w - 70, 3, 136, 36);
    footer(48, 1260, w - 96);
  }
  check();
  const blob = await canvasPng(canvas);
  check();
  return blob;
}
