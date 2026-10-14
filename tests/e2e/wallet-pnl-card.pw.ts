import { expect, test, type Page, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  mockSources,
  positionMetricsResponse,
  walletResponse,
  WALLET,
} from "./fixtures";

const raw = (value: number) => (BigInt(value) * 10n ** 18n).toString();
type CardCanvasDiagnostic = {
  id: number;
  width: number;
  height: number;
  textCalls: number;
  blobCalls: number;
  blobCallbacks: number;
  blobBytes: number | null;
};
type CardDiagnosticWindow = Window & {
  cardText: string[];
  cardCanvases: CardCanvasDiagnostic[];
  cardFontLoads: { font: string; state: string; documentReady: string }[];
};
async function setup(
  page: Page,
  options: { missing?: boolean; large?: boolean } = {},
) {
  const at = Math.floor(Date.now() / 1000) * 1000;
  await page.clock.install({ time: at });
  await page.clock.pauseAt(at);
  await mockSources(page);
  const state = { changed: false, walletReads: 0, metricReads: 0 };
  await page.addInitScript(() => {
    const target = window as CardDiagnosticWindow;
    target.cardText = [];
    target.cardCanvases = [];
    target.cardFontLoads = [];
    const canvases = new WeakMap<HTMLCanvasElement, CardCanvasDiagnostic>();
    const record = (canvas: HTMLCanvasElement) => {
      let value = canvases.get(canvas);
      if (!value) {
        value = {
          id: target.cardCanvases.length + 1,
          width: canvas.width,
          height: canvas.height,
          textCalls: 0,
          blobCalls: 0,
          blobCallbacks: 0,
          blobBytes: null,
        };
        canvases.set(canvas, value);
        target.cardCanvases.push(value);
      }
      return value;
    };
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (
      ...args: Parameters<typeof original>
    ) {
      target.cardText.push(args[0]);
      if (this.canvas instanceof HTMLCanvasElement)
        record(this.canvas).textCalls++;
      return original.apply(this, args);
    };
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      const value = record(this);
      value.blobCalls++;
      return toBlob.call(
        this,
        (blob) => {
          value.blobCallbacks++;
          value.blobBytes = blob?.size ?? null;
          callback(blob);
        },
        ...args,
      );
    };
    const loadFont = document.fonts.load.bind(document.fonts);
    document.fonts.load = (font, text) => {
      const value = { font, state: "pending", documentReady: "pending" };
      target.cardFontLoads.push(value);
      const result = loadFont(font, text);
      void document.fonts.ready.then(() => {
        value.documentReady = "resolved";
      });
      void result.then(
        () => {
          value.state = "resolved";
        },
        () => {
          value.state = "rejected";
        },
      );
      return result;
    };
  });
  await page.route(`**/api/wallets/${WALLET}`, (route) => {
    state.walletReads++;
    const wallet = walletResponse(WALLET, at);
    wallet.snapshot!.indexedThroughTimestamp = at / 1000;
    wallet.accountFreshness = {
      sourceAt: at,
      receivedAt: at,
      stale: false,
      refreshing: false,
    };
    wallet.snapshot!.lifetime.realizedPnlRaw = raw(state.changed ? 9999 : 1250);
    wallet.snapshot!.paper = { balance: raw(154000), staked: raw(6000000) };
    if (options.large) {
      wallet.snapshot!.lifetime.realizedPnlRaw = raw(-10_000_000_000);
      wallet.snapshot!.paper = {
        balance: raw(40_000_000_000),
        staked: raw(50_000_000_000),
      };
    }
    if (options.missing) wallet.snapshot = null;
    return route.fulfill({ json: wallet });
  });
  await page.route(`**/api/wallets/${WALLET}/position-metrics`, (route) => {
    state.metricReads++;
    const metrics = positionMetricsResponse();
    metrics.positionCount = 40;
    metrics.avgHoldMs = 5_400_000;
    metrics.avgLeverage = 555;
    metrics.updatedAt = at;
    metrics.coverage.historyBackfillComplete = true;
    metrics.highlights = {
      bestTrade: {
        pnlRaw: raw(state.changed ? 9999 : 3200),
        symbol: "BTC",
        positionId: "123",
      },
      worstTrade: { pnlRaw: raw(-1800), symbol: "ETH", positionId: "124" },
      tradeCount: 42,
      excludedCount: 0,
      complete: true,
    };
    if (options.missing) {
      metrics.positionCount = 0;
      metrics.avgHoldMs = null;
      metrics.avgLeverage = null;
      delete metrics.highlights;
    }
    return route.fulfill({ json: metrics });
  });
  await page.goto("/?view=wallets");
  await page.getByRole("button", { name: /^Aoi / }).click();
  await expect(
    page.getByRole("region", { name: "Wallet position averages" }),
  ).toContainText(`Closed positions ${options.missing ? 0 : 40}`);
  await expect(
    page.getByRole("button", { name: "Share P&L card ↗" }),
  ).toBeVisible();
  return state;
}
async function openCard(page: Page) {
  await page.getByRole("button", { name: "Share P&L card ↗" }).click();
  return page.getByRole("dialog", { name: "Your P&L card" });
}
async function previewHash(dialog: Locator) {
  return dialog
    .locator(".pnl-preview img")
    .evaluate(async (image: HTMLImageElement) => {
      const buffer = await (await fetch(image.src)).arrayBuffer();
      return Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)),
        (value) => value.toString(16).padStart(2, "0"),
      ).join("");
    });
}

