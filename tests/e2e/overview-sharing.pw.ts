import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { account, mockSources, WALLET, SECOND_WALLET } from "./fixtures";

test("overview ranks open PnL, expands hourly charts and exports a branded PNG", async ({
  page,
}) => {
  await mockSources(page);
  const requests: string[] = [];
  await page.route("**/api/accounts?**", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({
      json: {
        accounts: [
          {
            ...account(WALLET, "Open winner"),
            currentUnrealizedPnl: "10000000000000000000000000000",
            realizedPnl: "-500000000000000000000",
            currentOpenPositionCount: 4,
          },
          {
            ...account(SECOND_WALLET, "Closed winner"),
            currentUnrealizedPnl: "0",
            realizedPnl: "90000000000000000000000000",
          },
        ],
        count: 2,
        pageInfo: { page: 0, totalPages: 1 },
        summary: { uniqueAccounts: 2 },
        receivedAt: Date.now(),
        stale: false,
      },
    });
  });
  await page.goto("/");
  const leaders = page.getByRole("region", { name: "Top open PnL" });
  await expect(leaders).toContainText("+$10B");
  await expect(leaders).not.toContainText("Closed winner");
  await expect(page.locator("#wallets")).toHaveCount(0);
  expect(
    requests.every(
      (url) => new URL(url).searchParams.get("sort") === "currentUnrealizedPnl",
    ),
  ).toBe(true);
  expect(new URL(requests[0]).searchParams.get("pageSize")).toBe("10");
  await leaders.getByRole("button", { name: /Open winner/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  const expand = page.getByRole("button", {
    name: "Expand Volume / hour chart",
  });
  await expand.click();
  const dialog = page.getByRole("dialog", { name: "Volume / hour" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("partial");
  await dialog.getByRole("img").focus();
  await page.keyboard.press("Home");
  await expect(dialog.locator(".pc-chart-inspect")).toContainText("UTC");
  const downloadEvent = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download PNG" }).click();
  const download = await downloadEvent;
  const path = await download.path();
  const image = await readFile(path!);
  expect(image.subarray(1, 4).toString()).toBe("PNG");
  expect(image.readUInt32BE(16)).toBeGreaterThanOrEqual(1200);
  expect(image.byteLength).toBeGreaterThan(10000);
  await download.saveAs(
    `/tmp/paperclub-volume-share-${test.info().project.name}.png`,
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(expand).toBeFocused();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({
    path: `/tmp/paperclub-overview-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test("a shared chart link opens directly and closes without retaining its query", async ({
  page,
}) => {
  await mockSources(page);
  await page.goto("/?view=overview&chart=open-positions&range=7d");
  const dialog = page.getByRole("dialog", { name: "Open positions" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("7 days");
  await expect(dialog.getByRole("img")).toHaveAttribute(
    "aria-label",
    /available observations/,
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("chart")).toBe(false);
});

test("legacy TVL and House funds links still open after LP balance takes the featured chart", async ({
  page,
}) => {
  await mockSources(page);
  await page.goto("/?view=overview&chart=tvl&range=7d");
  const tvl = page.getByRole("dialog", { name: "TVL", exact: true });
  await expect(tvl).toBeVisible();
  await expect(tvl).toContainText("7 days");
  await page.keyboard.press("Escape");
  await expect(tvl).toHaveCount(0);
  const lp = page.getByRole("region", {
    name: "LP balance chart card",
    exact: true,
  });
  const funds = page.getByRole("region", {
    name: "House funds chart card",
    exact: true,
  });
  await expect(lp).not.toHaveClass(/pc-chart-card--compact/);
  await expect(funds).toHaveClass(/pc-chart-card--compact/);
  await funds
    .getByRole("button", { name: "Expand House funds chart", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "House funds", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goto("/?view=overview&chart=house-funds&range=7d");
  await expect(
    page.getByRole("dialog", { name: "House funds", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("chart")).toBe("house-funds");
});
