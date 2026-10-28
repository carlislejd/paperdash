import { expect, test, type Locator } from "@playwright/test";
import type { PaperEconomicsResponse } from "../../packages/shared/src/types";
import { allocationRateResponse, mockSources, paperEconomicsResponse } from "./fixtures";

// Exactly 24.25 hours after the verified trading-window start. The partial
// hour must participate in the annual rate, rather than rounding to a day.
const at = Date.UTC(2026, 9, 11, 14, 15);

function metric(panel: Locator, name: "Total allocated" | "Annualized") {
  return panel.locator("dl > div").filter({
    has: panel.page().locator("dt", { hasText: new RegExp(`^${name}$`) }),
  }).locator("dd > strong");
}

test("staker revenue highlights protocol-wide total and annual run rate from the shared PAPER response", async ({ page }) => {
  await page.clock.install({ time: at });
  await page.clock.pauseAt(new Date(at));
  await page.addInitScript(() => { Math.random = () => 0; });
  await mockSources(page);
  let reads = 0;
  const extraReads: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/wallets/") || url.hostname.endsWith("hyperliquid.xyz"))
      extraReads.push(request.url());
  });
  await page.route("**/api/paper/economics", route => {
    reads++;
    return route.fulfill({ json: { ...paperEconomicsResponse(at), annualized: allocationRateResponse(at) } });
  });
  await page.goto("/");
  const paper = page.getByRole("region", { name: "PAPER economics", exact: true });
  const panel = paper.getByRole("region", { name: "Staker revenue", exact: true });
  await expect(panel.getByRole("heading", { name: "Staker revenue", exact: true })).toBeVisible();
  await expect(panel.locator("dt")).toHaveText(["Total allocated", "Annualized"]);
  await expect(metric(panel, "Total allocated")).toHaveText("$16.27K");
  await expect(metric(panel, "Annualized")).toHaveText("$5.88M");
  await expect(panel).toContainText("USDC allocated to stakers");
  await expect(panel).toContainText("Updated · Just now");
  // The investor-sized reward metric remains distinct from protocol revenue.
  await expect(page.locator(".metric-staker-yield")).toContainText("USDC / 1K staked PAPER");
  const daily = page.getByRole("region", { name: "Daily staking rewards", exact: true });
  await expect(daily).toContainText("Earlier daily history is unavailable");
  await expect(daily.getByRole("table")).toHaveCount(0);
  expect((await panel.boundingBox())!.y).toBeLessThan((await daily.boundingBox())!.y);
  expect(reads).toBe(1);

  await panel.getByRole("button", { name: "How staker revenue is calculated" }).focus();
  const explanation = panel.getByRole("tooltip");
  await expect(explanation).toBeVisible();
  await expect(explanation).toContainText("24.25 hours");
  await expect(explanation).toContainText("Oct 10, 2026, 14:00:00 UTC");
  await expect(explanation).toContainText("Oct 11, 2026, 14:15:00 UTC");
  await expect(explanation).toContainText("Total allocated ÷ elapsed hours × 24 × 365");
  await expect(explanation).toContainText("Average daily allocations: $16,103.26 USDC");
  await expect(explanation).toContainText(/unclaimed/i);
  await expect(explanation).toContainText(/not a forecast/i);
  expect(reads).toBe(1);
  await page.clock.fastForward(6000);
  await expect.poll(() => reads).toBe(2);
  await expect(metric(panel, "Annualized")).toHaveText("$5.88M");
  expect(extraReads).toEqual([]);
});

