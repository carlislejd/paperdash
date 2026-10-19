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
  await expect(headline.locator(":scope > strong")).toHaveText("5.00%");
  const priceLink = headline.getByRole("link", { name: /^PAPER price/ });
  await expect(priceLink).toHaveText("PAPER price $0.5 ↗");
  await expect(priceLink).toHaveAttribute("href", "https://app.hyperliquid.xyz/trade/para:PAPER");
  await expect(page.getByRole("textbox", { name: "PAPER price (USDC)" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Staker yield / year", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Rewards allocated chart card", exact: true })).toContainText("Lifetime");
  expect(reads).toBe(1);
  await headline.getByRole("button", { name: "How staker yield is calculated" }).focus();
  const explanation = page.getByRole("tooltip");
  await expect(explanation).toBeVisible();
  await expect(explanation).toContainText("Simple APR · observed rate");
  await expect(explanation).toContainText("$25.00 USDC / 1,000 staked PAPER / year");
  await expect(explanation).toContainText("24.25 hours measured, including partial hours");
  await expect(explanation).toContainText("Oct 9, 2026, 12:10:00 UTC");
  await expect(explanation).toContainText("Oct 10, 2026, 12:25:00 UTC");
  await expect(explanation).toContainText("No compounding; future rewards vary");
  await expect(explanation).toContainText("midpoint of the best bid and ask");
  await page.keyboard.press("Escape");
  await expect(explanation).not.toBeVisible();
  response = { ...paperEconomicsResponse(at + 6000), stakingYield: measuredYield(undefined, at + 6000), paperPrice: priceQuote(at + 6000, "250000000000000000") };
  await page.clock.fastForward(6000);
  await expect(headline.locator(":scope > strong")).toHaveText("10.00%");
  await expect(priceLink).toHaveText("PAPER price $0.25 ↗");
  expect(reads).toBe(2);
  expect(extraReads).toEqual([]);
  response = { ...paperEconomicsResponse(at + 12000), stakingYield: measuredYield("108590000000000000", at + 12000), paperPrice: priceQuote(at + 12000, "24700000000000000") };
  await page.clock.fastForward(6000);
  await expect(headline.locator(":scope > strong")).toHaveText("439.64%");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.locator(".metrics-row > .metric").first().click();
  await expect(explanation).not.toBeVisible();
  await page.locator(".overview-board").screenshot({ path: `/tmp/paperclub-staker-apr-${test.info().project.name}.png` });
});

