import { expect, test, type Page } from "@playwright/test";
import type { HouseResponse } from "../../packages/shared/src/types";
import { account, marketResponse, mockSources, overview } from "./fixtures";

const raw = (value: number) => (BigInt(value) * 10n ** 18n).toString();

async function sources(page: Page, empty = false) {
  await mockSources(page);
  const at = Date.now();
  const live = overview();
  live.trades = marketResponse(0, false, at).trades;
  await page.route("**/api/events*", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify({ type: "overview", data: live })}\n\n`,
    }),
  );
  await page.route("**/api/overview", (route) => route.fulfill({ json: live }));
  await page.route("**/api/accounts?**", (route) =>
    route.fulfill({
      json: {
        accounts: Array.from({ length: 10 }, (_, index) => ({
          ...account(
            `0x${(index + 1).toString(16).padStart(40, "0")}`,
            `Trader ${index + 1}`,
          ),
          currentUnrealizedPnl: raw(10000 - index * 100),
          currentOpenPositionCount: index + 1,
        })),
        count: 10,
        pageInfo: { page: 0, totalPages: 1 },
        summary: { uniqueAccounts: 10 },
        receivedAt: at,
        stale: false,
      },
    }),
  );
  const house: HouseResponse = {
    sourceAt: empty ? null : at,
    receivedAt: empty ? null : at,
    stale: empty,
    house: empty
      ? null
      : {
          fundsRaw: raw(1200000),
          lpRaw: raw(1000000),
          openPnlRaw: raw(200000),
          queueDebtRaw: "0",
        },
    paper: {
      supplyRaw: null,
      stakedRaw: null,
      stakerRewardsRaw: null,
      pendingRewardsRaw: null,
    },
    sourceBlock: null,
    summarySourceAt: null,
    history: empty
      ? []
      : [
          { time: at - 600000, fundsRaw: raw(1000000), lpRaw: raw(1000000) },
          { time: at - 480000, fundsRaw: raw(1100000), lpRaw: raw(1100000) },
          {
            time: at - 60000,
            fundsRaw: raw(1150000),
            lpRaw: raw(1150000),
            gapBefore: true,
          },
          { time: at, fundsRaw: raw(1200000), lpRaw: raw(1200000) },
        ],
    coverage: {
      source: "retained-house-observations",
      approximate: true,
      observedFrom: empty ? null : at - 600000,
      partial: true,
    },
  };
  await page.route("**/api/house", (route) => route.fulfill({ json: house }));
}

test("overview gives ten live trades full room and fits house funds to retained history", async ({
  page,
}, testInfo) => {
  await sources(page);
  await page.goto("/");
  const feed = page.locator("#activity");
  const leaders = page.getByRole("region", { name: "Top open PnL" });
  await expect(feed.locator(".trade-row")).toHaveCount(10);
  await expect(leaders.locator(".open-pnl-row")).toHaveCount(10);
  const list = await feed.locator(".trade-list").evaluate((element) => ({
    scroll: element.scrollHeight,
    client: element.clientHeight,
  }));
  expect(list.scroll).toBeLessThanOrEqual(list.client + 1);
  const feedBox = (await feed.boundingBox())!;
  const leadersBox = (await leaders.boundingBox())!;
  if (testInfo.project.name === "desktop") {
    expect(Math.abs(feedBox.y - leadersBox.y)).toBeLessThan(1);
    expect(Math.abs(feedBox.height - leadersBox.height)).toBeLessThan(1);
    const feedFooter = (await feed.locator(".panel-footnote").boundingBox())!;
    const leadersFooter = (await leaders
      .locator(".open-pnl-footer")
      .boundingBox())!;
    expect(
      Math.abs(
        feedFooter.y +
          feedFooter.height -
          leadersFooter.y -
          leadersFooter.height,
      ),
    ).toBeLessThan(1);
  } else expect(feedBox.y).toBeGreaterThan(leadersBox.y + leadersBox.height);

  const chart = page.getByRole("region", { name: "House funds chart card" });
  await expect(chart).toContainText("Available history · up to 24h");
  const plot = chart.getByRole("img");
  const plotBox = (await plot.boundingBox())!;
  expect(plotBox.height).toBeGreaterThanOrEqual(
    testInfo.project.name === "desktop" ? 230 : 180,
  );
  expect(plotBox.height).toBeLessThanOrEqual(
    testInfo.project.name === "desktop" ? 280 : 181,
  );
  const path = chart.locator(".pc-chart-plot path");
  expect((await path.getAttribute("d"))?.match(/M/g)).toHaveLength(2);
  expect(
    await path.evaluate(
      (element) => (element as SVGPathElement).getBBox().width,
    ),
  ).toBeGreaterThan(650);
  await plot.focus();
  await page.keyboard.press("Home");
  await expect(chart.locator(".pc-chart-inspect")).toContainText(
    "1,000,000 USDC",
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({
    path: `/tmp/paperclub-overview-layout-${testInfo.project.name}.png`,
    fullPage: true,
  });
});

test("house health leaves absent observations unavailable at its comfortable default height", async ({
  page,
}, testInfo) => {
  await sources(page, true);
  await page.goto("/");
  const health = page.getByRole("region", { name: "House health", exact: true });
  const chart = health.getByRole("region", { name: "House funds chart card" });
  await expect(health.locator(".house-health-status")).toHaveText("Awaiting snapshot");
  await expect(health.locator(".house-components .pc-chart-headline > strong")).toHaveText(["—", "—", "—"]);
  await expect(chart.locator(".pc-chart-headline > strong")).toHaveText("—");
  await expect(chart).toContainText("awaiting observations");
  await expect(chart).toContainText("No observations in this range");
  await expect(chart.locator(".pc-chart-plot path")).toHaveAttribute("d", "");
  expect(
    (await chart.getByRole("img").boundingBox())!.height,
  ).toBeGreaterThanOrEqual(testInfo.project.name === "desktop" ? 230 : 180);
});