test("revenue calculation help supports mouse, keyboard and touch without shifting or overflowing its card", async ({ page }, testInfo) => {
  await page.clock.install({ time: at });
  await page.clock.pauseAt(new Date(at));
  await mockSources(page);
  await page.route("**/api/paper/economics", route => route.fulfill({ json: paperEconomicsResponse(at) }));
  await page.goto("/");
  const panel = page.getByRole("region", { name: "Staker revenue", exact: true });
  const info = panel.getByRole("button", { name: "How staker revenue is calculated" });
  const explanation = panel.getByRole("tooltip");
  const daily = page.getByRole("region", { name: "Daily staking rewards", exact: true });
  const paperHeading = page.getByRole("region", { name: "PAPER economics", exact: true }).getByRole("heading", { name: "PAPER", exact: true });
  await expect(metric(panel, "Annualized")).toHaveText("$5.88M");
  await page.evaluate(() => document.fonts.ready);
  await expect(explanation).not.toBeVisible();
  const before = (await panel.boundingBox())!;
  const dailyBefore = (await daily.boundingBox())!;
  if (testInfo.project.name === "mobile") await info.tap();
  else await info.hover();
  await expect(explanation).toBeVisible();
  expect(Math.abs((await panel.boundingBox())!.height - before.height)).toBeLessThanOrEqual(1);
  // Opening help may scroll the page, so compare the relative card positions.
  expect(Math.abs(
    ((await daily.boundingBox())!.y - (await panel.boundingBox())!.y) -
    (dailyBefore.y - before.y),
  )).toBeLessThanOrEqual(1);
  const tooltipBox = (await explanation.boundingBox())!;
  expect(tooltipBox.x).toBeGreaterThanOrEqual(0);
  expect(tooltipBox.x + tooltipBox.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: `/tmp/paperclub-staker-revenue-tooltip-${testInfo.project.name}.png` });
  await page.keyboard.press("Escape");
  await expect(explanation).not.toBeVisible();
  await page.mouse.move(0, 0);
  await paperHeading.click();
  await info.focus();
  await expect(info).toBeFocused();
  await expect(explanation).toBeVisible();
  await expect(info).toHaveAttribute("aria-describedby", (await explanation.getAttribute("id"))!);
  await page.keyboard.press("Escape");
  await expect(explanation).not.toBeVisible();
  await expect(info).toBeFocused();
  await info.click();
  await expect(explanation).toBeVisible();
  await paperHeading.click();
  await expect(explanation).not.toBeVisible();
  await panel.screenshot({ path: `/tmp/paperclub-staker-revenue-${testInfo.project.name}.png` });
  for (const width of testInfo.project.name === "desktop" ? [1440, 1024, 720, 320] : [393]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
});

test("measured zero revenue stays zero while missing totals and unavailable annualization remain unknown", async ({ page }) => {
  await page.clock.install({ time: at });
  await page.clock.pauseAt(new Date(at));
  await mockSources(page);
  let mode: "zero" | "missing" | "rate-unavailable" = "zero";
  await page.route("**/api/paper/economics", route => {
    const data = paperEconomicsResponse(at);
    if (mode === "zero") {
      data.allocatedRewardsRaw = "0";
      data.annualized = {
        ...allocationRateResponse(at), lifetimeRewardsRaw: "0", allocatedSinceStartRaw: "0",
        usdPerDayRaw: "0", usdPerYearRaw: "0",
      };
    } else if (mode === "missing") {
      data.allocatedRewardsRaw = null;
      data.annualized.usdPerYearRaw = null;
    } else data.annualized.usdPerYearRaw = null;
    return route.fulfill({ json: data });
  });
  await page.goto("/");
  const panel = page.getByRole("region", { name: "Staker revenue", exact: true });
  await expect(metric(panel, "Total allocated")).toHaveText("$0");
  await expect(metric(panel, "Annualized")).toHaveText("$0");
  mode = "missing";
  await page.reload();
  await expect(metric(panel, "Total allocated")).toHaveText("—");
  await expect(metric(panel, "Annualized")).toHaveText("—");
  mode = "rate-unavailable";
  await page.reload();
  await expect(metric(panel, "Total allocated")).toHaveText("$16.27K");
  await expect(metric(panel, "Annualized")).toHaveText("—");
});

