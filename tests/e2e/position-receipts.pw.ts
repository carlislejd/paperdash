import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { mockSources, walletResponse, WALLET } from "./fixtures";

const usd = (value: number) => (BigInt(value) * 10n ** 18n).toString();

function closed(at: number, pnl = 1250) {
  return {
    id: "retained-12",
    positionId: "12",
    instrumentId: 0,
    symbol: "BTC",
    priceScaleRaw: "10",
    isLong: true,
    kind: "PositionClosed",
    timestampMs: at - 30_000,
    openedAtMs: at - 90_000,
    entryPriceRaw: "800001",
    exitPriceRaw: "810001",
    marginRaw: usd(10_000_000_000),
    leverage: 1000,
    adjustedPnlRaw: usd(pnl),
    userPaidFeeRaw: usd(50),
    paperMintedRaw: "0",
    paperMintBasisRaw: "0",
    txHash: `0x${"b".repeat(64)}`,
  };
}

test("closed receipt freezes independently of polling, exports exact values and returns keyboard focus to its row", async ({
  page,
}) => {
  const at = Date.now();
  await page.clock.install({ time: at });
  await mockSources(page);
  let changed = false,
    reads = 0;
  const paths: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/")) paths.push(new URL(req.url()).pathname);
  });
  await page.addInitScript(() => {
    const original = CanvasRenderingContext2D.prototype.fillText;
    (window as unknown as { receiptText: string[] }).receiptText = [];
    CanvasRenderingContext2D.prototype.fillText = function (
      ...args: Parameters<typeof original>
    ) {
      (window as unknown as { receiptText: string[] }).receiptText.push(
        args[0],
      );
      return original.apply(this, args);
    };
  });
  await page.route(`**/api/wallets/${WALLET}`, (route) => {
    reads++;
    const wallet = walletResponse(WALLET, at);
    wallet.snapshot!.indexedThroughTimestamp = at / 1000;
    wallet.trades = {
      items: [closed(at, changed ? 9999 : 1250)],
      nextCursor: null,
      receivedAt: at,
      stale: false,
    };
    wallet.errors = ["Portfolio temporarily unavailable"];
    wallet.stale = true;
    return route.fulfill({ json: wallet });
  });
  await page.goto(`/?wallet=${WALLET}`);
  const wallet = page.getByRole("dialog", { name: /0x/ });
  await wallet.getByRole("tab", { name: /Closed trades/ }).click();
  const trigger = wallet.getByRole("button", { name: "View position 12 ↗" });
  await trigger.click();
  const receipt = page.getByRole("dialog", { name: "BTC Long" });
  await expect(receipt).toBeVisible();
  await expect(
    receipt.getByRole("region", { name: "Adjusted P&L" }),
  ).toContainText("1,250 USDC");
  await expect(receipt).toContainText("10,000,000,000,000 USD");
  await expect(receipt).not.toContainText("Last available");
  await expect(
    receipt.locator(".receipt-fields").getByText("Cash", { exact: true }),
  ).toHaveCount(0);
  await expect(
    receipt.getByRole("link", { name: "View outcome transaction ↗" }),
  ).toHaveAttribute("href", `https://hyperevmscan.io/tx/0x${"b".repeat(64)}`);
  const before = reads;
  changed = true;
  await page.clock.fastForward(16_000);
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(
    receipt.getByRole("region", { name: "Adjusted P&L" }),
  ).toContainText("1,250 USDC");
  await page.evaluate(() => {
    (window as unknown as { receiptText: string[] }).receiptText = [];
  });
  const downloadEvent = page.waitForEvent("download");
  await receipt.getByRole("button", { name: "Download PNG" }).click();
  const download = await downloadEvent;
  const png = await readFile((await download.path())!);
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  expect(png.readUInt32BE(16)).toBe(1200);
  await download.saveAs(
    `/tmp/paperclub-receipt-${test.info().project.name}.png`,
  );
  const labels = await page.evaluate(
    () => (window as unknown as { receiptText: string[] }).receiptText,
  );
  expect(labels).toContain("1,250 USDC");
  expect(labels).not.toContain("9,999 USDC");
  await receipt.evaluate((element) => {
    element.scrollTop = 0;
  });
  await receipt.screenshot({
    path: `/tmp/paperclub-receipt-dialog-${test.info().project.name}.png`,
  });
  expect(await receipt.evaluate((e) => e.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  await page.keyboard.press("Escape");
  await expect(receipt).toHaveCount(0);
  await expect(wallet).toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(
    page
      .getByRole("dialog", { name: "BTC Long" })
      .getByRole("region", { name: "Adjusted P&L" }),
  ).toContainText("9,999 USDC");
  expect(
    paths.filter((p) => p.includes("receipt") || p.includes("/positions/")),
  ).toEqual([]);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("open details share the snapshot age, queued funding and missing-price state; wallet link sharing has no fake receipt URL", async ({
  page,
}) => {
  const at = Date.now();
  await page.clock.install({ time: at });
  await mockSources(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw Error("unavailable");
        },
      },
    });
  });
  await page.route(`**/api/wallets/${WALLET}`, (route) => {
    const wallet = walletResponse(WALLET, at);
    wallet.snapshot!.indexedThroughTimestamp = (at - 60_000) / 1000;
    wallet.snapshot!.openPositions = [
      [
        "15",
        99,
        false,
        true,
        "123",
        usd(10_000_000_000),
        1000,
        "111",
        at - 120_000,
        null,
      ],
      ["malformed"],
    ];
    return route.fulfill({ json: wallet });
  });
  await page.goto(
    `/?view=assets&wallet=${WALLET}&chart=not-real&q=private#history`,
  );
  const wallet = page.getByRole("dialog", { name: /0x/ });
  const open = wallet.getByRole("region", { name: "Current open positions" });
  await expect(open.getByRole("listitem")).toHaveCount(2);
  await expect(
    open.getByRole("button", { name: "Position details unavailable" }),
  ).toBeDisabled();
  await expect(
    open.getByRole("button", { name: "View market short position 15" }),
  ).toContainText("1m");
  await open
    .getByRole("button", { name: "View market short position 15" })
    .click();
  const receipt = page.getByRole("dialog", { name: "Market 99 Short" });
  await expect(receipt).toContainText("Queued balance");
  await expect(receipt).toContainText("Last available");
  await expect(
    receipt
      .locator(".receipt-fields > div")
      .filter({ has: page.getByText("Entry price", { exact: true }) }),
  ).toContainText("—");
  await expect(
    receipt
      .locator(".receipt-fields > div")
      .filter({ has: page.getByText("Age at snapshot", { exact: true }) }),
  ).toContainText("1m");
  await receipt.getByRole("button", { name: "Share", exact: true }).click();
  await expect(
    receipt.getByRole("textbox", { name: "Wallet link" }),
  ).toHaveValue(`http://127.0.0.1:4173/?wallet=${WALLET}`);
  await expect(receipt.getByRole("link", { name: /transaction/ })).toHaveCount(
    0,
  );
  await receipt.getByText("Exact values", { exact: true }).click();
  await expect(receipt.locator(".receipt-exact")).toContainText(
    "10,000,000,000,000 USD",
  );
  expect(await receipt.evaluate((e) => e.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  await receipt.getByRole("button", { name: "Close position receipt" }).click();
  await expect(wallet).toBeVisible();
});