test("calculation help opens without stretching the top-line metrics and works with hover, keyboard and touch", async ({ page }, testInfo) => {
  await page.clock.install({ time: at });
  await page.clock.pauseAt(new Date(at));
  await mockSources(page);
  await page.route("**/api/paper/economics", (route) => route.fulfill({
    json: { ...paperEconomicsResponse(at), stakingYield: measuredYield(), paperPrice: priceQuote() },
  }));
  await page.goto("/");
  const headline = page.locator(".metric-staker-yield");
  const info = headline.getByRole("button", { name: "How staker yield is calculated" });
  const explanation = page.getByRole("tooltip");
  const board = page.locator(".overview-board");
  await expect(headline.locator(":scope > strong")).toHaveText("5.00%");
  await page.evaluate(() => document.fonts.ready);
  await expect(explanation).not.toBeVisible();
  await expect(headline.locator("summary")).toHaveCount(0);
  const before = (await board.boundingBox())!;
  const firstMetric = (await page.locator(".metrics-row > .metric").first().boundingBox())!;
  const price = (await headline.getByRole("link", { name: /^PAPER price/ }).boundingBox())!;
  // The sole note sits at the bottom of its metric, like the TVL note beside it.
  const yieldMetric = (await headline.boundingBox())!;
  expect(yieldMetric.y + yieldMetric.height - price.y - price.height).toBeLessThanOrEqual(1);
  expect(Math.abs(yieldMetric.height - firstMetric.height)).toBeLessThanOrEqual(1);
  if (testInfo.project.name === "desktop") {
    const notes = await page.locator(".metrics-row > .metric > .metric-note").evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().y),
    );
    expect(Math.max(...notes) - Math.min(...notes)).toBeLessThanOrEqual(1);
    await headline.getByRole("link", { name: /^PAPER price/ }).hover();
  } else {
    await info.tap();
  }
  await expect(explanation).toBeVisible();
  const open = (await board.boundingBox())!;
  expect(Math.abs(open.height - before.height)).toBeLessThanOrEqual(1);
  const tooltipBox = (await explanation.boundingBox())!;
  expect(tooltipBox.x).toBeGreaterThanOrEqual(0);
  expect(tooltipBox.x + tooltipBox.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: `/tmp/paperclub-staker-tooltip-${testInfo.project.name}.png` });
  await page.keyboard.press("Escape");
  await expect(explanation).not.toBeVisible();
  await page.mouse.move(0, 0);
  await page.locator(".metrics-row > .metric").first().click();
  await info.focus();
  await expect(info).toBeFocused();
  await expect(explanation).toBeVisible();
  await expect(info).toHaveAttribute("aria-describedby", await explanation.getAttribute("id") || "");
  await page.keyboard.press("Escape");
  await expect(explanation).not.toBeVisible();
  await expect(info).toBeFocused();
  await info.click();
  await expect(explanation).toBeVisible();
  await page.locator(".metrics-row > .metric").first().click();
  await expect(explanation).not.toBeVisible();
  const closed = (await board.boundingBox())!;
  expect(Math.abs(closed.height - before.height)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
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
  await expect(headline.locator(":scope > strong")).toHaveText("0.00%");
  for (const invalid of [null, { ...priceQuote(), market: "PAPER" }, { ...priceQuote(), priceUsdRaw: "0" }, { ...priceQuote(), priceUsdRaw: "1" }, { ...priceQuote(), sourceAt: Number.MAX_SAFE_INTEGER }]) {
    quote = invalid;
    time += 6000;
    await page.clock.fastForward(6000);
    await expect(headline.locator(":scope > strong")).toHaveText("—");
    await expect(headline).toContainText("PAPER price unavailable");
    await expect(headline).not.toContainText("Price delayed");
  }
  quote = priceQuote(time + 6000);
  time += 6000;
  await page.clock.fastForward(6000);
  await expect(headline.locator(":scope > strong")).toHaveText("0.00%");
  yieldData = undefined;
  time += 6000;
  await page.clock.fastForward(6000);
  await expect(headline.locator(":scope > strong")).toHaveText("—");
  await expect(headline).toContainText("Rewards unavailable");
  await headline.getByRole("button", { name: "How staker yield is calculated" }).focus();
  await expect(page.getByRole("tooltip")).toContainText("Waiting for staking reward observations");
  await page.keyboard.press("Escape");
  yieldData = { ...measuredYield(null), fromMs: at, elapsedMs: 0, reason: "Collecting the first hour of staking rewards." };
  time += 6000;
  await page.clock.fastForward(6000);
  await expect(headline).toContainText("Rewards pending");
  await expect(headline.locator(":scope > strong")).toHaveText("—");
  await headline.getByRole("link", { name: /^PAPER price/ }).focus();
  await expect(page.getByRole("tooltip")).toContainText("Collecting the first hour of staking rewards");
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
  await expect(headline.locator(":scope > strong")).toHaveText("5.00%");
  await headline.getByRole("button", { name: "How staker yield is calculated" }).focus();
  await expect(page.getByRole("tooltip")).toContainText("Simple APR · last available");
  await expect(headline.locator(".staker-yield-delayed")).toHaveText(/Price delayed$/);
  response = { ...paperEconomicsResponse(at - 31000), stakingYield: measuredYield(undefined, at - 31000), paperPrice: priceQuote(at + 6000) };
  await page.clock.fastForward(6000);
  await expect(headline.locator(".staker-yield-delayed")).toHaveText(/Rewards delayed$/);
  fail = true;
  await page.clock.fastForward(6000);
  await expect(page.getByRole("tooltip")).toContainText("Simple APR · last available");
  await expect(headline.locator(":scope > strong")).toHaveText("5.00%");
  await page.clock.fastForward(61000);
  await expect(headline.locator(".staker-yield-delayed")).toHaveText([/Price delayed$/, /Rewards delayed$/]);
  await expect(headline.locator(":scope > strong")).toHaveText("5.00%");
  fail = false;
  const now = await page.evaluate(() => Date.now());
  response = { ...paperEconomicsResponse(now), stakingYield: measuredYield(undefined, now), paperPrice: priceQuote(now) };
  await page.reload();
  await expect(headline.locator(".staker-yield-delayed")).toHaveCount(0);
  await headline.getByRole("button", { name: "How staker yield is calculated" }).focus();
  await expect(page.getByRole("tooltip")).toContainText("Simple APR · observed rate");
});