test("legacy and inconsistent annual rates cannot borrow the verified trading interval or daily history", async ({ page }) => {
  await page.clock.install({ time: at });
  await page.clock.pauseAt(new Date(at));
  await mockSources(page);
  let mode: "legacy" | "missing-baseline" | "mismatched-clock" = "legacy";
  await page.route("**/api/paper/economics", route => {
    const data = paperEconomicsResponse(at);
    if (mode === "legacy") {
      data.annualized.basis = "protocol-lifetime";
      delete data.annualized.cutoffBasis;
    } else if (mode === "missing-baseline") delete data.annualized.baselineRewardsRaw;
    else data.annualized.toMs = at + 1;
    return route.fulfill({ json: data });
  });
  await page.goto("/");
  const panel = page.getByRole("region", { name: "Staker revenue", exact: true });
  for (const next of ["legacy", "missing-baseline", "mismatched-clock"] as const) {
    if (mode !== next) {
      mode = next;
      await page.reload();
    }
    await expect(metric(panel, "Total allocated")).toHaveText("$16.27K");
    await expect(metric(panel, "Annualized")).toHaveText("—");
    await panel.getByRole("button", { name: "How staker revenue is calculated" }).focus();
    await expect(panel.getByRole("tooltip")).not.toContainText("24.25 hours");
    await expect(panel.getByRole("tooltip")).not.toContainText("Oct 10, 2026, 14:00:00 UTC");
    await expect(page.getByRole("region", { name: "Daily staking rewards", exact: true }).getByRole("table")).toHaveCount(0);
  }
});

test("unchanged source clocks age in place and failed refresh preserves explicitly last-available revenue", async ({ page }) => {
  await page.clock.install({ time: at });
  await page.clock.pauseAt(new Date(at));
  await page.addInitScript(() => { Math.random = () => 0; });
  await mockSources(page);
  let failure = false;
  let reads = 0;
  await page.route("**/api/paper/economics", route => {
    reads++;
    return route.fulfill(failure
      ? { status: 503, json: { message: "Temporary failure" } }
      : { json: paperEconomicsResponse(at) });
  });
  await page.goto("/");
  const panel = page.getByRole("region", { name: "Staker revenue", exact: true });
  await expect(panel).toContainText("Updated · Just now");
  await page.clock.fastForward(35_000);
  await expect(panel).toContainText("Last available · 35s ago");
  await expect(metric(panel, "Annualized")).toHaveText("$5.88M");
  const before = reads;
  failure = true;
  await page.clock.fastForward(6000);
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(page.getByRole("region", { name: "PAPER economics", exact: true }).getByRole("status")).toContainText("Saved values shown");
  await expect(panel).toContainText("Last available");
  await expect(metric(panel, "Total allocated")).toHaveText("$16.27K");
  await expect(metric(panel, "Annualized")).toHaveText("$5.88M");
});

test("stale payloads and incoherent receipt clocks cannot present saved revenue as current", async ({ page }) => {
  await page.clock.install({ time: at });
  await page.clock.pauseAt(new Date(at));
  await mockSources(page);
  let response: PaperEconomicsResponse = { ...paperEconomicsResponse(at), stale: true };
  await page.route("**/api/paper/economics", route => route.fulfill({ json: response }));
  await page.goto("/");
  const panel = page.getByRole("region", { name: "Staker revenue", exact: true });
  for (const replacement of [
    { ...paperEconomicsResponse(at), stale: true },
    { ...paperEconomicsResponse(at), error: "Source temporarily unavailable" },
    { ...paperEconomicsResponse(at), receivedAt: at - 30_001 },
    { ...paperEconomicsResponse(at), receivedAt: at + 30_001 },
    paperEconomicsResponse(at + 30_001),
  ]) {
    response = replacement;
    await page.reload();
    await expect(panel).toContainText("Last available");
    await expect(panel).not.toContainText("Updated ·");
    await expect(metric(panel, "Total allocated")).toHaveText("$16.27K");
  }
  response = { ...paperEconomicsResponse(at), sourceAt: null };
  await page.reload();
  await expect(panel).toContainText("Awaiting data");
  await expect(metric(panel, "Total allocated")).toHaveText("$16.27K");
  await expect(metric(panel, "Annualized")).toHaveText("—");
});
