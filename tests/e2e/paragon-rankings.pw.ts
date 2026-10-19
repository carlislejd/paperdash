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
  await page.addInitScript(() => { Math.random = () => 0; });
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

test("Paragon estimates are optional secondary PAPER values and never change leaderboard PnL or rank", async ({ page }) => {
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
  const toggle = panel.getByRole("checkbox", { name: "Show Paragon estimates" });
  const rows = panel.locator("tbody tr");
  await expect(toggle).not.toBeChecked();
  await expect(rows.locator(".paragon-estimate")).toHaveCount(0);
  const pnl = await rows.locator(".leaderboard-value-pnl").allTextContents();
  const upnl = await rows.locator(".leaderboard-upnl").allTextContents();
  const names = await rows.locator(".wallet-identity").allTextContents();
  await toggle.check();
  await expect(rows.first().locator(".paragon-estimate")).toContainText("$200");
  await expect(rows.first().locator(".paragon-estimate")).toContainText("(Paragon premarket price)");
  await expect(rows.nth(1).locator(".paragon-estimate")).toContainText("$400");
  expect(await rows.locator(".leaderboard-value-pnl").allTextContents()).toEqual(pnl);
  expect(await rows.locator(".leaderboard-upnl").allTextContents()).toEqual(upnl);
  expect(await rows.locator(".wallet-identity").allTextContents()).toEqual(names);
  expect(requests.filter((url) => new URL(url).pathname === "/api/paper/economics")).toHaveLength(1);
  expect(requests.filter((url) => new URL(url).pathname === "/api/leaderboard")).toHaveLength(1);
  await panel.getByRole("button", { name: "PAPER", exact: true }).click();
  await expect(panel.locator(".leaderboard-paper-summary .paragon-estimate").first()).toContainText("$1K");
  await expect(panel.locator(".leaderboard-paper-summary .paragon-estimate").nth(1)).toContainText("$600");
  await page.clock.fastForward(70000);
  await expect(rows.first().locator(".paragon-estimate")).toContainText(/holdings.*delayed|holdings.*last available/i);
  await panel.getByRole("button", { name: "Observed volume", exact: true }).click();
  await expect(rows.first().locator(".paragon-estimate")).toContainText(/unavailable/i);
  await expect(rows.first().locator(".paragon-estimate")).not.toContainText("$0");
  expect(extraRequests(requests)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test("Following uses its existing visible-wallet batch for separate PAPER estimates and honest aging", async ({ page }) => {
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
  const balances = await rows.locator(".following-balance").allTextContents();
  const openPnl = await rows.locator("td:nth-child(3)").allTextContents();
  await panel.getByRole("checkbox", { name: "Show Paragon estimates" }).check();
  await expect(rows.first().locator(".paragon-estimate")).toContainText("PAPER value");
  await expect(rows.first().locator(".paragon-estimate")).toContainText("$200");
  await expect(rows.nth(1).locator(".paragon-estimate")).toContainText("$400");
  await expect(rows.first().locator(".paragon-estimate")).not.toContainText(/delayed/i);
  expect(await rows.locator(".following-balance").allTextContents()).toEqual(balances);
  expect(await rows.locator("td:nth-child(3)").allTextContents()).toEqual(openPnl);
  expect(requests.filter((url) => new URL(url).pathname === "/api/wallets/batch")).toHaveLength(1);
  await page.clock.fastForward(70000);
  await expect(rows.first().locator(".paragon-estimate")).toContainText(/holdings.*delayed|holdings.*last available/i);
  expect(extraRequests(requests)).toEqual([]);
  expect(requests.filter((url) => new URL(url).pathname === "/api/accounts")).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test("top open PnL keeps its gains and order while optional PAPER estimates wrap beside wallet names", async ({ page }) => {
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
  const values = await rows.locator(".open-pnl-value strong").allTextContents();
  const names = await rows.locator(".open-pnl-wallet > strong").allTextContents();
  await page.getByRole("checkbox", { name: "Show Paragon estimates" }).check();
  await expect(rows.first().locator(".paragon-estimate")).toContainText("PAPER value");
  await expect(rows.first().locator(".paragon-estimate")).toContainText("$200");
  await expect(rows.nth(1).locator(".paragon-estimate")).toContainText("$400");
  expect(await rows.locator(".open-pnl-value strong").allTextContents()).toEqual(values);
  expect(await rows.locator(".open-pnl-wallet > strong").allTextContents()).toEqual(names);
  const estimateBox = await rows.first().locator(".paragon-estimate").boundingBox();
  const valueBox = await rows.first().locator(".open-pnl-value").boundingBox();
  expect(estimateBox!.x + estimateBox!.width).toBeLessThanOrEqual(valueBox!.x);
  expect(extraRequests(requests)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await panel.screenshot({ path: `/tmp/paperclub-paragon-open-pnl-${test.info().project.name}.png` });
});
