import { expect, test } from "@playwright/test";
import type { StakingRewardDay, StakingRewardHistory } from "../../packages/shared/src/types";
import { mockSources, paperEconomicsResponse } from "./fixtures";

const DAY = 86_400_000;
const at = Date.UTC(2026, 9, 19, 12, 34, 56);
const today = Date.UTC(2026, 9, 19);
function history(days: StakingRewardDay[]): StakingRewardHistory {
  return {
    basis: "observed-accumulator",
    timeZone: "UTC",
    days,
    observedFromMs: days[0]?.fromMs ?? null,
    availableFromMs: days[0]?.dayMs ?? null,
    truncated: false,
  };
}
function day(dayMs: number): StakingRewardDay {
  return {
    dayMs,
    fromMs: dayMs,
    toMs: dayMs + DAY,
    earnedUsdPer1kPaperRaw: "250000000000000000",
    partial: false,
    missing: false,
  };
}

test("daily staking rewards show measured amounts, partial intervals and unknown days with expandable history", async ({ page }, testInfo) => {
  await page.clock.install({ time: at });
  await page.clock.pauseAt(new Date(at));
  await mockSources(page);
  const days = Array.from({ length: 9 }, (_, index) => day(today - (8 - index) * DAY));
  days[5].earnedUsdPer1kPaperRaw = "0";
  days[6] = { ...days[6], fromMs: null, toMs: null, earnedUsdPer1kPaperRaw: null, partial: true, missing: true };
  days[8] = {
    ...days[8], fromMs: today + 6 * 3_600_000, toMs: at,
    earnedUsdPer1kPaperRaw: "3453000000000000", partial: true,
  };
  let reads = 0;
  await page.route("**/api/paper/economics", route => {
    reads++;
    return route.fulfill({ json: { ...paperEconomicsResponse(at), stakingRewardHistory: history(days) } });
  });
  await page.goto("/");
  const panel = page.getByRole("region", { name: "Daily staking rewards", exact: true });
  const rows = panel.locator("tbody tr");
  await expect(rows).toHaveCount(7);
  await expect(rows.first().getByRole("rowheader")).toHaveText("19 Oct");
  await expect(rows.last().getByRole("rowheader")).toHaveText("13 Oct");
  await expect(rows.first().locator(".staking-reward-amount")).toHaveText("$0.003453");
  await expect(rows.first()).toContainText("Partial day");
  await expect(rows.first()).toContainText("06:00:00–12:34:56");
  await expect(rows.first().locator(".staking-reward-amount")).toHaveAttribute("title", "0.003453 USDC per 1,000 staked PAPER");
  await expect(rows.filter({ hasText: "16 Oct" }).locator(".staking-reward-amount")).toHaveText("$0.00");
  const missing = rows.filter({ hasText: "17 Oct" });
  await expect(missing.locator(".staking-reward-amount")).toHaveText("—");
  await expect(missing).toContainText("Unavailable");
  await expect(rows.last()).toContainText("Full UTC day");
  await expect(panel).toContainText("Partial days are not full-day rates");
  await expect(panel).not.toContainText("Annualized");
  const before = reads;
  await panel.getByRole("button", { name: "Show all 9 days" }).click();
  await expect(rows).toHaveCount(9);
  await expect(rows.last().getByRole("rowheader")).toHaveText("11 Oct");
  await expect(panel.getByRole("button", { name: "Show latest 7 days" })).toHaveAttribute("aria-expanded", "true");
  await panel.getByRole("button", { name: "Show latest 7 days" }).click();
  await expect(rows).toHaveCount(7);
  expect(reads).toBe(before);
  await panel.screenshot({ path: `/tmp/paperclub-staking-reward-history-${testInfo.project.name}.png` });
  await page.getByRole("region", { name: "House and PAPER statistics" }).screenshot({ path: `/tmp/paperclub-house-reward-history-${testInfo.project.name}.png` });
  for (const width of testInfo.project.name === "desktop" ? [1440, 1024, 720, 320] : [393]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
});

test("the first UTC midnight keeps a one-sample day unknown and failed refresh marks saved observations stale", async ({ page }) => {
  const midnight = Date.UTC(2026, 9, 20);
  const clock = midnight + 5_000;
  await page.clock.install({ time: clock });
  await page.clock.pauseAt(new Date(clock));
  await page.addInitScript(() => { Math.random = () => 0; });
  await mockSources(page);
  let failure = false;
  await page.route("**/api/paper/economics", route => failure
    ? route.fulfill({ status: 503, json: { message: "Temporarily unavailable" } })
    : route.fulfill({ json: {
      ...paperEconomicsResponse(clock),
      stakingRewardHistory: history([
        { ...day(today), fromMs: today + 12 * 3_600_000, toMs: midnight + 3_000, partial: true },
        { ...day(midnight), fromMs: midnight + 3_000, toMs: midnight + 3_000, earnedUsdPer1kPaperRaw: null, partial: true, missing: true },
      ]),
    } }));
  await page.goto("/");
  const panel = page.getByRole("region", { name: "Daily staking rewards", exact: true });
  await expect(panel.locator("tbody tr")).toHaveCount(2);
  await expect(panel.locator("tbody tr").last()).toContainText("12:00:00–20 Oct 00:00:03");
  await expect(panel.locator("tbody tr").first().getByRole("rowheader")).toHaveText("20 Oct");
  await expect(panel.locator("tbody tr").first().locator(".staking-reward-amount")).toHaveText("—");
  await expect(panel.locator(".staking-reward-history-status")).toContainText("Updated · Just now");
  failure = true;
  await page.clock.fastForward(65_000);
  await expect(panel.locator(".staking-reward-history-status")).toContainText("Last available · 1m ago");
  await expect(panel.locator("tbody tr").last().locator(".staking-reward-amount")).toHaveText("$0.25");
  await expect(panel.locator("tbody tr").first().locator(".staking-reward-amount")).toHaveText("—");
  await expect(panel).toContainText("Tracking since 19 Oct 2026, 12:00 UTC");
});

test("bounded history labels its retained window and can expand all 365 days", async ({ page }) => {
  await page.clock.install({ time: at });
  await page.clock.pauseAt(new Date(at));
  await mockSources(page);
  const days = Array.from({ length: 365 }, (_, index) => day(today - (365 - index) * DAY));
  await page.route("**/api/paper/economics", route => route.fulfill({ json: {
    ...paperEconomicsResponse(at),
    stakingRewardHistory: { ...history(days), truncated: true, observedFromMs: days[0].dayMs - 30 * DAY },
  } }));
  await page.goto("/");
  const panel = page.getByRole("region", { name: "Daily staking rewards", exact: true });
  await expect(panel.locator("tbody tr")).toHaveCount(7);
  await expect(panel).toContainText("Last 365 UTC days available in this view");
  await panel.getByRole("button", { name: "Show all 365 days" }).click();
  await expect(panel.locator("tbody tr")).toHaveCount(365);
  await panel.getByRole("button", { name: "Show latest 7 days" }).click();
  await expect(panel.locator("tbody tr")).toHaveCount(7);
});
