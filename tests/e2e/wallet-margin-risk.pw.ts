import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  buildWalletMarginRisk,
  referencePriceRaw,
} from "../../packages/shared/src/margin-risk";
import { mockSources, walletResponse, WALLET } from "./fixtures";

const raw = (value: number) => (BigInt(value) * 10n ** 18n).toString();
function riskWallet(at: number, margin = 1000) {
  const wallet = walletResponse(WALLET, at);
  wallet.snapshot!.indexedThroughTimestamp = at / 1000;
  wallet.snapshot!.openPositions = [
    ["1", 0, true, false, "810000", raw(margin), 100, "799600", at - 60000],
    ["2", 0, false, true, "790000", raw(2000), 100, "800800", at - 60000],
    ["3", 0, true, false, "810000", raw(3000), 10, "780000", at - 60000],
    ["4", 1, true, false, "250100", raw(50), 1000, "249900", at - 60000],
    ["5", 0, true, false, "810000", raw(500), 1000, "800100", at - 60000],
    ["6", 77, true, false, "810000", raw(600), 100, "799600", at - 60000],
  ];
  wallet.marginRisk = buildWalletMarginRisk(wallet.snapshot, {
    address: WALLET,
    asOf: at,
    snapshotReceivedAt: at,
    snapshotStale: false,
    references: [80000, 2500].map((price, instrumentId) => ({
      instrumentId,
      symbol: instrumentId === 0 ? "BTC" : "ETH",
      priceUsd: price,
      priceRaw: referencePriceRaw(price)!,
      sourceAt: at,
      receivedAt: at,
      stale: false,
      source: "hyperliquid-bbo-mid",
    })),
  });
  return wallet;
}

test("wallet margin shows nonoverlapping cash and queued bands, switches assets and opens existing receipts", async ({
  page,
}) => {
  const at = Math.floor(Date.now() / 1000) * 1000;
  await mockSources(page);
  const paths: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/")) paths.push(path);
  });
  await page.route(`**/api/wallets/${WALLET}`, (route) =>
    route.fulfill({ json: riskWallet(at) }),
  );
  await page.goto(`/?wallet=${WALLET}`);
  const panel = page.getByRole("region", { name: "Wallet margin at risk" });
  await expect(panel.locator(".wmr-totals dd")).toHaveText([
    "$6.5K",
    "$4.5K",
    "$2K",
  ]);
  await expect(panel.getByRole("listitem")).toHaveCount(7);
  await expect(panel).toContainText("Hyperliquid midpoint $80,000.00");
  await expect(panel).toContainText("5 included · 1 excluded");
  const near = panel.getByRole("listitem").nth(1);
  await expect(near).toHaveAttribute(
    "aria-label",
    /long \$1,000.00, cash \$1,000.00, queued balance \$0.00; short \$2,000.00, cash \$0.00, queued balance \$2,000.00/,
  );
  await near.focus();
  await expect(near).toBeFocused();
  await panel.getByRole("button", { name: "ETH", exact: true }).click();
  await expect(panel.locator(".wmr-totals dd")).toHaveText([
    "$50",
    "$50",
    "$0",
  ]);
  await panel.getByRole("button", { name: "BTC", exact: true }).click();
  const trigger = panel.getByRole("button", {
    name: "View BTC long position 1 from margin view",
  });
  await trigger.click();
  const receipt = page.getByRole("dialog", { name: "BTC Long", exact: true });
  await expect(receipt).toBeVisible();
  await expect(receipt).toContainText("79,960.00 USD");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  expect(paths.some((path) => /\/assets|margin-risk/.test(path))).toBe(false);
  expect(
    await page
      .locator(".wd-drawer")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.setViewportSize({
    width: page.viewportSize()!.width,
    height: 1400,
  });
  await panel.evaluate((element) => {
    const drawer = element.closest(".wd-drawer")!;
    drawer.scrollTop +=
      element.getBoundingClientRect().top -
      drawer.getBoundingClientRect().top -
      80;
  });
  await panel.screenshot({
    path: `/tmp/paperclub-margin-risk-${test.info().project.name}.png`,
  });
});