async function withPreviewDiagnostic(page: Page, check: () => Promise<void>) {
  try {
    await check();
  } catch (cause) {
    const diagnostic = await page.evaluate(() => {
      const target = window as CardDiagnosticWindow;
      return {
        preview: document.querySelector(".pnl-preview")?.textContent?.trim(),
        fontStatus: document.fonts.status,
        fontReady: document.fonts.check('600 36px "DM Sans"'),
        fontLoads: target.cardFontLoads,
        canvases: target.cardCanvases,
        resources: performance
          .getEntriesByType("resource")
          .filter((entry) =>
            /dm-sans|paperclub-social|wallet-pnl-card-export/.test(entry.name),
          )
          .map((entry) => ({
            path: new URL(entry.name).pathname,
            duration: Math.round(entry.duration),
            bytes: (entry as PerformanceResourceTiming).decodedBodySize,
          })),
      };
    });
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `${message}\nP&L preview diagnostic: ${JSON.stringify(diagnostic)}`,
    );
  }
}

async function expectPreviewReady(page: Page, button: Locator) {
  // Covers the renderer's 12s deadline and Chromium's native idle PNG fallback.
  await withPreviewDiagnostic(page, () =>
    expect(button).toBeEnabled({ timeout: 15_000 }),
  );
}

async function waitForSharePreview(page: Page, dialog: Locator) {
  // These tests pause the browser clock to freeze the source observations.
  // Privacy changes can overlap the initial font/image load and PNG render;
  // let browser frames settle while waiting for the regenerated preview.
  // Keep advancement below both asset deadlines and the next data poll.
  let advanced = 0;
  await withPreviewDiagnostic(page, () =>
    expect
      .poll(
        async () => {
          if (advanced < 2000) {
            await page.clock.runFor(50);
            advanced += 50;
          }
          return dialog
            .getByRole("button", { name: "Share card ↗" })
            .isEnabled();
        },
        { timeout: 15_000 },
      )
      .toBe(true),
  );
}

