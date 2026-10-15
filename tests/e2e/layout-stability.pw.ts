import { expect, test } from "@playwright/test";
import { account, leaderboardResponse, mockSources } from "./fixtures";

function rankedRows(count: number) {
  const result = leaderboardResponse();
  result.rows = Array.from({ length: count }, (_, index) => ({
    ...result.rows[0],
    address: `0x${(index + 1).toString(16).padStart(40, "0")}`,
    rank: index + 1,
  }));
  return result;
}

test("short pages keep the site footer anchored as live table results grow", async ({
  page,
}, testInfo) => {
  await mockSources(page);
  let count = 1;
  await page.route("**/api/leaderboard?**", (route) =>
    route.fulfill({ json: rankedRows(count) }),
  );
  await page.goto("/?view=leaderboard");
  await expect(page.locator(".leaderboard-table tbody tr")).toHaveCount(1);
  await page.evaluate(() => document.fonts.ready);
  const before = (await page.locator(".site-footer").boundingBox())!;
  count = 2;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".leaderboard-table tbody tr")).toHaveCount(2);
  const after = (await page.locator(".site-footer").boundingBox())!;
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
  expect(after.y + after.height).toBeGreaterThanOrEqual(
    page.viewportSize()!.height - 1,
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  await testInfo.attach("footer-layout-bounds", {
    body: JSON.stringify({ before, after }, null, 2),
    contentType: "application/json",
  });
  await page.screenshot({
    path: `/tmp/paperclub-stable-footer-${testInfo.project.name}.png`,
    fullPage: true,
  });
});

for (const view of ["wallets", "leaderboard"] as const)
  test(`${view} loading preserves column positions when full results arrive`, async ({
    page,
  }, testInfo) => {
    await mockSources(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      view === "wallets" ? "**/api/accounts?**" : "**/api/leaderboard?**",
      async (route) => {
        await gate;
        return route.fulfill({
          json:
            view === "wallets"
              ? {
                  accounts: Array.from({ length: 25 }, (_, index) =>
                    account(
                      `0x${(index + 1).toString(16).padStart(40, "0")}`,
                      `Trader ${index}`,
                    ),
                  ),
                  count: 25,
                  pageInfo: { page: 0, totalPages: 1 },
                  summary: { uniqueAccounts: 25 },
                  receivedAt: Date.now(),
                  stale: false,
                }
              : rankedRows(25),
        });
      },
    );
    await page.goto(`/?view=${view}`);
    const table = page.locator(
      view === "wallets" ? "#wallets .wallet-table" : ".leaderboard-table",
    );
    await expect(table.locator(".skeleton-row")).toHaveCount(25);
    await page.evaluate(() => document.fonts.ready);
    const columns = () =>
      table.locator("th").evaluateAll((cells) =>
        cells.map((cell) => {
          const rect = cell.getBoundingClientRect();
          return { x: rect.x, width: rect.width };
        }),
      );
    const before = await columns();
    release();
    await expect(table.locator("tbody tr:not(.skeleton-row)")).toHaveCount(25);
    const after = await columns();
    for (let index = 0; index < before.length; index++) {
      expect(
        Math.abs(after[index].x - before[index].x),
        `column ${index} position`,
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(after[index].width - before[index].width),
        `column ${index} width`,
      ).toBeLessThanOrEqual(1);
    }
    await testInfo.attach("table-column-bounds", {
      body: JSON.stringify({ before, after }, null, 2),
      contentType: "application/json",
    });
    await page.screenshot({
      path: `/tmp/paperclub-stable-${view}-${testInfo.project.name}.png`,
    });
  });
