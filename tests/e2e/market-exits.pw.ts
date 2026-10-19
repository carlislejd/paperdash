import { expect, test, type Page } from "@playwright/test";
import type { AssetMarketResponse, MarketActivity, TradeEvent } from "../../packages/shared/src/types";
import { marketResponse, mockSources, WALLET } from "./fixtures";

const NOW = Date.UTC(2026, 9, 18, 18);

async function setup(page: Page) {
  await page.clock.install({ time: NOW });
  await page.clock.pauseAt(new Date(NOW));
  await mockSources(page);
  await page.route("**/api/assets/*/market*", async (route) => {
    const url = new URL(route.request().url());
    const instrument = Number(url.pathname.split("/")[3]);
    const activity = (url.searchParams.get("activity") ?? "all") as MarketActivity;
    const profitable = url.searchParams.get("segment") === "profitable";
    const price = instrument ? 2500 : 82000;
    const rows: TradeEvent[] = [
      { id: "entry", kind: "open", pnlUsd: null, priceUsd: price + 20, side: "long" },
      { id: "exit", kind: "close", pnlUsd: -120, priceUsd: price + 10, side: "long" },
      { id: "liquidation", kind: "liq", pnlUsd: null, priceUsd: price - 10, side: "short" },
      { id: "unpriced-exit", kind: "close", pnlUsd: 85, priceUsd: null, side: "short" },
    ].map((row, index) => ({
      ...row,
      id: `${row.id}-${instrument}`,
      ts: NOW - 60_000 - index * 90_000,
      wallet: WALLET,
      instrument,
      leverage: 10,
      notionalUsd: 50_000,
      provenance: "public-stream",
    })) as TradeEvent[];
    const trades = rows.filter((row) => activity === "all" || (activity === "entries" ? row.kind === "open" : row.kind !== "open"));
    const response: AssetMarketResponse = {
      ...marketResponse(instrument, false, NOW),
      activity,
      segment: profitable ? "profitable" : "all",
      trades,
      ...(profitable ? { segmentCoverage: {
        activity,
        basis: "positive-lifetime-realized-trading-pnl" as const,
        minPnlUsd: Number(url.searchParams.get("minPnl") ?? 0) as 0 | 1000 | 10000 | 100000,
        classifiedAt: NOW,
        maxAccountAgeMs: 300_000,
        observedWallets: 3,
        classifiedWallets: 2,
        profitableWallets: 1,
        unknownWallets: 1,
        oldestAccountReceivedAt: NOW - 60_000,
        newestAccountReceivedAt: NOW - 5_000,
      } } : {}),
    };
    await route.fulfill({ json: response });
  });
  await page.goto("/?view=assets&asset=0");
}

test("entry circles, exit diamonds and liquidation crosses share notional sizing and accessible inspection", async ({ page }) => {
  await setup(page);
  const panel = page.getByRole("region", { name: "BTC price and trades" });
  const chart = panel.getByRole("group", { name: "BTC reference price and execution markers" });
  await expect(chart.getByRole("button")).toHaveCount(3);
  const entry = chart.locator('[data-trade-kind="open"]');
  const exit = chart.locator('[data-trade-kind="close"]');
  const liquidation = chart.locator('[data-trade-kind="liq"]');
  await expect(entry.locator("circle.trade-graph-shape")).toHaveCount(1);
  await expect(exit.locator("path.trade-graph-shape")).toHaveCount(1);
  await expect(exit.locator(".trade-graph-liquidation-cross")).toHaveCount(0);
  await expect(liquidation.locator(".trade-graph-liquidation-cross")).toHaveCount(1);
  const circleRadius = Number(await entry.locator(".trade-graph-shape").getAttribute("r"));
  const diamondPoints = (await exit.locator(".trade-graph-shape").getAttribute("d"))!.match(/-?[\d.]+/g)!.map(Number);
  const halfDiagonal = Math.abs(diamondPoints[1]);
  expect(2 * halfDiagonal ** 2).toBeCloseTo(Math.PI * circleRadius ** 2);
  expect(Number(await liquidation.locator(".trade-graph-hit").getAttribute("r"))).toBeGreaterThanOrEqual(16);
  // An exit from a long position keeps its side color even when it loses money.
  expect(await exit.evaluate((element) => getComputedStyle(element).color)).toBe(await entry.evaluate((element) => getComputedStyle(element).color));
  await expect(exit).toHaveAccessibleName(/Closed BTC long.*exit price \$82,010\.00, realized P&L -\$120\.00/);
  await exit.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  const inspect = panel.locator(".trade-graph-inspect");
  await expect(inspect).toContainText("Exit price");
  await expect(inspect).toContainText("Realized P&L");
  await expect(inspect).toContainText("-$120.00");
  await expect(panel.locator('[data-trade-id="exit-0"]')).toHaveClass("is-active");
  await chart.press("Home");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(inspect).toContainText("Liquidated short");
  await expect(inspect).toContainText("Unavailable");
  await chart.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await panel.locator('[data-trade-id="unpriced-exit-0"]').getByRole("button", { name: /^Inspect/ }).click();
  await expect(inspect).toContainText("Unavailable");
  await expect(inspect).toContainText("+$85.00");
  await expect(panel.locator('[data-trade-id="unpriced-exit-0"]')).toContainText("Exit price unavailable");
  await panel.getByRole("button", { name: "Entries only", exact: true }).click();
  await expect(inspect).toContainText("Hover a marker to inspect");
  await expect(chart.getByRole("button")).toHaveCount(1);
  await chart.press("End");
  await expect(inspect).toContainText("Entry price");
  await expect(inspect).not.toContainText("Realized P&L");
  await panel.getByRole("button", { name: "Entries and exits", exact: true }).click();
  await expect(chart.getByRole("button")).toHaveCount(3);
  await liquidation.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await liquidation.press("Space");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel.getByLabel("Chart legend")).toContainText("Color = position side");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.mouse.move(0, 0);
  await panel.screenshot({ path: test.info().outputPath("entry-exit-markers.png") });
});