test("all three card layouts export exactly the preview with hidden identity and no extra data reads", async ({
  page,
}) => {
  const state = await setup(page);
  const before = { ...state };
  const dialog = await openCard(page);
  await expect(
    dialog.getByRole("checkbox", { name: /Hide wallet/ }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("button", { name: /^Spotlight/ }),
  ).toHaveAttribute("aria-pressed", "true");
  for (const layout of [
    { id: "gallery", name: "Gallery", width: 1200, height: 900 },
    { id: "split", name: "Spotlight", width: 1200, height: 675 },
    { id: "portrait", name: "Portrait", width: 1080, height: 1350 },
  ]) {
    await dialog
      .getByRole("button", { name: new RegExp(`^${layout.name}`) })
      .click();
    const downloadButton = dialog.getByRole("button", { name: "Download PNG" });
    await expectPreviewReady(page, downloadButton);
    await expect(dialog.locator(".pnl-preview img")).toHaveAttribute(
      "alt",
      "WALLET HIDDEN · +$1,250.00 lifetime realized P&L · 6,154,000.00 PAPER owned",
    );
    const expectedHash = await previewHash(dialog);
    const event = page.waitForEvent("download");
    await downloadButton.click();
    const download = await event;
    const bytes = await readFile((await download.path())!);
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect(bytes.readUInt32BE(16)).toBe(layout.width);
    expect(bytes.readUInt32BE(20)).toBe(layout.height);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(expectedHash);
    expect(download.suggestedFilename()).toBe(`paperclub-pnl-${layout.id}.png`);
    await download.saveAs(
      `/tmp/paperclub-pnl-test-${layout.id}-${test.info().project.name}.png`,
    );
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  }
  const labels = await page.evaluate(
    () => (window as unknown as { cardText: string[] }).cardText,
  );
  expect(labels.join(" ")).not.toContain("Aoi");
  expect(labels.join(" ")).not.toContain(WALLET);
  expect(labels).toContain("Recorded closed trades");
  expect(labels).toContain("42");
  expect(labels).toContain("1h 30m");
  expect(state.metricReads).toBe(before.metricReads);
  expect(state.walletReads).toBe(before.walletReads);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Share P&L card ↗" }),
  ).toBeFocused();
  await expect(page.locator(".wd-drawer")).toBeVisible();
});

test("hiding a wallet invalidates an unredacted native-share retry and all share metadata", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const target = window as unknown as {
      cardShares: Record<string, string>[];
    };
    target.cardShares = [];
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: () => true,
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data: ShareData) => {
        const file = data.files![0];
        const hash = Array.from(
          new Uint8Array(
            await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
          ),
          (value) => value.toString(16).padStart(2, "0"),
        ).join("");
        target.cardShares.push({
          title: data.title!,
          text: data.text!,
          url: data.url!,
          filename: file.name,
          hash,
        });
        if (target.cardShares.length === 1)
          throw new DOMException("Second gesture required", "NotAllowedError");
      },
    });
  });
  await setup(page);
  const dialog = await openCard(page);
  const privacy = dialog.getByRole("checkbox", { name: /Hide wallet/ });
  await privacy.uncheck();
  const share = dialog.getByRole("button", { name: "Share card ↗" });
  await waitForSharePreview(page, dialog);
  await expect(dialog.locator(".pnl-preview img")).toHaveAttribute(
    "alt",
    /^Aoi ·/,
  );
  await share.click();
  await expect(dialog.locator(".pnl-action-status")).toContainText(
    "Image ready. Tap Share again",
  );
  await privacy.check();
  await waitForSharePreview(page, dialog);
  const hiddenHash = await previewHash(dialog);
  await share.click();
  await expect(dialog.locator(".pnl-action-status")).toContainText(
    "P&L card shared",
  );
  const shares = await page.evaluate(
    () =>
      (window as unknown as { cardShares: Record<string, string>[] })
        .cardShares,
  );
  expect(shares).toHaveLength(2);
  expect(shares[0].url).toBe(`https://papertrade.club/?wallet=${WALLET}`);
  expect(shares[1].url).toBe("https://papertrade.club/");
  expect(shares[1].hash).toBe(hiddenHash);
  expect(shares[1].hash).not.toBe(shares[0].hash);
  expect(JSON.stringify(shares[1])).not.toContain(WALLET);
  expect(JSON.stringify(shares[1])).not.toContain("Aoi");
});