test("older loaded outcomes retain their own check clock and ambiguous coverage after head refresh", async ({
  page,
}) => {
  const at = Date.now();
  await page.clock.install({ time: at });
  await mockSources(page);
  let reads = 0;
  await page.route(`**/api/wallets/${WALLET}`, (route) => {
    reads++;
    const wallet = walletResponse(WALLET, at - 7_200_000);
    wallet.snapshot!.indexedThroughTimestamp = (at - 7_200_000) / 1000;
    wallet.trades = {
      items: [closed(at - 7_200_000)],
      nextCursor: "page-two",
      receivedAt: at - 7_200_000,
      stale: true,
    };
    return route.fulfill({ json: wallet });
  });
  await page.route(`**/api/wallets/${WALLET}/trades?cursor=page-two`, (route) =>
    route.fulfill({
      json: {
        items: [
          { ...closed(at - 60_000), id: "retained-13", positionId: "13" },
        ],
        nextCursor: null,
        receivedAt: at,
        stale: false,
        coverage: {
          source: "retained-api-observations",
          retainedCount: 2,
          indexing: false,
          backfillComplete: true,
          sourceComplete: false,
          identityAmbiguous: true,
          lastIndexedAt: at,
        },
      },
    }),
  );
  await page.goto(`/?wallet=${WALLET}`);
  const wallet = page.getByRole("dialog", { name: /0x/ });
  await wallet.getByRole("tab", { name: /Closed trades/ }).click();
  await wallet.getByRole("button", { name: "Load older activity" }).click();
  await expect(
    wallet.getByRole("button", { name: "View position 13 ↗" }),
  ).toBeVisible();
  const before = reads;
  await page.clock.fastForward(16_000);
  await expect.poll(() => reads).toBeGreaterThan(before);
  await wallet.getByRole("button", { name: "View position 13 ↗" }).click();
  const receipt = page.getByRole("dialog", { name: "BTC Long" });
  await expect(receipt).toContainText(
    `History checked · ${new Date(at).toISOString().replace("T", " ").replace(".000Z", " UTC").replace("Z", " UTC")}`,
  );
  await expect(
    receipt
      .locator(".receipt-fields > div")
      .filter({ has: page.getByText("Held", { exact: true }) }),
  ).toContainText("1m");
  await expect(receipt).not.toContainText("Last available");
  await receipt.locator(".receipt-warnings summary").click();
  await expect(receipt).toContainText(
    "Retained history has ambiguous observation identity.",
  );
});
