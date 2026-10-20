import { expect, test, type Page } from "@playwright/test";
import type { PaperPriceQuote } from "../../packages/shared/src/types";
import { account, mockSources, paperEconomicsResponse, WALLET } from "./fixtures";

const at = Date.UTC(2026, 9, 19, 5);
const key = "paperclub:paragon-estimates:v1";
const quote: PaperPriceQuote = {
  source: "hyperliquid", market: "para:PAPER", basis: "perp-mid",
  priceUsdRaw: "24700000000000000", bidUsdRaw: "24600000000000000", askUsdRaw: "24800000000000000",
  sourceAt: at, receivedAt: at,
};

async function prepare(page: Page) {
  await page.clock.install({ time: at });
  await page.clock.pauseAt(new Date(at));
  await page.addInitScript(() => { Math.random = () => 0; });
  await mockSources(page);
  const requests: string[] = [];
  page.on("request", request => requests.push(new URL(request.url()).pathname));
  await page.route("**/api/paper/economics", route => route.fulfill({
    json: { ...paperEconomicsResponse(at), paperPrice: quote },
  }));
  await page.route("**/api/accounts?**", route => route.fulfill({ json: {
    accounts: [{ ...account(WALLET, "Aoi"), paperTotal: "1000000000000000000000", realizedPnl: "-100000000000000000000" }],
    count: 2, pageInfo: { page: Number(new URL(route.request().url()).searchParams.get("page") ?? 0), totalPages: 2 },
    summary: { uniqueAccounts: 2, trackedBalance: "0", trackedQueued: "0", trackedOpenNotional: "0", trackedPaper: "1000000000000000000000" },
    receivedAt: at, stale: false,
  } }));
  return requests;
}

test("a retired enabled preference cannot restore directory or overview valuations", async ({ page }) => {
  await prepare(page);
  await page.addInitScript(storageKey => localStorage.setItem(storageKey, "1"), key);
  await page.goto("/?view=wallets");
  const table = page.locator(".wallet-table");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(page.getByRole("checkbox", { name: "Show Paragon estimates" })).toHaveCount(0);
  await expect(page.locator(".paragon-estimate")).toHaveCount(0);
  await expect(table.locator("tbody td:nth-child(4)")).toContainText("−$100");
  await page.getByLabel("Sort by").selectOption("realizedPnl");
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.locator("tbody .rank-cell")).toHaveText("26");
  await page.reload();
  await expect(page.getByLabel("Sort by")).toBeVisible();
  await expect(page.locator(".paragon-estimate")).toHaveCount(0);
  await page.goto("/");
  await expect(page.getByRole("checkbox", { name: "Show Paragon estimates" })).toHaveCount(0);
  await expect(page.locator(".paragon-estimate")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Implied supply value");
  await page.evaluate(storageKey => window.dispatchEvent(new StorageEvent("storage", { key: storageKey, newValue: "1" })), key);
  await expect(page.locator(".paragon-estimate")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
});