test("wallet margin defaults to an available asset and ages the snapshot receipt independently", async ({
  page,
}) => {
  const at = Math.floor(Date.now() / 1000) * 1000;
  await page.clock.install({ time: at });
  await mockSources(page);
  await page.route(`**/api/wallets/${WALLET}`, (route) => {
    const wallet = riskWallet(at);
    wallet.snapshot!.openPositions = [wallet.snapshot!.openPositions[3]];
    wallet.marginRisk = buildWalletMarginRisk(wallet.snapshot, {
      address: WALLET,
      asOf: at,
      snapshotReceivedAt: at - 25000,
      snapshotStale: false,
      references: wallet.marginRisk!.references,
    });
    return route.fulfill({ json: wallet });
  });
  await page.goto(`/?wallet=${WALLET}`);
  const panel = page.getByRole("region", { name: "Wallet margin at risk" });
  await expect(
    panel.getByRole("button", { name: "ETH", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(panel.locator(".wmr-totals dd").first()).toHaveText("$50");
  await expect(panel.locator(".wmr-clock")).toContainText("At snapshot");
  await page.clock.fastForward(6000);
  await expect(panel.locator(".wmr-clock")).toContainText("Last available");
  await panel.getByRole("button", { name: "BTC", exact: true }).click();
  await expect(panel).toContainText("No BTC open positions in this snapshot");
});

test("wallet margin preserves a matching newer snapshot and freezes PNG context across refresh", async ({
  page,
}) => {
  const at = Math.floor(Date.now() / 1000) * 1000;
  await page.clock.install({ time: at });
  await mockSources(page);
  await page.addInitScript(() => {
    const root = window as unknown as {
      marginText: string[];
      releaseMargin: () => void;
    };
    root.marginText = [];
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (
      ...args: Parameters<typeof fill>
    ) {
      root.marginText.push(args[0]);
      return fill.apply(this, args);
    };
    Object.defineProperty(document.fonts, "ready", {
      configurable: true,
      value: new Promise<void>((resolve) => {
        root.releaseMargin = resolve;
      }),
    });
  });
  let revision = 3,
    reads = 0,
    regressBlock = false;
  await page.route(`**/api/wallets/${WALLET}`, (route) => {
    reads++;
    const wallet = riskWallet(at, revision === 3 ? 1000 : 9000);
    wallet.snapshot!.accountRevision = revision;
    wallet.marginRisk!.snapshot!.accountRevision = revision;
    if (regressBlock) {
      wallet.snapshot!.indexedThroughBlock--;
      wallet.marginRisk!.snapshot!.indexedThroughBlock--;
    }
    return route.fulfill({ json: wallet });
  });
  await page.goto(`/?wallet=${WALLET}`);
  const panel = page.getByRole("region", { name: "Wallet margin at risk" });
  await expect(panel.locator(".wmr-totals dd").first()).toHaveText("$6.5K");
  const downloadEvent = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download PNG" }).click();
  const before = reads;
  revision = 2;
  await page.clock.fastForward(16000);
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(panel.locator(".wmr-totals dd").first()).toHaveText("$6.5K");
  await expect(panel).toContainText("Last available");
  revision = 4;
  regressBlock = true;
  await page.clock.fastForward(16000);
  await expect(panel.locator(".wmr-totals dd").first()).toHaveText("$6.5K");
  regressBlock = false;
  await page.clock.fastForward(16000);
  await expect(panel.locator(".wmr-totals dd").first()).toHaveText("$14.5K");
  await page.evaluate(() =>
    (window as unknown as { releaseMargin: () => void }).releaseMargin(),
  );
  const download = await downloadEvent;
  const bytes = await readFile((await download.path())!);
  expect(bytes.subarray(1, 4).toString()).toBe("PNG");
  expect(bytes.readUInt32BE(16)).toBe(1600);
  await download.saveAs(
    `/tmp/paperclub-margin-risk-export-${test.info().project.name}.png`,
  );
  const text = await page.evaluate(
    () => (window as unknown as { marginText: string[] }).marginText,
  );
  expect(text).toContain("$6.5K USDC");
  expect(text).not.toContain("$14.5K USDC");
  expect(text.some((line) => line.startsWith("Wallet snapshot:"))).toBe(true);
  expect(text.some((line) => line.startsWith("Reference:"))).toBe(true);
});

test("wallet margin distinguishes stale references, missing bands, legacy response and no positions", async ({
  page,
}) => {
  const at = Math.floor(Date.now() / 1000) * 1000;
  await mockSources(page);
  let state: "stale" | "reference" | "legacy" | "excluded" | "zero" = "stale";
  await page.route(`**/api/wallets/${WALLET}`, (route) => {
    const wallet = riskWallet(at);
    if (state === "stale") {
      wallet.marginRisk!.stale = true;
      wallet.marginRisk!.assets[0].reference!.stale = true;
    }
    if (state === "reference") {
      wallet.marginRisk!.assets[0].reference = null;
      wallet.marginRisk!.assets[0].bands = null;
      wallet.marginRisk!.assets[0].nearest = [];
    }
    if (state === "legacy") delete wallet.marginRisk;
    if (state === "excluded") {
      wallet.snapshot!.openPositions = [wallet.snapshot!.openPositions[5]];
      wallet.marginRisk = buildWalletMarginRisk(wallet.snapshot, {
        address: WALLET,
        asOf: at,
        snapshotReceivedAt: at,
        snapshotStale: false,
        references: [],
      });
    }
    if (state === "zero") {
      wallet.snapshot!.openPositions = [];
      wallet.marginRisk = buildWalletMarginRisk(wallet.snapshot, {
        address: WALLET,
        asOf: at,
        snapshotReceivedAt: at,
        snapshotStale: false,
        references: [],
      });
    }
    return route.fulfill({ json: wallet });
  });
  await page.goto(`/?wallet=${WALLET}`);
  const panel = page.getByRole("region", { name: "Wallet margin at risk" });
  await expect(panel).toContainText("Last available reference");
  await expect(panel.getByRole("listitem")).toHaveCount(7);
  state = "reference";
  await page.reload();
  await expect(panel).toContainText("Price reference unavailable");
  await expect(panel.locator(".wmr-totals dd").first()).toHaveText("$6.5K");
  await expect(panel.getByRole("listitem")).toHaveCount(0);
  state = "legacy";
  await page.reload();
  await expect(panel).toContainText(
    "Margin view unavailable for this snapshot",
  );
  await expect(panel.locator(".wmr-totals")).toHaveCount(0);
  state = "excluded";
  await page.reload();
  await expect(panel).toContainText("No usable BTC positions in this snapshot");
  await expect(panel).not.toContainText("Initial margin $0");
  state = "zero";
  await page.reload();
  await expect(panel).toContainText(
    "No BTC open positions in this snapshot. Initial margin $0.",
  );
  await expect(panel).toContainText("0 included · 0 excluded");
});
