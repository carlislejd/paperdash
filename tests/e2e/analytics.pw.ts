import { expect, test } from "@playwright/test";
import {
  assetResponse,
  leaderboardResponse,
  mockSources,
  WALLET,
  SECOND_WALLET,
} from "./fixtures";

test("asset deep links expose entry notional, valid shares and wallet-linked activity", async ({
  page,
}) => {
  await mockSources(page);
  let directoryReads = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/accounts") directoryReads++;
  });
  await page.goto("/?view=assets&asset=0");
  await expect(
    page
      .getByRole("navigation")
      .getByRole("button", { name: "Assets", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  const btc = page.getByRole("region", { name: "BTC analytics" });
  await expect(btc).toContainText("$8,000,000.00");
  await expect(
    btc.getByRole("img", {
      name: "75.0% long, 25.0% short, by entry notional",
    }),
  ).toBeVisible();
  await expect(btc).toContainText(
    "Share of total entry notional: long + short.",
  );
  await expect(btc).toContainText("Partial public observations");
  await expect(
    btc.getByRole("img", {
      name: /BTC open-interest history, 3 recorded snapshots/,
    }),
  ).toBeVisible();
  expect(directoryReads).toBe(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.getByRole("button", { name: "ETH Ethereum" }).click();
  await expect(page).toHaveURL(/view=assets&asset=1/);
  await expect(
    page.getByRole("img", {
      name: "No open interest; long and short shares are undefined",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "ETH analytics" }),
  ).not.toContainText("50.0%");
  await expect(
    page.getByText("No retained trades in this window"),
  ).toBeVisible();
  await page.goBack();
  await expect(btc).toBeVisible();
  await btc.getByRole("button", { name: /0x1111.*View wallet/ }).click();
  await expect(page).toHaveURL(
    new RegExp(`view=assets&asset=0&wallet=${WALLET}`),
  );
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(btc).toBeVisible();
});

test("leaderboard separates 24h PnL from partial observed rankings and pages wallets", async ({
  page,
}) => {
  await mockSources(page);
  await page.goto("/?view=leaderboard");
  const panel = page.getByRole("region", { name: "Leaderboard", exact: true });
  await expect(
    panel.getByRole("button", { name: "24h PnL", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(panel).toContainText("+$5,001.00");
  const pnlRow = panel
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name: /^Aoi / }) });
  await expect(pnlRow.getByRole("cell").nth(3)).toHaveText("$3,000,000.00");
  await expect(pnlRow.getByRole("cell").nth(4)).toHaveText("23");
  await expect(pnlRow.locator(".leaderboard-upnl")).toHaveText(
    "+$1,250,000.00",
  );
  await expect(pnlRow.locator(".leaderboard-asset")).toHaveText([
    /BTC$/,
    /^ETH$/,
  ]);
  await expect(pnlRow.locator(".leaderboard-asset-mark.eth svg")).toHaveCount(
    1,
  );
  await panel
    .getByRole("button", { name: "Observed volume", exact: true })
    .click();
  await expect(panel).toContainText("$3,000,000.00");
  await expect(panel).toContainText("Partial activity coverage");
  await expect(pnlRow.getByRole("cell").nth(3)).toHaveText("—");
  await expect(pnlRow.locator(".leaderboard-upnl")).toHaveText("—");
  await expect(pnlRow.locator(".leaderboard-upnl")).toHaveAttribute(
    "title",
    /unavailable/,
  );
  await panel
    .getByRole("button", { name: "Observed trades", exact: true })
    .click();
  await expect(
    panel.getByRole("columnheader", { name: "OBS. TRADES" }),
  ).toHaveAttribute("aria-sort", "descending");
  await expect(pnlRow.getByRole("cell").nth(2)).toHaveText("23");
  await panel.getByRole("button", { name: "Next leaderboard page" }).click();
  await expect(panel.getByRole("button", { name: /^Yuki / })).toBeVisible();
  await expect(
    panel.getByRole("cell", { name: "26", exact: true }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "24h PnL", exact: true }).click();
  await expect(panel.getByRole("button", { name: /^Aoi / })).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Previous leaderboard page" }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({
    path: `/tmp/paperclub-expanded-leaderboard-${test.info().project.name}.png`,
    fullPage: true,
  });
  await panel.getByRole("button", { name: /^Aoi / }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("leaderboard distinguishes unavailable asset data from no observed trades", async ({
  page,
}) => {
  await mockSources(page);
  await page.route("**/api/leaderboard?**", (route) => {
    const data = leaderboardResponse();
    data.activityCoverage!.stale = true;
    data.accountStale = true;
    const original = data.rows[0];
    data.rows = [
      {
        ...original,
        assetsTraded: null,
        currentUnrealizedPnlRaw: null,
        tradeCount: null,
        volumeUsd: null,
      },
      {
        ...original,
        address: SECOND_WALLET,
        leaderboardName: "No activity",
        rank: 2,
        assetsTraded: [],
        currentUnrealizedPnlRaw: "0",
        tradeCount: 0,
        volumeUsd: 0,
      },
    ];
    return route.fulfill({ json: data });
  });
  await page.goto("/?view=leaderboard");
  const rows = page.locator(".leaderboard-table tbody tr");
  await expect(rows.first().locator("td").last()).toHaveText("—");
  await expect(rows.first().locator(".leaderboard-upnl")).toHaveText("—");
  await expect(rows.nth(1).locator("td").last()).toHaveText("None observed");
  await expect(rows.nth(1).locator(".leaderboard-upnl")).toHaveText("$0.00");
  await expect(page.locator(".leaderboard-asset-mark")).toHaveCount(0);
  await expect(page.locator(".analytics-coverage-note")).toContainText(
    "Activity data is delayed",
  );
  await expect(page.locator(".analytics-coverage-note")).toContainText(
    "Account valuations are delayed",
  );
});

test("analytics polling stops on navigation and cached values survive refresh errors", async ({
  page,
}) => {
  await page.clock.install();
  await mockSources(page);
  let assetReads = 0,
    fail = false;
  await page.route("**/api/assets", async (route) => {
    assetReads++;
    await route.fulfill(
      fail
        ? { status: 503, json: { message: "Asset snapshot unavailable" } }
        : { json: assetResponse() },
    );
  });
  await page.goto("/?view=assets&asset=0");
  await expect(
    page.getByRole("region", { name: "BTC analytics" }),
  ).toContainText("$8,000,000.00");
  const initialReads = assetReads;
  fail = true;
  await page.clock.fastForward(5_001);
  await expect.poll(() => assetReads).toBeGreaterThan(initialReads);
  await expect(page.getByRole("status")).toContainText(
    "Showing the last available snapshot. Asset snapshot unavailable",
  );
  await expect(
    page.getByRole("region", { name: "BTC analytics" }),
  ).toContainText("$8,000,000.00");
  await expect(
    page.getByText("Last available snapshot", { exact: false }).first(),
  ).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Overview", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Protocol overview" }),
  ).toBeVisible();
  const before = assetReads;
  await page.clock.fastForward(20_001);
  expect(assetReads).toBe(before);
});
