import { expect, test } from "@playwright/test";
import {
  mockSources,
  positionMetricsResponse,
  walletResponse,
  WALLET,
} from "./fixtures";

test("overview and wallet means use the closed cohort and separate open-position ages", async ({
  page,
}) => {
  const at = Date.now();
  await page.clock.install({ time: at });
  await mockSources(page);
  await page.route("**/api/position-metrics", (route) =>
    route.fulfill({
      json: {
        ...positionMetricsResponse(),
        positionCount: 12,
        avgHoldMs: 5_400_000,
        avgLeverage: 6.25,
        excludedCount: 2,
      },
    }),
  );
  await page.route(`**/api/wallets/${WALLET}/position-metrics`, (route) =>
    route.fulfill({
      json: {
        ...positionMetricsResponse(),
        positionCount: 3,
        avgHoldMs: 7_200_000,
        avgLeverage: 12,
        coverage: {
          ...positionMetricsResponse().coverage,
          pending: true,
          historyBackfillComplete: false,
        },
      },
    }),
  );
  await page.route(`**/api/wallets/${WALLET}`, (route) => {
    const wallet = walletResponse(WALLET, at);
    wallet.snapshot!.indexedThroughTimestamp = at / 1000;
    wallet.snapshot!.openPositions = Array.from({ length: 7 }, (_, i) => [
      String(i),
      i % 2,
      i % 2 === 0,
      false,
      "1",
      "1",
      10 + i,
      "1",
      at - 3_600_000 - i * 60_000,
      null,
    ]);
    wallet.trades.items = [
      {
        id: "closed-test",
        positionId: "closed-test",
        timestampMs: at,
        openedAtMs: at - 90_000,
        leverage: 5,
        isLong: true,
        symbol: "BTC",
        kind: "Liquidated",
        adjustedPnlRaw: "0",
      },
    ];
    return route.fulfill({ json: wallet });
  });
  await page.goto("/");
  const global = page.getByRole("region", { name: "Global position averages" });
  await expect(global).toContainText("1h 30m");
  await expect(global).toContainText("6.25×");
  await expect(global).toContainText("Closed positions 12");
  await expect(global).toContainText(
    "Equal-weight · includes liquidations · partial indexed history · 2 excluded",
  );
  await page.screenshot({
    path: test.info().outputPath("position-overview.png"),
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Wallets", exact: true })
    .click();
  await page.getByRole("button", { name: /^Aoi / }).click();
  const dialog = page.getByRole("dialog");
  const means = dialog.getByRole("region", {
    name: "Wallet position averages",
  });
  await expect(means).toContainText("2h");
  await expect(means).toContainText("12×");
  await expect(means).toContainText("Syncing history");
  const open = dialog.getByRole("region", { name: "Current open positions" });
  await expect(open.getByRole("listitem")).toHaveCount(5);
  await expect(open.getByRole("listitem").first()).toContainText("10×");
  await expect(open.getByRole("listitem").first()).toContainText("1h");
  await open.getByRole("button", { name: "Show 2 more positions" }).click();
  await expect(open.getByRole("listitem")).toHaveCount(7);
  await open.getByRole("button", { name: "Show fewer positions" }).click();
  await expect(open.getByRole("listitem")).toHaveCount(5);
  await means.scrollIntoViewIfNeeded();
  await dialog.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollTop - 90);
  });
  await page.screenshot({
    path: test.info().outputPath("position-wallet.png"),
  });
  await dialog.getByRole("tab", { name: /Closed trades/ }).click();
  await expect(dialog.getByRole("tabpanel")).toContainText("Held 1m 30s");
  expect(await dialog.evaluate((e) => e.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
});

test("empty means stay unknown and cached means survive a refresh failure", async ({
  page,
}) => {
  await page.clock.install();
  await mockSources(page);
  let fail = false;
  let empty = true;
  await page.route("**/api/position-metrics", (route) =>
    route.fulfill(
      fail
        ? { status: 503, json: { message: "Unavailable" } }
        : {
            json: {
              ...positionMetricsResponse(),
              positionCount: empty ? 0 : 4,
              avgHoldMs: empty ? null : 60_000,
              avgLeverage: empty ? null : 8,
            },
          },
    ),
  );
  await page.goto("/");
  const means = page.getByRole("region", { name: "Global position averages" });
  await expect(means.locator("dd")).toHaveText(["—", "—"]);
  await expect(means).toContainText("No closed positions indexed yet.");
  empty = false;
  await means
    .getByRole("button", { name: "Refresh global position averages" })
    .click();
  await expect(means.locator("dd")).toHaveText(["1m", "8×"]);
  fail = true;
  await means
    .getByRole("button", { name: "Refresh global position averages" })
    .click();
  await expect(means.getByRole("status")).toContainText(
    "Could not refresh these averages. Saved values shown.",
  );
  await expect(means.locator("dd")).toHaveText(["1m", "8×"]);
  await expect(means).toContainText("Last available");
  fail = false;
  // Honor the temporary source cooldown before retrying; repeated clicks must not bypass it.
  await page.clock.fastForward(30000);
  await means
    .getByRole("button", { name: "Refresh global position averages" })
    .click();
  await expect(means.getByRole("status")).toHaveCount(0);
});

test("delayed open ages freeze at their source snapshot and metric polling stops offscreen", async ({
  page,
}) => {
  const at = Date.now();
  await page.clock.install({ time: at });
  await mockSources(page);
  let globalReads = 0,
    walletReads = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/position-metrics") globalReads++;
    if (path === `/api/wallets/${WALLET}/position-metrics`) walletReads++;
  });
  await page.route(`**/api/wallets/${WALLET}`, (route) => {
    const wallet = walletResponse(WALLET, at - 3_600_000);
    wallet.stale = true;
    wallet.snapshot!.indexedThroughTimestamp = (at - 3_600_000) / 1000;
    wallet.snapshot!.openPositions = [
      ["9", 0, true, false, "1", "1", 10, "1", at - 7_200_000, null],
    ];
    return route.fulfill({ json: wallet });
  });
  await page.goto(`/?wallet=${WALLET}`);
  const dialog = page.getByRole("dialog");
  const open = dialog.getByRole("region", { name: "Current open positions" });
  await expect(open).toContainText("At saved snapshot");
  await expect(open.getByRole("listitem")).toContainText("1h");
  await expect.poll(() => walletReads).toBeGreaterThan(0);
  const before = walletReads;
  await page.clock.fastForward(60_001);
  await expect.poll(() => walletReads).toBeGreaterThan(before);
  await expect(open.getByRole("listitem")).toContainText("1h");
  await dialog.getByRole("button", { name: "Close wallet details" }).click();
  const afterClose = walletReads;
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Assets", exact: true })
    .click();
  const afterNav = globalReads;
  await page.clock.fastForward(20_001);
  expect(walletReads).toBe(afterClose);
  expect(globalReads).toBe(afterNav);
});