test("copy fallback strips identity and private URL state after privacy changes", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Unavailable");
        },
      },
    });
  });
  await setup(page);
  await page.evaluate(() =>
    history.replaceState(
      null,
      "",
      `${location.pathname}?view=wallets&wallet=${"0x" + "11".repeat(20)}&q=private#private`,
    ),
  );
  const dialog = await openCard(page);
  const privacy = dialog.getByRole("checkbox", { name: /Hide wallet/ });
  await privacy.uncheck();
  await dialog.getByRole("button", { name: "Copy wallet link" }).click();
  await expect(dialog.getByRole("textbox", { name: "Share link" })).toHaveValue(
    `https://papertrade.club/?wallet=${WALLET}`,
  );
  await privacy.check();
  await expect(dialog.getByRole("textbox", { name: "Share link" })).toHaveCount(
    0,
  );
  await waitForSharePreview(page, dialog);
  await dialog.getByRole("button", { name: "Share card ↗" }).click();
  await expect(dialog.getByRole("textbox", { name: "Share link" })).toHaveValue(
    "https://papertrade.club/",
  );
});

test("stalled artwork can retry without changing frozen data, privacy or layout", async ({
  page,
}) => {
  let releaseArt: (() => void) | undefined;
  let artRequests = 0;
  await page.route("**/art/paperclub-social-v4.png", async (route) => {
    artRequests++;
    if (artRequests === 1)
      await new Promise<void>((resolve) => {
        releaseArt = resolve;
      });
    await route.continue();
  });
  const state = await setup(page);
  const dialog = await openCard(page);
  await expect(dialog.getByText("Preparing your card…")).toBeVisible();
  await expect.poll(() => Boolean(releaseArt)).toBe(true);
  await dialog.getByRole("checkbox", { name: /Hide wallet/ }).uncheck();
  await dialog.getByRole("button", { name: /^Portrait/ }).click();
  await dialog.getByRole("checkbox", { name: /Hide wallet/ }).check();
  const before = state.walletReads;
  state.changed = true;
  await page.clock.runFor(16_100);
  await expect.poll(() => state.walletReads).toBeGreaterThan(before);
  await expect(dialog.getByRole("alert")).toContainText(
    "The card artwork could not load. Try again.",
  );
  await expect(
    dialog.getByRole("button", { name: "Download PNG" }),
  ).toBeDisabled();
  await expect(dialog.locator(".pnl-preview img")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      (window as CardDiagnosticWindow).cardCanvases.reduce(
        (total, canvas) => total + canvas.blobCalls,
        0,
      ),
    ),
  ).toBe(0);
  releaseArt!();
  await dialog.getByRole("button", { name: "Try again", exact: true }).click();
  await expect.poll(() => artRequests).toBe(2);
  await expectPreviewReady(
    page,
    dialog.getByRole("button", { name: "Download PNG" }),
  );
  await expect(dialog.locator(".pnl-preview img")).toHaveAttribute(
    "width",
    "1080",
  );
  await expect(dialog.locator(".pnl-preview img")).toHaveAttribute(
    "height",
    "1350",
  );
  await expect(dialog.locator(".pnl-preview img")).toHaveAttribute(
    "alt",
    "WALLET HIDDEN · +$1,250.00 lifetime realized P&L · 6,154,000.00 PAPER owned",
  );
  await expect(dialog.locator(".pnl-accessible-summary")).toContainText(
    "+$3,200.00",
  );
  await expect(dialog.locator(".pnl-accessible-summary")).not.toContainText(
    "9,999",
  );
  expect(
    await page.evaluate(() =>
      (window as CardDiagnosticWindow).cardCanvases.reduce(
        (total, canvas) => total + canvas.blobCalls,
        0,
      ),
    ),
  ).toBe(1);
  await page.keyboard.press("Escape");
  await openCard(page);
  await expectPreviewReady(
    page,
    dialog.getByRole("button", { name: "Download PNG" }),
  );
  await expect(dialog.locator(".pnl-preview img")).toHaveAttribute(
    "alt",
    /\+\$9,999\.00 lifetime/,
  );
});