test("exit filters preserve trader controls across assets and report coverage for exiting wallets", async ({ page }) => {
  await setup(page);
  const panel = page.locator(".trade-graph");
  const exits = panel.getByRole("button", { name: "Exits and liquidations", exact: true });
  const profitable = panel.getByRole("button", { name: "Profitable traders", exact: true });
  await exits.click();
  await profitable.click();
  const minimum = panel.getByRole("combobox", { name: "Minimum realized profit" });
  await minimum.selectOption("10000");
  await panel.getByRole("button", { name: "1h", exact: true }).click();
  await expect(panel.locator("li[data-trade-id]")).toHaveCount(3);
  await expect(panel.locator('[data-trade-id="entry-0"]')).toHaveCount(0);
  await expect(panel.locator(".trade-graph-feed h4")).toContainText("Profitable trader exits");
  await expect(panel).toContainText("Exits include closes and liquidations");
  const coverage = panel.getByLabel("Trader profit coverage", { exact: true });
  await expect(coverage).toContainText("Exiting wallets · past hour · 66.7%");
  await expect(coverage).toContainText("1 unknown wallet excluded; more may qualify");
  await panel.getByRole("button", { name: "Pause chart", exact: true }).click();
  for (const name of ["Entries and exits", "Entries only", "Exits and liquidations", "All traders", "Profitable traders", "5m"])
    await expect(panel.getByRole("button", { name, exact: true })).toBeDisabled();
  await expect(minimum).toBeDisabled();
  await panel.getByRole("button", { name: "Resume live chart", exact: true }).click();
  for (const [asset, instrument] of [["ETH Ethereum", 1], ["BTC Bitcoin", 0]] as const) {
    await page.getByRole("button", { name: asset, exact: true }).click();
    await expect(exits).toHaveAttribute("aria-pressed", "true");
    await expect(profitable).toHaveAttribute("aria-pressed", "true");
    await expect(minimum).toHaveValue("10000");
    await expect(panel.getByRole("button", { name: "1h", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(panel.locator(`[data-trade-id="liquidation-${instrument}"]`)).toHaveCount(1);
    await expect(panel.locator(`[data-trade-id="liquidation-${1 - instrument}"]`)).toHaveCount(0);
  }
  await panel.getByRole("button", { name: "Entries only", exact: true }).click();
  await expect(coverage).toContainText("Opening wallets · past hour");
  await expect(panel.locator("li[data-trade-id]")).toHaveCount(1);
  await panel.getByRole("button", { name: "Entries and exits", exact: true }).click();
  await expect(coverage).toContainText("Trading wallets · past hour");
  await expect(panel.locator("li[data-trade-id]")).toHaveCount(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.mouse.move(0, 0);
  await panel.screenshot({ path: test.info().outputPath("profitable-entry-exit-coverage.png") });
});
