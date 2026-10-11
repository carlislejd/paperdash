import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { mockSources, paperEconomicsResponse } from "./fixtures";

test("PAPER uses its own coherent totals and clock, shares hourly changes and preserves range without wallet reads", async ({
  page,
}) => {
  const at = Date.UTC(2026, 9, 10, 12, 25);
  await page.clock.install({ time: at });
  await mockSources(page);
  let reads = 0;
  const walletReads: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/wallets/"))
      walletReads.push(request.url());
  });
  await page.route("**/api/house", (route) =>
    route.fulfill({
      status: 503,
      json: { message: "House temporarily unavailable" },
    }),
  );
  await page.route("**/api/paper/economics", (route) => {
    reads++;
    const data = paperEconomicsResponse(at - 5_000);
    data.stakedRaw = "62785687000000000000000000";
    data.stakeRatioBps = 5000;
    return route.fulfill({ json: data });
  });
  await page.goto("/");
  const paper = page.getByRole("region", {
    name: "PAPER economics",
    exact: true,
  });
  await expect(paper).toContainText("125.57M");
  await expect(paper).toContainText("50.00% of supply");
  await expect(paper).toContainText("Rewards allocated");
  await expect(paper).toContainText("$16.27K");
  await expect(paper).toContainText("Pending rewards source-reported");
  await expect(paper.locator(".paper-pending")).toContainText("$324");
  await expect(paper).not.toContainText("LAST AVAILABLE");
  await expect(paper).toContainText(
    "Historical run rate, not APY or a forecast",
  );
  await expect(
    paper.getByRole("region", { name: "PAPER supply chart card" }),
  ).toContainText("12:24 UTC");
  const hourly = page.getByRole("region", { name: "PAPER hourly history" });
  await expect(hourly).toContainText(
    "Net supply change, not position issuance",
  );
  await expect(hourly).toContainText(
    "New allocations, not distributions or claims",
  );
  await page.getByRole("button", { name: "7d", exact: true }).click();
  await expect(hourly).toContainText("7 days");
  const expand = hourly.getByRole("button", {
    name: "Expand Rewards allocated / hour chart",
  });
  await expand.click();
  const dialog = page.getByRole("dialog", { name: "Rewards allocated / hour" });
  await expect(dialog).toContainText("approximate history");
  await dialog.getByRole("img").focus();
  await page.keyboard.press("End");
  await expect(dialog.locator(".pc-chart-inspect")).toContainText("partial");
  const downloadEvent = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download PNG" }).click();
  const download = await downloadEvent,
    png = await readFile((await download.path())!);
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  expect(png.readUInt32BE(16)).toBe(1800);
  await download.saveAs(
    `/tmp/paperclub-paper-allocation-${test.info().project.name}.png`,
  );
  await page.keyboard.press("Escape");
  await expect(expand).toBeFocused();
  expect(reads).toBeLessThanOrEqual(2);
  expect(walletReads).toEqual([]);
  await page.getByRole("button", { name: "24h", exact: true }).click();
  await paper.screenshot({
    path: `/tmp/paperclub-paper-economics-${test.info().project.name}.png`,
  });
  await hourly.screenshot({
    path: `/tmp/paperclub-paper-history-${test.info().project.name}.png`,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test("zero, unavailable and failed refresh stay distinct while PAPER keeps the last good response", async ({
  page,
}) => {
  const at = Date.now();
  await page.clock.install({ time: at });
  await mockSources(page);
  let failure = false,
    missing = false;
  await page.route("**/api/paper/economics", (route) => {
    if (failure)
      return route.fulfill({
        status: 503,
        json: { message: "Temporarily unavailable" },
      });
    const data = paperEconomicsResponse(at);
    data.supplyRaw = missing ? null : "0";
    data.stakedRaw = missing ? null : "0";
    data.allocatedRewardsRaw = missing ? null : "0";
    data.pendingRewardsRaw = missing ? null : "0";
    data.stakeRatioBps = null;
    data.annualized.usdPerYearRaw = null;
    for (const series of Object.values(data.series)) series.points = [];
    return route.fulfill({ json: data });
  });
  await page.goto("/");
  const paper = page.getByRole("region", {
    name: "PAPER economics",
    exact: true,
  });
  await expect(
    paper.locator(".paper-details .pc-chart-headline > strong"),
  ).toHaveText(["0", "0", "$0"]);
  await expect(paper).toContainText("Share unavailable");
  await expect(paper.locator(".paper-pending dd")).toHaveText("$0 USDC");
  failure = true;
  await page.clock.fastForward(30_000);
  await expect(paper.getByRole("status")).toContainText("Saved values shown");
  await expect(paper).toContainText("LAST AVAILABLE");
  await expect(
    paper.locator(".paper-details .pc-chart-headline > strong"),
  ).toHaveText(["0", "0", "$0"]);
  failure = false;
  missing = true;
  await page.clock.fastForward(30_000);
  await expect(
    paper.locator(".paper-details .pc-chart-headline > strong"),
  ).toHaveText(["—", "—", "—"]);
  await expect(paper.locator(".paper-pending dd")).toHaveText("— USDC");
});

test("an older API rollout leaves PAPER unavailable rather than borrowing House totals", async ({
  page,
}) => {
  await mockSources(page);
  await page.route("**/api/paper/economics", (route) =>
    route.fulfill({ status: 404, json: { message: "Not found" } }),
  );
  await page.goto("/?chart=staking-revenue&range=7d");
  const dialog = page.getByRole("dialog", { name: "Rewards allocated" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("7 days");
  await page.keyboard.press("Escape");
  const paper = page.getByRole("region", {
    name: "PAPER economics",
    exact: true,
  });
  await expect(paper.getByRole("status")).toContainText(
    "PAPER economics data is not available yet",
  );
  await expect(
    paper.locator(".paper-details .pc-chart-headline > strong"),
  ).toHaveText(["—", "—", "—"]);
});
