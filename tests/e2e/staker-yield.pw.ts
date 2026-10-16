import { expect, test } from "@playwright/test";
import type { AnnualizedStakerYield } from "../../packages/shared/src/staking-yield";
import { mockSources, paperEconomicsResponse } from "./fixtures";

const at = Date.UTC(2026, 9, 10, 12, 25);
function measuredYield(raw: string | null = "25000000000000000"): AnnualizedStakerYield {
  return {
    usdPerPaperPerYearRaw: raw,
    earnedUsdPerPaperRaw: "69206621004566",
    fromMs: at - 87_300_000,
    toMs: at,
    elapsedMs: 87_300_000,
    basis: "observed-accumulator",
    yearDays: 365,
  };
}

test("staker yield leads the dashboard, includes partial hours and estimates APR at an explicit price", async ({ page }) => {
  await page.clock.install({ time: at });
  await page.clock.pauseAt(new Date(at));
  await mockSources(page);
  let reads = 0;
  const walletReads: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/wallets/")) walletReads.push(request.url());
  });
  await page.route("**/api/paper/economics", (route) => {
    reads++;
    return route.fulfill({ json: { ...paperEconomicsResponse(at), stakingYield: measuredYield() } });
  });
  await page.goto("/");
  const headline = page.locator(".metric-staker-yield");
  await expect(headline).toContainText("Staker yield / year");
  await expect(headline.locator("strong")).toHaveText("$25.00");
  await expect(headline).toContainText("USDC / 1K PAPER · observed rate");
  const detail = page.getByRole("region", { name: "Staker yield / year", exact: true });
  await expect(detail.locator(".staker-yield-value")).toHaveText("$25.00USDC / 1,000 staked PAPER");
  await expect(detail).toContainText("24.25 hours measured");
  await expect(detail).toContainText("Oct 9, 2026, 12:10:00 UTC");
  await expect(detail).toContainText("Oct 10, 2026, 12:25:00 UTC");
  await expect(detail).toContainText("Includes partial hours; retrospective run rate");
  const price = detail.getByRole("textbox", { name: "PAPER price (USDC)" });
  await expect(price).toHaveValue("");
  await expect(detail.locator(".staker-yield-apr strong")).toHaveText("—");
  await price.fill("0.50");
  await expect(detail.locator(".staker-yield-apr strong")).toHaveText("5.00%");
  await expect(detail).toContainText("Hypothetical price");
  await expect(detail).toContainText("No compounding");
  await expect(page.getByRole("region", { name: "Rewards allocated chart card", exact: true })).toContainText("Lifetime");
  expect(reads).toBe(1);
  expect(walletReads).toEqual([]);
  await detail.screenshot({ path: `/tmp/paperclub-staker-yield-${test.info().project.name}.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.clock.fastForward(31_000);
  await expect(headline).toContainText("Last available");
  await expect(detail).toContainText("Last available");
  await expect(headline.locator("strong")).toHaveText("$25.00");
  await expect(detail.locator(".staker-yield-apr strong")).toHaveText("5.00%");
});

test("invalid hypothetical prices, zero rewards, absent history and delayed data stay distinct", async ({ page }) => {
  await page.clock.install({ time: at });
  await page.clock.pauseAt(new Date(at));
  await page.addInitScript(() => { Math.random = () => 0; });
  await mockSources(page);
  let yieldData: AnnualizedStakerYield | undefined = measuredYield("0");
  let fail = false;
  await page.route("**/api/paper/economics", (route) => route.fulfill(fail
    ? { status: 503, json: { message: "Temporary failure" } }
    : { json: { ...paperEconomicsResponse(at), stakingYield: yieldData } }));
  await page.goto("/");
  const detail = page.getByRole("region", { name: "Staker yield / year", exact: true });
  const headline = page.locator(".metric-staker-yield");
  const price = detail.getByRole("textbox", { name: "PAPER price (USDC)" });
  await expect(headline.locator("strong")).toHaveText("$0.00");
  await price.fill("0.50");
  await expect(detail.locator(".staker-yield-apr strong")).toHaveText("0.00%");
  for (const invalid of ["0", "-0.50", "1e2", "0.0000000000000000001", "unknown"]) {
    await price.fill(invalid);
    await expect(price).toHaveAttribute("aria-invalid", "true");
    await expect(detail.locator(".staker-yield-apr strong")).toHaveText("—");
  }
  await price.fill("");
  await expect(price).toHaveAttribute("aria-invalid", "false");
  await price.fill("0.50");
  fail = true;
  await page.clock.fastForward(5000);
  await expect(headline).toContainText("Last available");
  await expect(detail).toContainText("Last available");
  await expect(headline.locator("strong")).toHaveText("$0.00");
  await expect(detail.locator(".staker-yield-apr strong")).toHaveText("0.00%");
  fail = false;
  yieldData = undefined;
  await page.clock.fastForward(30_000);
  await expect(headline.locator("strong")).toHaveText("—");
  await expect(detail.locator(".staker-yield-apr strong")).toHaveText("—");
  await expect(detail).toContainText("Waiting for staking reward observations");
  yieldData = { ...measuredYield(null), fromMs: at, elapsedMs: 0, reason: "Collecting the first hour of staking rewards." };
  await page.clock.fastForward(5000);
  await expect(detail).toContainText("Collecting the first hour of staking rewards");
});
