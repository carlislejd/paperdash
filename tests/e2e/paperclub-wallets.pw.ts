import { expect, test } from "@playwright/test";
import { account, mockSources, WALLET, SECOND_WALLET } from "./fixtures";

test("paperclub keeps saved follows and distinguishes zero, unknown and delayed trade counts", async ({
  page,
}) => {
  const saved = account(WALLET, "Aoi");
  await page.addInitScript((entry) => {
    localStorage.setItem("paperdash:following", JSON.stringify([entry]));
  }, saved);
  await mockSources(page);
  await page.route("**/api/accounts?**", (route) => {
    const now = Date.now();
    return route.fulfill({
      json: {
        accounts: [
          {
            ...saved,
            tradeCount24h: 1234,
            tradeCount24hAt: now,
            tradeCount24hStale: false,
          },
          {
            ...account(SECOND_WALLET, "Yuki"),
            tradeCount24h: 0,
            tradeCount24hAt: now,
          },
          { ...account(`0x${"33".repeat(20)}`, "Rei"), tradeCount24h: null },
          {
            ...account(`0x${"44".repeat(20)}`, "Mei"),
            tradeCount24h: 23,
            tradeCount24hAt: now - 120000,
            tradeCount24hStale: true,
          },
        ],
        count: 4,
        pageInfo: { page: 0, totalPages: 1 },
        summary: {
          uniqueAccounts: 4,
          trackedBalance: "0",
          trackedQueued: "0",
          trackedOpenNotional: "0",
          trackedPaper: "0",
        },
        receivedAt: now,
        stale: false,
      },
    });
  });
  await page.goto("/?view=wallets");
  await expect(page).toHaveTitle("paperclub — Papertrade analytics");
  await expect(
    page.getByRole("button", { name: "paperclub overview" }),
  ).toContainText("paperclub.");
  const table = page.locator(".wallet-table");
  await expect(
    table.getByRole("columnheader", { name: "TRADES · 24H", exact: true }),
  ).toBeVisible();
  await expect(table.locator("tbody .trade-count-cell")).toHaveText([
    "1,234",
    "0",
    "—",
    "23 *",
  ]);
  await expect(table.locator("tbody .table-balance").first()).toHaveText(
    "$10,779.00",
  );
  await expect(page.locator(".wallet-trade-note")).toContainText(
    "observed opens, closes & liquidations",
  );
  await expect(table.getByLabel("Last available trade count")).toHaveCount(1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page
    .locator("#wallets")
    .screenshot({
      path: `/tmp/paperclub-wallets-${test.info().project.name}.png`,
    });
  await page
    .getByRole("navigation")
    .getByRole("button", { name: /^Following/ })
    .click();
  await expect(table.getByRole("button", { name: /^Aoi / })).toBeVisible();
  await expect(table.locator("tbody .trade-count-cell")).toHaveText("—");
  await expect(
    table.getByRole("columnheader", { name: "SAVED TRADES · 24H" }),
  ).toBeVisible();
});
