import { expect, test } from "@playwright/test";
import type { AnnualizedStakerYield } from "../../packages/shared/src/staking-yield";
import type { PaperPriceQuote } from "../../packages/shared/src/types";
import { mockSources, paperEconomicsResponse } from "./fixtures";

const at = Date.UTC(2026, 9, 10, 12, 25);
function measuredYield(raw: string | null = "25000000000000000", time = at): AnnualizedStakerYield {
  return {
    usdPerPaperPerYearRaw: raw,
    earnedUsdPerPaperRaw: "69206621004566",
    fromMs: time - 87_300_000,
    toMs: time,
    elapsedMs: 87_300_000,
    basis: "observed-accumulator",
    yearDays: 365,
  };
}
function priceQuote(time = at, raw = "500000000000000000"): PaperPriceQuote {
  return {
    source: "hyperliquid", market: "para:PAPER", basis: "perp-mid",
    priceUsdRaw: raw,
    bidUsdRaw: (BigInt(raw) - 1000000000000000n).toString(),
    askUsdRaw: (BigInt(raw) + 1000000000000000n).toString(),
    sourceAt: time, receivedAt: time,
  };
}

// The page and the PAPER section share one server snapshot; opening this metric
// must never introduce a wallet lookup or a visitor-specific exchange request.
test("live PAPER midpoint drives the top-line APR and retains the measured reward interval", async ({ page }) => {
  await page.clock.install({ time: at });
  await page.clock.pauseAt(new Date(at));
  await page.addInitScript(() => { Math.random = () => 0; });
  await mockSources(page);
  let reads = 0;
  const extraReads: string[] = [];
  let response = { ...paperEconomicsResponse(at), stakingYield: measuredYield(), paperPrice: priceQuote() };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/wallets/") || url.hostname.endsWith("hyperliquid.xyz")) extraReads.push(request.url());
  });
  await page.route("**/api/paper/economics", (route) => {
    reads++;
    return route.fulfill({ json: response });
  });
  await page.goto("/");
  const headline = page.locator(".metric-staker-yield");
  await expect(headline).toContainText("Staker yield / year");
  await expect(headline.locator("strong")).toHaveText("5.00%");
  await expect(headline).toContainText("Simple APR · observed rate");
  await expect(headline).toContainText("PAPER $0.5 · perp midpoint");
  await expect(headline.getByRole("link", { name: "Hyperliquid para:PAPER" })).toHaveAttribute("href", "https://app.hyperliquid.xyz/trade/para:PAPER");
  await expect(page.getByRole("textbox", { name: "PAPER price (USDC)" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Staker yield / year", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Rewards allocated chart card", exact: true })).toContainText("Lifetime");
  expect(reads).toBe(1);
  await headline.locator("summary").click();
  await expect(headline).toContainText("$25.00 USDC / 1,000 staked PAPER / year");
  await expect(headline).toContainText("24.25 hours measured, including partial hours");
  await expect(headline).toContainText("Oct 9, 2026, 12:10:00 UTC");
  await expect(headline).toContainText("Oct 10, 2026, 12:25:00 UTC");
  await expect(headline).toContainText("No compounding; future rewards vary");
  await headline.locator("summary").click();
  response = { ...paperEconomicsResponse(at + 6000), stakingYield: measuredYield(undefined, at + 6000), paperPrice: priceQuote(at + 6000, "250000000000000000") };
  await page.clock.fastForward(6000);
  await expect(headline.locator("strong")).toHaveText("10.00%");
  await expect(headline).toContainText("PAPER $0.25 · perp midpoint");
  expect(reads).toBe(2);
  expect(extraReads).toEqual([]);
  response = { ...paperEconomicsResponse(at + 12000), stakingYield: measuredYield("108590000000000000", at + 12000), paperPrice: priceQuote(at + 12000, "24700000000000000") };
  await page.clock.fastForward(6000);
  await expect(headline.locator("strong")).toHaveText("439.64%");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.locator(".overview-board").screenshot({ path: `/tmp/paperclub-staker-apr-${test.info().project.name}.png` });
});

