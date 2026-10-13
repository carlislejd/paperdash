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
  await expect(pnlRow.locator(".leaderboard-value-volume")).toHaveText(
    "$3,000,000.00",
  );
  await expect(pnlRow.locator(".leaderboard-value-trades")).toHaveText("23");
  await expect(pnlRow.locator(".leaderboard-value-paper")).toHaveText("3M");
  await expect(pnlRow.locator(".leaderboard-value-paper")).toHaveAttribute(
    "title",
    "3,003,199.186757525433019603 PAPER · staked + unstaked",
  );
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
  await expect(pnlRow.locator(".leaderboard-value-pnl")).toHaveText("—");
  await expect(pnlRow.locator(".leaderboard-value-paper")).toHaveText("—");
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
  await panel.getByRole("button", { name: "PAPER", exact: true }).click();
  await expect(panel.getByRole("button", { name: /^Aoi / })).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Previous leaderboard page" }),
  ).toBeDisabled();
  await expect(panel.locator(".analytics-eyebrow")).toHaveText(
    "Current holdings",
  );
  await expect(panel).toContainText("Staked + unstaked PAPER");
  await expect(panel.getByRole("columnheader").nth(2)).toHaveText(
    "PAPER OWNED",
  );
  await expect(
    panel.getByRole("columnheader", { name: "PAPER OWNED" }),
  ).toHaveAttribute("aria-sort", "descending");
  await expect(panel.getByRole("columnheader").nth(3)).toHaveText(
    "Realized P&L · lifetime",
  );
  await expect(
    panel.getByRole("button", { name: "Lifetime", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    panel.getByRole("columnheader", { name: "ASSETS · 24H" }),
  ).toHaveCount(0);
  await expect(pnlRow.locator(".leaderboard-value-pnl")).toHaveText(
    "+$50,010.00",
  );
  await expect(pnlRow.locator(".leaderboard-value-volume")).toHaveText(
    "$30,000,000,000.12",
  );
  await expect(pnlRow.locator(".leaderboard-value-volume")).toHaveAttribute(
    "title",
    "30,000,000,000.123456789012345678 USDC · lifetime traded volume",
  );
  await expect(pnlRow.locator(".leaderboard-value-trades")).toHaveText("1,247");
  await expect(panel).toContainText("not a count of all executions");
  const ownership = panel.getByRole("definition");
  await expect(ownership).toHaveText(["12.01M", "3M", "25.00%"]);
  await expect(ownership.nth(1)).toHaveAttribute(
    "title",
    "3,003,199.186757525433019603 PAPER",
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({
    path: `/tmp/paperclub-paper-leaderboard-${test.info().project.name}.png`,
    fullPage: true,
  });
  await panel.getByRole("button", { name: "24 hours", exact: true }).click();
  await expect(panel.getByRole("columnheader").nth(3)).toHaveText("24H PNL");
  await expect(pnlRow.locator(".leaderboard-value-trades")).toHaveText("23");
  await expect(pnlRow.locator(".leaderboard-value-volume")).toHaveText(
    "$3,000,000.00",
  );
  await expect(pnlRow.locator(".leaderboard-asset")).toHaveCount(2);
  await panel.getByRole("button", { name: "24h PnL", exact: true }).click();
  await expect(panel.getByRole("columnheader").nth(2)).toHaveText("24H PNL");
  await expect(panel.getByRole("columnheader").nth(3)).toHaveText(
    "PAPER OWNED",
  );
  await expect(panel.locator(".leaderboard-paper-summary")).toHaveCount(0);
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
        paperTotalRaw: null,
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
        paperTotalRaw: "0",
      },
    ];
    return route.fulfill({ json: data });
  });
  await page.goto("/?view=leaderboard");
  const rows = page.locator(".leaderboard-table tbody tr");
  await expect(rows.first().locator("td").last()).toHaveText("—");
  await expect(rows.first().locator(".leaderboard-upnl")).toHaveText("—");
  await expect(rows.first().locator(".leaderboard-value-paper")).toHaveText(
    "—",
  );
  await expect(rows.nth(1).locator("td").last()).toHaveText("None observed");
  await expect(rows.nth(1).locator(".leaderboard-upnl")).toHaveText("$0.00");
  await expect(rows.nth(1).locator(".leaderboard-value-paper")).toHaveText("0");
  await expect(page.locator(".leaderboard-asset-mark")).toHaveCount(0);
  await expect(page.locator(".analytics-coverage-note")).toContainText(
    "Activity data is delayed",
  );
  await expect(page.locator(".analytics-coverage-note")).toContainText(
    "Account valuations are delayed",
  );
});

