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

test("directory setting defaults off, preserves controls, persists across navigation and reload", async ({ page }) => {
  const requests = await prepare(page);
  await page.goto("/?view=wallets");
  const toggle = page.getByRole("checkbox", { name: "Show Paragon estimates" });
  const table = page.locator(".wallet-table");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(toggle).not.toBeChecked();
  // The directory already shares its top-line staker APR economics request.
  await expect.poll(() => requests.filter(path => path === "/api/paper/economics").length).toBe(1);
  await page.getByLabel("Sort by").selectOption("realizedPnl");
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(table.locator("tbody .rank-cell")).not.toHaveText("01");
  const rank = await table.locator("tbody .rank-cell").textContent();
  const balance = await table.locator(".table-balance").textContent();
  const pnl = await table.locator("tbody td:nth-child(4)").textContent();
  await toggle.check();
  await expect(table.locator(".paragon-estimate")).toContainText("≈ $24.7");
  await expect(table.locator(".paragon-estimate")).toContainText("(Paragon premarket price)");
  await expect(page.getByLabel("Sort by")).toHaveValue("realizedPnl");
  await expect(table.locator("tbody .rank-cell")).toHaveText(rank!);
  await expect(table.locator(".table-balance")).toHaveText(balance!);
  await expect(table.locator("tbody td:nth-child(4)")).toHaveText(pnl!);
  expect(requests.filter(path => path === "/api/paper/economics")).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.locator("#wallets").screenshot({ path: `/tmp/paperclub-paragon-directory-${test.info().project.name}.png` });
  await page.getByRole("navigation").getByRole("button", { name: /^Leaderboard/ }).click();
  await expect(toggle).toBeChecked();
  await page.reload();
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await page.reload();
  await expect(toggle).not.toBeChecked();
  expect(await page.evaluate(storageKey => localStorage.getItem(storageKey), key)).toBe("0");
});

test("blocked preference storage still allows estimates during this session", async ({ page }) => {
  await prepare(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Blocked", "SecurityError"); } });
  });
  await page.goto("/?view=wallets");
  const toggle = page.getByRole("checkbox", { name: "Show Paragon estimates" });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(page.locator(".wallet-table .paragon-estimate")).toContainText("$24.7");
  await toggle.uncheck();
  await expect(page.locator(".paragon-estimate")).toHaveCount(0);
});

test("cross-tab preference events synchronize and an old quote stays visibly delayed", async ({ page }) => {
  await prepare(page);
  await page.addInitScript(storageKey => localStorage.setItem(storageKey, "invalid"), key);
  await page.goto("/?view=wallets");
  const toggle = page.getByRole("checkbox", { name: "Show Paragon estimates" });
  await expect(toggle).not.toBeChecked();
  await page.evaluate(storageKey => window.dispatchEvent(new StorageEvent("storage", { key: storageKey, newValue: "1" })), key);
  await expect(toggle).toBeChecked();
  const estimate = page.locator(".wallet-table .paragon-estimate");
  await expect(estimate).toContainText("$24.7");
  await expect(estimate).not.toContainText("delayed");
  await page.clock.fastForward(61000);
  await expect(estimate).toContainText("Price delayed");
  await expect(estimate).toContainText("Holdings delayed");
  await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: null, newValue: null })));
  await expect(toggle).not.toBeChecked();
  await expect(estimate).toHaveCount(0);
});