test("zero rewards remain zero while missing or invalid prices and reward history remain unavailable", async ({ page }) => {
  await page.clock.install({ time: at });
  await page.clock.pauseAt(new Date(at));
  await page.addInitScript(() => { Math.random = () => 0; });
  await mockSources(page);
  let time = at;
  let yieldData: AnnualizedStakerYield | undefined = measuredYield("0");
  let quote: unknown = priceQuote();
  await page.route("**/api/paper/economics", (route) => route.fulfill({
    json: { ...paperEconomicsResponse(time), stakingYield: yieldData, paperPrice: quote },
  }));
  await page.goto("/");
  const headline = page.locator(".metric-staker-yield");
  await expect(headline.locator("strong")).toHaveText("0.00%");
  for (const invalid of [null, { ...priceQuote(), market: "PAPER" }, { ...priceQuote(), priceUsdRaw: "0" }, { ...priceQuote(), priceUsdRaw: "1" }, { ...priceQuote(), sourceAt: Number.MAX_SAFE_INTEGER }]) {
    quote = invalid;
    time += 6000;
    await page.clock.fastForward(6000);
    await expect(headline.locator("strong")).toHaveText("—");
    await expect(headline).toContainText("PAPER price unavailable");
    await expect(headline).not.toContainText("Price delayed");
  }
  quote = priceQuote(time + 6000);
  time += 6000;
  await page.clock.fastForward(6000);
  await expect(headline.locator("strong")).toHaveText("0.00%");
  yieldData = undefined;
  time += 6000;
  await page.clock.fastForward(6000);
  await expect(headline.locator("strong")).toHaveText("—");
  await expect(headline).toContainText("Waiting for reward observations");
  yieldData = { ...measuredYield(null), fromMs: at, elapsedMs: 0, reason: "Collecting the first hour of staking rewards." };
  time += 6000;
  await page.clock.fastForward(6000);
  await expect(headline).toContainText("Collecting the first hour of rewards");
  await expect(headline.locator("strong")).toHaveText("—");
});

test("reward and quote delays are independent and failed refreshes retain an explicitly last-available APR", async ({ page }) => {
  await page.clock.install({ time: at });
  await page.clock.pauseAt(new Date(at));
  await page.addInitScript(() => { Math.random = () => 0; });
  await mockSources(page);
  let fail = false;
  let response = { ...paperEconomicsResponse(at), stakingYield: measuredYield(), paperPrice: priceQuote(at - 60001) };
  await page.route("**/api/paper/economics", (route) => route.fulfill(fail
    ? { status: 503, json: { message: "Temporary failure" } }
    : { json: response }));
  await page.goto("/");
  const headline = page.locator(".metric-staker-yield");
  await expect(headline.locator("strong")).toHaveText("5.00%");
  await expect(headline).toContainText("Simple APR · last available");
  await expect(headline).toContainText("Price delayed");
  await expect(headline).not.toContainText("Rewards delayed");
  response = { ...paperEconomicsResponse(at - 31000), stakingYield: measuredYield(undefined, at - 31000), paperPrice: priceQuote(at + 6000) };
  await page.clock.fastForward(6000);
  await expect(headline).toContainText("Rewards delayed");
  await expect(headline).not.toContainText("Price delayed");
  fail = true;
  await page.clock.fastForward(6000);
  await expect(headline).toContainText("Simple APR · last available");
  await expect(headline.locator("strong")).toHaveText("5.00%");
  await page.clock.fastForward(61000);
  await expect(headline).toContainText("Price delayed");
  await expect(headline).toContainText("Rewards delayed");
  await expect(headline.locator("strong")).toHaveText("5.00%");
  fail = false;
  const now = await page.evaluate(() => Date.now());
  response = { ...paperEconomicsResponse(now), stakingYield: measuredYield(undefined, now), paperPrice: priceQuote(now) };
  await page.reload();
  await expect(headline).toContainText("Simple APR · observed rate");
  await expect(headline).not.toContainText("Price delayed");
  await expect(headline).not.toContainText("Rewards delayed");
});
