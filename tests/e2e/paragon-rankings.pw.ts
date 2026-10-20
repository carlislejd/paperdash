import { expect, test, type Page } from "@playwright/test";
import type { LeaderboardResponse, PaperPriceQuote, WalletBatchResponse } from "../../packages/shared/src/types";
import { account, leaderboardResponse, mockSources, paperEconomicsResponse, SECOND_WALLET, WALLET } from "./fixtures";

const at = Date.UTC(2026, 9, 19, 5);
const raw = (value: number) => (BigInt(value) * 10n ** 18n).toString();
const quote = (time = at): PaperPriceQuote => ({
  source: "hyperliquid", market: "para:PAPER", basis: "perp-mid",
  priceUsdRaw: "200000000000000000",
  bidUsdRaw: "199000000000000000", askUsdRaw: "201000000000000000",
  sourceAt: time, receivedAt: time,
});

async function prepare(page: Page) {
  await page.clock.install({ time: at });
  await page.clock.pauseAt(new Date(at));
  await page.addInitScript(() => {
    Math.random = () => 0;
    localStorage.setItem("paperclub:paragon-estimates:v1", "1");
  });
  await mockSources(page);
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.route("**/api/paper/economics", (route) => route.fulfill({
    json: { ...paperEconomicsResponse(at), paperPrice: quote() },
  }));
  return requests;
}

function extraRequests(requests: string[]) {
  return requests.filter((request) => {
    const url = new URL(request);
    return url.hostname.endsWith("hyperliquid.xyz") ||
      (url.pathname.startsWith("/api/wallets/") && url.pathname !== "/api/wallets/batch");
  });
}

test("leaderboards preserve PnL and PAPER units with retired valuation preferences enabled", async ({ page }) => {
  const requests = await prepare(page);
  await page.route("**/api/leaderboard?**", (route) => {
    const metric = new URL(route.request().url()).searchParams.get("metric") as LeaderboardResponse["metric"];
    const data = leaderboardResponse(metric);
    data.receivedAt = data.accountReceivedAt = at;
    data.rows = [
      { ...data.rows[0], paperTotalRaw: metric === "volume" ? null : raw(1000) },
      { ...data.rows[0], address: SECOND_WALLET, leaderboardName: "Yuki", rank: 2, pnlRaw: raw(300), paperTotalRaw: metric === "volume" ? null : raw(2000) },
    ];
    data.paperOwnership = { trackedTotalRaw: raw(5000), pageTotalRaw: raw(3000), pageShareBps: 6000 };
    return route.fulfill({ json: data });
  });
  await page.goto("/?view=leaderboard");
  const panel = page.getByRole("region", { name: "Leaderboard", exact: true });
  const rows = panel.locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(panel.getByRole("checkbox", { name: "Show Paragon estimates" })).toHaveCount(0);
  await expect(rows.locator(".paragon-estimate")).toHaveCount(0);
  await expect(rows.nth(1).locator(".leaderboard-value-pnl")).toContainText("+$300");
  await panel.getByRole("button", { name: "PAPER", exact: true }).click();
  await expect(panel.locator(".leaderboard-paper-summary")).toContainText("5K");
  await expect(panel.locator(".leaderboard-paper-summary")).toContainText("3K");
  await expect(rows.first().locator(".leaderboard-value-paper")).toContainText("1K");
  await expect(rows.nth(1).locator(".leaderboard-value-paper")).toContainText("2K");
  await expect(panel.locator(".paragon-estimate")).toHaveCount(0);
  expect(extraRequests(requests)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test("Following keeps cash balances and open PnL without reference valuations", async ({ page }) => {
  const requests = await prepare(page);
  await page.addInitScript(({ wallet, second }) => {
    localStorage.setItem("paperdash:following", JSON.stringify({ version: 2, items: [
      { address: wallet, nameHint: "Aoi", followedAt: 123 },
      { address: second, nameHint: "Yuki", followedAt: 123 },
    ] }));
  }, { wallet: WALLET, second: SECOND_WALLET });
  const data: WalletBatchResponse = {
    rows: [WALLET, SECOND_WALLET].map((address, index) => ({
      address, account: { ...account(address, index ? "Yuki" : "Aoi"), paperTotal: raw(index ? 2000 : 1000), currentUnrealizedPnl: raw(12) },
      receivedAt: at, sourceAt: null, stale: false, refreshQueued: false,
    })),
    activity: {
      items: [], windowFrom: at - 86400000, windowTo: at, receivedAt: at, stale: false,
      coverage: { source: "retained-public-observations", partial: true, identityAmbiguous: true, projectionBackfillComplete: true, observedFrom: at - 86400000, truncated: false },
    },
    receivedAt: at, stale: false,
  };
  await page.route("**/api/wallets/batch?**", (route) => route.fulfill({ json: data }));
  await page.goto("/?view=following");
  const panel = page.getByRole("region", { name: /Following/ });
  const rows = panel.locator(".following-table tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(panel.getByRole("checkbox", { name: "Show Paragon estimates" })).toHaveCount(0);
  await expect(rows.locator(".paragon-estimate")).toHaveCount(0);
  await expect(rows.first().locator("td:nth-child(3)")).toContainText("+$12");
  expect(requests.filter((url) => new URL(url).pathname === "/api/wallets/batch")).toHaveLength(1);
  expect(extraRequests(requests)).toEqual([]);
  expect(requests.filter((url) => new URL(url).pathname === "/api/accounts")).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test("top open PnL keeps gains and open notional without token valuations", async ({ page }) => {
  const requests = await prepare(page);
  await page.route("**/api/accounts?**", (route) => route.fulfill({ json: {
    accounts: [WALLET, SECOND_WALLET].map((address, index) => ({
      ...account(address, index ? "Yuki" : "Aoi"),
      paperTotal: raw(index ? 2000 : 1000), currentUnrealizedPnl: raw(index ? 50 : 100), currentOpenPositionCount: null,
    })),
    count: 2, pageInfo: { page: 0, totalPages: 1 },
    summary: { uniqueAccounts: 2, trackedBalance: "0", trackedQueued: "0", trackedOpenNotional: "0", trackedPaper: raw(3000) },
    receivedAt: at, stale: false,
  } }));
  await page.goto("/");
  const panel = page.getByRole("region", { name: "Top open PnL" });
  const rows = panel.locator(".open-pnl-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first().locator(".open-pnl-value strong")).toHaveText("+$100");
  await expect(rows.nth(1).locator(".open-pnl-value strong")).toHaveText("+$50");
  await expect(rows.first().locator(".open-pnl-wallet small")).toContainText("open notional");
  await expect(rows.locator(".paragon-estimate")).toHaveCount(0);
  expect(extraRequests(requests)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
});
