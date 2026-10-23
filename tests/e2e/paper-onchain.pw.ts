import { expect, test } from "@playwright/test";
import type { PaperEconomicsResponse } from "../../packages/shared/src/types";
import { mockSources, paperEconomicsResponse } from "./fixtures";

const at = Date.UTC(2026, 9, 22, 12, 25);
const day = Date.UTC(2026, 9, 22);
const raw = (amount: number) => (BigInt(amount) * 10n ** 18n).toString();

test("chain balances and rewards age independently while protocol allocations and history remain delayed", async ({ page }, testInfo) => {
  await page.clock.install({ time: at });
  await page.clock.pauseAt(new Date(at));
  await page.addInitScript(() => { Math.random = () => 0; });
  await mockSources(page);
  const response: PaperEconomicsResponse = {
    ...paperEconomicsResponse(at - 120_000),
    stale: true,
    error: "Protocol summary collection is delayed.",
    supplyRaw: raw(1_500_000), stakedRaw: raw(900_000), stakeRatioBps: 6000,
    onchain: {
      source: "hyperevm-rpc", chainId: 999, consistency: "atomic-multicall",
      blockNumber: "49266474", blockHash: `0x${"a".repeat(64)}`,
      blockTimestampMs: at + 1000,
      sourceAt: at, receivedAt: at, stale: false, accumulatorRaw: "1000000000000000000000000",
    },
    stakingYield: {
      usdPerPaperPerYearRaw: "25000000000000000", earnedUsdPerPaperRaw: "69206621004566",
      fromMs: at - 87_300_000, toMs: at, elapsedMs: 87_300_000,
      basis: "observed-accumulator", yearDays: 365,
    },
    stakingRewardHistory: {
      basis: "observed-accumulator", timeZone: "UTC", truncated: false,
      observedFromMs: day + 3_600_000, availableFromMs: day,
      days: [{
        source: "hyperevm-rpc", dayMs: day, fromMs: day + 3_600_000, toMs: at,
        earnedUsdPer1kPaperRaw: "250000000000000000", partial: true, missing: false,
        participation: {
          supplyFromRaw: raw(1_400_000), supplyToRaw: raw(1_500_000),
          stakedFromRaw: raw(850_000), stakedToRaw: raw(900_000),
        },
      }],
    },
  };
  let reads = 0;
  const forbiddenReads: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/wallets/") || url.hostname.endsWith("hyperliquid.xyz"))
      forbiddenReads.push(request.url());
  });
  // Every read intentionally returns the original clocks and stale=false chain
  // flag. Browser expiry must not be refreshed by transport or API clocks.
  await page.route("**/api/paper/economics", route => {
    reads++;
    return route.fulfill({ json: response });
  });
  await page.goto("/");
  const paper = page.getByRole("region", { name: "PAPER economics", exact: true });
  const headline = page.locator(".metric-staker-yield");
  const rewards = paper.getByRole("region", { name: "Daily staking rewards", exact: true });
  const allocation = paper.getByRole("region", { name: "Staker revenue", exact: true });
  const supply = paper.getByRole("region", { name: "PAPER supply chart card", exact: true });
  const staked = paper.getByRole("region", { name: "PAPER staked chart card", exact: true });
  const allocatedChart = paper.getByRole("region", { name: "Rewards allocated chart card", exact: true });
  await expect(headline.locator(":scope > strong")).toHaveText("$25.00");
  await expect(headline.locator(".staker-yield-delayed")).toHaveCount(0);
  await expect(supply.locator(".pc-chart-headline > strong")).toHaveText("1.5M");
  await expect(staked.locator(".pc-chart-headline > strong")).toHaveText("900K");
  await expect(supply.locator(".pc-chart-headline")).toContainText("Onchain");
  await expect(staked.locator(".pc-chart-headline")).toContainText("60.00% of supply · Onchain");
  await expect(supply.locator(".pc-chart-headline")).not.toContainText("last available");
  await expect(rewards.locator(".staking-reward-history-status")).toContainText("Updated");
  await expect(rewards.locator(".staking-reward-amount")).toHaveText("$0.25");
  await expect(allocation.locator(".staker-revenue-status")).toContainText("Last available");
  await expect(allocatedChart.locator(".pc-chart-footer")).toContainText("Last available");
  // These plots still show API history, independently of the onchain headlines.
  await expect(supply.locator(".pc-chart-footer")).toContainText("Last available");
  await expect(paper.getByRole("status")).toContainText("Protocol allocations and history are delayed");
  expect(reads).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await paper.screenshot({ path: `/tmp/paperclub-onchain-fresh-${testInfo.project.name}.png` });

  await page.clock.fastForward(95_000);
  await expect(headline.locator(".staker-yield-delayed")).toHaveText(/Rewards delayed$/);
  await expect(supply.locator(".pc-chart-headline")).toContainText("Onchain · last available");
  await expect(staked.locator(".pc-chart-headline")).toContainText("Onchain · last available");
  await expect(rewards.locator(".staking-reward-history-status")).toContainText("Last available");
  await expect(allocation.locator(".staker-revenue-status")).toContainText("Last available");
  await expect(headline.locator(":scope > strong")).toHaveText("$25.00");
  await expect(supply.locator(".pc-chart-headline > strong")).toHaveText("1.5M");
  await expect(rewards.locator(".staking-reward-amount")).toHaveText("$0.25");
  expect(forbiddenReads).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await paper.screenshot({ path: `/tmp/paperclub-onchain-delayed-${testInfo.project.name}.png` });
});