test("PAPER lifetime history distinguishes pending counts, retained partial counts and confirmed zero", async ({
  page,
}) => {
  await mockSources(page);
  const requests: URL[] = [];
  await page.route("**/api/leaderboard?**", (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    if (url.searchParams.get("metric") !== "paper") return route.fallback();
    const data = leaderboardResponse("paper");
    const original = data.rows[0];
    data.count = 4;
    data.pageInfo = { page: 0, totalPages: 1 };
    data.rows = [
      {
        ...original,
        leaderboardName: "Pending",
        tradeCount: null,
        historyCoverage: {
          indexedAt: null,
          backfillComplete: false,
          projectionPending: true,
          excludedCount: 0,
          stale: true,
        },
      },
      {
        ...original,
        address: SECOND_WALLET,
        leaderboardName: "Partial",
        rank: 2,
        tradeCount: 235,
        historyCoverage: {
          indexedAt: Date.now(),
          backfillComplete: false,
          projectionPending: false,
          excludedCount: 3,
          stale: false,
        },
      },
      {
        ...original,
        address: `0x${"33".repeat(20)}`,
        leaderboardName: "Confirmed zero",
        rank: 3,
        tradeCount: 0,
        pnlRaw: "0",
        volumeRaw: "0",
      },
      {
        ...original,
        address: `0x${"44".repeat(20)}`,
        leaderboardName: "Projection pending",
        rank: 4,
        tradeCount: 153,
        historyCoverage: {
          indexedAt: Date.now(),
          backfillComplete: true,
          projectionPending: true,
          excludedCount: 0,
          stale: true,
        },
      },
    ];
    return route.fulfill({ json: data });
  });
  await page.goto("/?view=leaderboard");
  const panel = page.getByRole("region", { name: "Leaderboard", exact: true });
  await panel.getByRole("button", { name: "PAPER", exact: true }).click();
  const rows = panel.locator("tbody tr");
  await expect(rows.nth(0).locator(".leaderboard-value-trades")).toHaveText(
    "—Updating",
  );
  await expect(rows.nth(1).locator(".leaderboard-value-trades")).toHaveText(
    "235Partial history",
  );
  await expect(
    rows.nth(1).locator(".leaderboard-value-trades"),
  ).toHaveAttribute("title", /3 excluded from hold\/leverage averages/);
  await expect(rows.nth(2).locator(".leaderboard-value-trades")).toHaveText(
    "0",
  );
  await expect(rows.nth(2).locator(".leaderboard-value-volume")).toHaveText(
    "$0.00",
  );
  await expect(rows.nth(3).locator(".leaderboard-value-trades")).toHaveText(
    "153Updating",
  );
  expect(
    requests
      .find((url) => url.searchParams.get("metric") === "paper")
      ?.searchParams.get("window"),
  ).toBe("all");
  await expect(
    panel.getByRole("columnheader", { name: "ASSETS · 24H" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  await panel.screenshot({
    path: `/tmp/paperclub-paper-lifetime-${test.info().project.name}.png`,
  });
});

test("an older PAPER response never relabels 24h activity as lifetime", async ({
  page,
}) => {
  await mockSources(page);
  await page.route("**/api/leaderboard?**", (route) => {
    if (new URL(route.request().url()).searchParams.get("metric") !== "paper")
      return route.fallback();
    const data = leaderboardResponse("paper", 0, false, "24h");
    delete data.statsWindow;
    return route.fulfill({ json: data });
  });
  await page.goto("/?view=leaderboard");
  const panel = page.getByRole("region", { name: "Leaderboard", exact: true });
  await panel.getByRole("button", { name: "PAPER", exact: true }).click();
  await expect(panel).toContainText(
    "Lifetime details are unavailable in this snapshot; showing 24-hour activity.",
  );
  await expect(
    panel.getByRole("columnheader", { name: "24H PNL" }),
  ).toBeVisible();
  await expect(
    panel.getByRole("columnheader", { name: "Recorded closes" }),
  ).toHaveCount(0);
  await expect(panel.locator(".leaderboard-value-trades")).toHaveText("23");
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
