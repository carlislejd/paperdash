// Rasterize the code-native brand mark for browsers that need PNG/ICO icons.
// Run after changing favicon.svg: node scripts/generate-icons.mjs
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const assets = new URL("../apps/web/public/", import.meta.url);
const svg = await readFile(new URL("favicon.svg", assets), "utf8");
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const icons = new Map();
  for (const size of [16, 32, 180, 192]) {
    const base64 = await page.evaluate(async ({ svg, size }) => {
      const image = new Image();
      image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      canvas.getContext("2d").drawImage(image, 0, 0, size, size);
      return canvas.toDataURL("image/png").split(",")[1];
    }, { svg, size });
    const png = Buffer.from(base64, "base64");
    icons.set(size, png);
    const name = size === 180 ? "apple-touch-icon.png" : `favicon-${size}.png`;
    await writeFile(new URL(name, assets), png);
  }

  // Modern ICO containers accept lossless PNG entries at each native size.
  const sizes = [16, 32, 192];
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    const png = icons.get(size);
    header[entry] = header[entry + 1] = size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  await writeFile(new URL("favicon.ico", assets), Buffer.concat([
    header, ...sizes.map((size) => icons.get(size)),
  ]));
} finally {
  await browser.close();
}