test("stalled PNG encoding times out and a late callback cannot replace a retry", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const target = window as Window & {
      releaseCardEncoding?: () => Promise<void>;
    };
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    let stalled = false;
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      if (stalled) return toBlob.call(this, callback, ...args);
      stalled = true;
      target.releaseCardEncoding = () =>
        new Promise<void>((resolve) => {
          toBlob.call(
            this,
            (blob) => {
              callback(blob);
              resolve();
            },
            ...args,
          );
        });
    };
  });
  const dialog = await openCard(page);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window as Window & { releaseCardEncoding?: unknown })
            .releaseCardEncoding,
        ),
      ),
    )
    .toBe(true);
  await page.clock.runFor(12_100);
  await expect(dialog.getByRole("alert")).toContainText(/Try again/);
  await expect(
    dialog.getByRole("button", { name: "Download PNG" }),
  ).toBeDisabled();
  await expect(dialog.locator(".pnl-preview img")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Try again", exact: true }).click();
  await expectPreviewReady(
    page,
    dialog.getByRole("button", { name: "Download PNG" }),
  );
  const currentUrl = await dialog
    .locator(".pnl-preview img")
    .getAttribute("src");
  const currentHash = await previewHash(dialog);
  await page.evaluate(() =>
    (
      window as Window & { releaseCardEncoding: () => Promise<void> }
    ).releaseCardEncoding(),
  );
  await expect(dialog.locator(".pnl-preview img")).toHaveAttribute(
    "src",
    currentUrl!,
  );
  expect(await previewHash(dialog)).toBe(currentHash);
  await expect(dialog.locator(".pnl-preview img")).toHaveAttribute(
    "alt",
    "WALLET HIDDEN · +$1,250.00 lifetime realized P&L · 6,154,000.00 PAPER owned",
  );
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});

test("an unavailable account and legacy highlights stay unknown on the rendered card", async ({
  page,
}) => {
  await setup(page, { missing: true });
  const dialog = await openCard(page);
  await expectPreviewReady(
    page,
    dialog.getByRole("button", { name: "Download PNG" }),
  );
  await expect(dialog.locator(".pnl-preview img")).toHaveAttribute(
    "alt",
    "WALLET HIDDEN · — lifetime realized P&L · — PAPER owned",
  );
  await expect(dialog.locator(".pnl-accessible-summary dd")).toHaveText(
    Array(8).fill("—"),
  );
  const labels = await page.evaluate(
    () => (window as unknown as { cardText: string[] }).cardText,
  );
  expect(labels).not.toContain("$0.00");
  expect(labels).not.toContain("0.00");
});

test("large negative P&L and PAPER totals remain exact in the compact export", async ({
  page,
}) => {
  await setup(page, { large: true });
  const dialog = await openCard(page);
  await dialog.getByRole("button", { name: /^Spotlight/ }).click();
  await expectPreviewReady(
    page,
    dialog.getByRole("button", { name: "Download PNG" }),
  );
  await expect(dialog.locator(".pnl-preview img")).toHaveAttribute(
    "alt",
    "WALLET HIDDEN · −$10,000,000,000.00 lifetime realized P&L · 90,000,000,000.00 PAPER owned",
  );
  const labels = await page.evaluate(
    () => (window as unknown as { cardText: string[] }).cardText,
  );
  expect(labels).toContain("−$10,000,000,000.00");
  expect(labels).toContain("90,000,000,000.00");
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  const event = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download PNG" }).click();
  await (
    await event
  ).saveAs(`/tmp/paperclub-pnl-test-large-${test.info().project.name}.png`);
});
