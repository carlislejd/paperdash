import { expect, test, type Page, type Route } from "@playwright/test";
import type {
  AssetMarketResponse,
  MarketWindow,
  TradeEvent,
} from "../../packages/shared/src/types";
import { marketResponse, mockSources, WALLET } from "./fixtures";

const NOW = Date.UTC(2026, 9, 16, 16);
const losingWallet = `0x${"b".repeat(40)}`;
const durations = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000 };
const entry = (id: string, notionalUsd = 50): TradeEvent => ({
  id,
  ts: NOW - 30_000,
  wallet: WALLET,
  instrument: 0,
  side: "long",
  leverage: 10,
  notionalUsd,
  kind: "open",
  pnlUsd: null,
  priceUsd: 82_010,
  provenance: "public-stream",
});
const profitableEntries = () =>
  [50, 4_000, 80_000, 130_000, 670_000, 1_500].map((notionalUsd, index) => ({
    ...entry(index ? `profitable-entry-${index}` : "small-profitable-entry", notionalUsd),
    ts: NOW - [30, 140, 280, 420, 600, 800][index] * 1_000,
    priceUsd: 82_000 + index * 30,
    side: index % 2 ? "short" as const : "long" as const,
  }));
function response(
  profitable = false,
  window: MarketWindow = "15m",
  trades = profitable
    ? profitableEntries()
    : [{ ...entry("large-losing-entry", 10_000_000), wallet: losingWallet }],
): AssetMarketResponse {
  return {
    ...marketResponse(0, false, NOW),
    segment: profitable ? "profitable" : "all",
    ...(profitable
      ? {
          segmentCoverage: {
            basis: "positive-lifetime-realized-trading-pnl" as const,
            minPnlUsd: 1000 as const,
            classifiedAt: NOW,
            maxAccountAgeMs: 300_000,
            observedWallets: 3,
            classifiedWallets: 2,
            profitableWallets: 1,
            unknownWallets: 1,
            oldestAccountReceivedAt: NOW - 60_000,
            newestAccountReceivedAt: NOW - 5_000,
          },
        }
      : {}),
    trades,
    chartSample: {
      windowFrom: NOW - durations[window],
      windowTo: NOW,
      bucketMs: durations[window] / 30,
      perBucket: 2,
      selection: "largest-notional-per-time-bucket",
      partial: true,
      trades,
    },
  };
}

async function setup(page: Page) {
  await page.clock.install({ time: NOW });
  await page.clock.pauseAt(new Date(NOW));
  await page.addInitScript(() => {
    Math.random = () => 0;
    const sources: {
      closed: boolean;
      onmessage?: (event: { data: string }) => void;
    }[] = [];
    class MockEventSource {
      closed = false;
      onopen: (() => void) | null = null;
      onmessage?: (event: { data: string }) => void;
      constructor() {
        sources.push(this);
        queueMicrotask(() => this.onopen?.());
      }
      close() {
        this.closed = true;
      }
    }
    Object.assign(window, {
      EventSource: MockEventSource,
      emitDashboard: (message: unknown) => {
        for (const source of sources)
          if (!source.closed)
            source.onmessage?.({ data: JSON.stringify(message) });
      },
    });
  });
  await mockSources(page);
}

const send = (page: Page, message: unknown) =>
  page.evaluate((payload) => {
    (window as unknown as { emitDashboard: (message: unknown) => void })
      .emitDashboard(payload);
  }, message);

test("profitable entries include small trades, explain current classification, and preserve chart controls", async ({ page }) => {
  await setup(page);
  const requests: string[] = [];
  await page.route("**/api/assets/0/market*", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.search);
    const window = url.searchParams.get("window") as MarketWindow;
    const profitable = url.searchParams.get("segment") === "profitable";
    // A defensive close row must not slip through the entry-only client view.
    const data = response(profitable, window);
    if (profitable) data.trades.push({ ...entry("unexpected-close"), kind: "close" });
    await route.fulfill({ json: data });
  });
  await page.goto("/?view=assets&asset=0");
  const panel = page.getByRole("region", { name: "BTC price and trades" });
  const segment = panel.getByRole("button", { name: "Profitable traders", exact: true });
  await expect(segment).toHaveAttribute("aria-pressed", "false");
  await expect(panel.locator('[data-trade-id="large-losing-entry"]')).toHaveCount(1);
  await segment.click();
  await expect(panel.getByRole("combobox", { name: "Minimum realized profit" })).toHaveValue("1000");
  await expect(panel.locator('[data-trade-id="small-profitable-entry"]')).toHaveCount(1);
  await expect(panel.locator('[data-trade-id="large-losing-entry"]')).toHaveCount(0);
  await expect(panel.locator('[data-trade-id="unexpected-close"]')).toHaveCount(0);
  await expect(panel).toContainText("$50");
  await expect(panel).toContainText("Rewards and unrealized P&L excluded");
  await expect(panel).toContainText("not profitability at entry");
  const coverage = panel.getByLabel("Trader profit coverage", { exact: true });
  await expect(coverage).toContainText("Profit checked for 2 of 3 wallets");
  await expect(coverage).toContainText("Opening wallets · past hour · 66.7%");
  await expect(coverage).toContainText("1 unknown wallet excluded; more may qualify");
  await expect(panel.locator(".trade-graph-feed h4")).toContainText("Profitable trader entries");
  await expect(page.getByText("All traders · retained observations · rolling 24h")).toBeVisible();
  await panel.getByRole("button", { name: "Pause chart", exact: true }).click();
  await expect(segment).toBeDisabled();
  await expect(panel.getByRole("combobox", { name: "Minimum realized profit" })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "5m", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "Resume live chart", exact: true }).click();
  for (const window of ["5m", "1h", "15m"]) {
    await panel.getByRole("button", { name: window, exact: true }).click();
    await expect.poll(() => requests).toContain(`?window=${window}&segment=profitable&minPnl=1000`);
    await expect(panel.getByRole("button", { name: window, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(panel.locator('[data-trade-id="small-profitable-entry"]')).toHaveCount(1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.mouse.move(0, 0);
  await panel.screenshot({ path: test.info().outputPath("profitable-traders.png") });
  await panel.locator('[data-trade-id="small-profitable-entry"]').getByRole("button", { name: /^View wallet/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await panel.getByRole("button", { name: "All traders", exact: true }).click();
  await expect(panel.locator('[data-trade-id="large-losing-entry"]')).toHaveCount(1);
  await expect(panel.locator('[data-trade-id="small-profitable-entry"]')).toHaveCount(0);
  await page.getByRole("button", { name: "ETH Ethereum", exact: true }).click();
  await expect(page.getByRole("button", { name: "All traders", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-trade-id="small-profitable-entry"]')).toHaveCount(0);
});

test("raw stream trades cannot enter the profitable cohort until a classified snapshot includes them", async ({ page }) => {
  await setup(page);
  let classified = [entry("small-profitable-entry")];
  await page.route("**/api/assets/0/market*", async (route) => {
    const url = new URL(route.request().url());
    const profitable = url.searchParams.get("segment") === "profitable";
    await route.fulfill({ json: response(profitable, "15m", profitable ? classified : undefined) });
  });
  await page.goto("/?view=assets&asset=0");
  const panel = page.getByRole("region", { name: "BTC price and trades" });
  const segment = panel.getByRole("button", { name: "Profitable traders", exact: true });
  await expect(panel.locator('[data-trade-id="large-losing-entry"]')).toHaveCount(1);
  await send(page, { type: "trade", data: entry("prior-stream-entry", 5_000) });
  await expect(panel.locator('[data-trade-id="prior-stream-entry"]')).toHaveCount(1);
  await segment.click();
  await expect(panel.locator('[data-trade-id="small-profitable-entry"]')).toHaveCount(1);
  await expect(panel.locator('[data-trade-id="prior-stream-entry"]')).toHaveCount(0);
  const pending = entry("unclassified-stream-entry", 500_000);
  await send(page, { type: "trade", data: pending });
  await send(page, { type: "trade", data: { ...entry("unknown-stream-entry", 999_999), wallet: losingWallet } });
  await send(page, { type: "asset-price", data: { instrument: 0, point: { time: NOW + 1, priceUsd: 83_000 }, receivedAt: NOW + 1 } });
  await expect(panel.locator(".trade-graph-price")).toHaveText("$83,000.00");
  await expect(panel.locator('[data-trade-id="unclassified-stream-entry"]')).toHaveCount(0);
  await expect(panel.locator('[data-trade-id="unknown-stream-entry"]')).toHaveCount(0);
  classified = [...classified, pending];
  await page.clock.fastForward(5_001);
  await expect(panel.locator('[data-trade-id="unclassified-stream-entry"]')).toHaveCount(1);
  await expect(panel.locator('[data-trade-id="unknown-stream-entry"]')).toHaveCount(0);
  await panel.getByRole("button", { name: "All traders", exact: true }).click();
  await expect(panel.locator('[data-trade-id="unknown-stream-entry"]')).toHaveCount(1);
  await segment.click();
  await expect(panel.locator('[data-trade-id="unknown-stream-entry"]')).toHaveCount(0);
  await expect(panel.locator('[data-trade-id="unclassified-stream-entry"]')).toHaveCount(1);
});

test("legacy, mismatched, expired and failed classification responses fail closed", async ({ page }) => {
  await setup(page);
  let data = response(true);
  let failed = false;
  await page.route("**/api/assets/0/market*", async (route) => {
    if (!new URL(route.request().url()).searchParams.has("segment")) {
      await route.fulfill({ json: response() });
      return;
    }
    await route.fulfill(failed ? { status: 503, json: { error: "Unavailable" } } : { json: data });
  });
  await page.goto("/?view=assets&asset=0");
  const panel = page.getByRole("region", { name: "BTC price and trades" });
  await panel.getByRole("button", { name: "Profitable traders", exact: true }).click();
  await expect(panel.locator('[data-trade-id="small-profitable-entry"]')).toHaveCount(1);
  for (const invalid of [
    { ...response(true), segment: undefined, segmentCoverage: undefined },
    { ...response(true), segment: "all" as const },
    { ...response(true), instrument: 1 },
    { ...response(true), segmentCoverage: { ...response(true).segmentCoverage!, minPnlUsd: undefined } },
    { ...response(true), segmentCoverage: { ...response(true).segmentCoverage!, minPnlUsd: 10000 as const } },
    { ...response(true), segmentCoverage: { ...response(true).segmentCoverage!, classifiedAt: NOW - 60_001 } },
  ]) {
    data = invalid;
    await page.clock.fastForward(5_001);
    await expect(panel.locator("li[data-trade-id]")).toHaveCount(0);
    await expect(panel).toContainText("Waiting for a recent trader classification");
    await expect(panel.getByLabel("Trader profit coverage", { exact: true })).toContainText("Profit coverage unavailable");
    await expect(panel.locator(".trade-graph-feed h4")).toContainText("Unavailable");
  }
  data = response(true);
  await page.clock.fastForward(5_001);
  await expect(panel.locator('[data-trade-id="small-profitable-entry"]')).toHaveCount(1);
  failed = true;
  await page.clock.fastForward(5_001);
  await expect(panel.locator("li[data-trade-id]")).toHaveCount(0);
  await expect(panel).toContainText("Classification unavailable");
});

for (const state of [
  { name: "entirely unknown", observed: 515, checked: 0, percent: "0%", count: "Checking profit…", incomplete: true },
  { name: "partially checked", observed: 515, checked: 3, percent: "0.6%", count: "0 confirmed", incomplete: true },
  { name: "almost fully checked", observed: 10_000, checked: 9_999, percent: "99.9%", count: "0 confirmed", incomplete: true },
  { name: "fully checked with no qualifiers", observed: 515, checked: 515, percent: "100%", count: "0 confirmed", incomplete: false },
  { name: "no observed opening wallets", observed: 0, checked: 0, percent: null, count: "0 confirmed", incomplete: false },
]) {
  test(`profit coverage makes ${state.name} distinct from zero profitable traders`, async ({ page }) => {
    await setup(page);
    await page.route("**/api/assets/0/market*", async (route) => {
      const url = new URL(route.request().url());
      const profitable = url.searchParams.get("segment") === "profitable";
      const window = url.searchParams.get("window") as MarketWindow;
      const data = response(profitable, window, profitable ? [] : undefined);
      // An intake gap does not make a fresh profit classification stale.
      data.stale = true;
      if (data.segmentCoverage) Object.assign(data.segmentCoverage, {
        observedWallets: state.observed,
        classifiedWallets: state.checked,
        profitableWallets: 0,
        unknownWallets: state.observed - state.checked,
        oldestAccountReceivedAt: state.checked ? NOW - 60_000 : null,
        newestAccountReceivedAt: state.checked ? NOW - 5_000 : null,
      });
      await route.fulfill({ json: data });
    });
    await page.goto("/?view=assets&asset=0");
    const panel = page.getByRole("region", { name: "BTC price and trades" });
    await panel.getByRole("button", { name: "Profitable traders", exact: true }).click();
    const coverage = panel.getByLabel("Trader profit coverage", { exact: true });
    await expect(coverage).toContainText(`Profit checked for ${state.checked.toLocaleString()} of ${state.observed.toLocaleString()} wallets`);
    await expect(coverage).toContainText("Opening wallets · past hour");
    await expect(panel.locator(".trade-graph-feed h4")).toContainText(state.count);
    await expect(panel.locator(".trade-graph-feed-heading small")).toHaveText("Trade coverage delayed");
    await expect(panel).not.toContainText("Classification delayed");
    if (state.percent !== null) {
      await expect(coverage).toContainText(`· ${state.percent}`);
      await expect(coverage.getByRole("progressbar")).toHaveAttribute("value", String(state.checked));
      await expect(coverage.getByRole("progressbar")).toHaveAttribute("max", String(state.observed));
    } else {
      await expect(coverage.getByRole("progressbar")).toHaveCount(0);
      await expect(coverage).not.toContainText("100%");
    }
    const empty = panel.locator(".trade-graph-feed-empty");
    if (state.incomplete) {
      await expect(coverage).toContainText("unknown");
      await expect(coverage).toContainText("excluded; more may qualify");
      await expect(empty).toContainText("No confirmed entries");
      await expect(empty).toContainText("this is not a complete count");
      await expect(empty).not.toContainText("Try a lower profit minimum");
    } else if (state.observed) {
      await expect(coverage).toContainText("All observed opening wallets checked");
      await expect(empty).toContainText("No observed entries");
      await expect(empty).toContainText("Try a lower profit minimum");
    } else {
      await expect(empty).toHaveText("No wallet openings observed in the past hour.");
    }
    await panel.getByRole("button", { name: "5m", exact: true }).click();
    await expect(coverage).toContainText("Opening wallets · past hour");
    await expect(panel.locator(".trade-graph-feed")).toContainText("Selected across 5m");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
    if (state.name === "partially checked") await panel.screenshot({ path: test.info().outputPath("partial-profit-coverage.png") });
  });
}

test("coverage and confirmed entries update when active wallet profit checks finish", async ({ page }) => {
  await setup(page);
  let checked = false;
  await page.route("**/api/assets/0/market*", async (route) => {
    const profitable = new URL(route.request().url()).searchParams.get("segment") === "profitable";
    const data = response(profitable, "15m", profitable ? checked ? [entry("newly-classified-entry")] : [] : undefined);
    if (data.segmentCoverage) Object.assign(data.segmentCoverage, {
      observedWallets: 3,
      classifiedWallets: checked ? 3 : 0,
      profitableWallets: checked ? 1 : 0,
      unknownWallets: checked ? 0 : 3,
      oldestAccountReceivedAt: checked ? NOW : null,
      newestAccountReceivedAt: checked ? NOW : null,
    });
    await route.fulfill({ json: data });
  });
  await page.goto("/?view=assets&asset=0");
  const panel = page.getByRole("region", { name: "BTC price and trades" });
  await panel.getByRole("button", { name: "Profitable traders", exact: true }).click();
  const coverage = panel.getByLabel("Trader profit coverage", { exact: true });
  await expect(coverage).toContainText("Profit checked for 0 of 3 wallets");
  await expect(panel.locator(".trade-graph-feed h4")).toContainText("Checking profit…");
  checked = true;
  await page.clock.fastForward(5_001);
  await expect(coverage).toContainText("Profit checked for 3 of 3 wallets");
  await expect(coverage).toContainText("All observed opening wallets checked");
  await expect(panel.locator(".trade-graph-feed h4")).toContainText("1 confirmed");
  await expect(panel.locator('[data-trade-id="newly-classified-entry"]')).toHaveCount(1);
  await expect(panel.locator(".trade-graph-feed-empty")).toHaveCount(0);
});

test("classification expires when snapshot refresh stalls even if a fresh quote arrives", async ({ page }) => {
  await setup(page);
  let reads = 0;
  let pendingRoute: Route | undefined;
  await page.route("**/api/assets/0/market*", async (route) => {
    if (!new URL(route.request().url()).searchParams.has("segment")) {
      await route.fulfill({ json: response() });
      return;
    }
    if (++reads > 1) {
      pendingRoute = route;
      return;
    }
    await route.fulfill({ json: response(true) });
  });
  await page.goto("/?view=assets&asset=0");
  const panel = page.getByRole("region", { name: "BTC price and trades" });
  await panel.getByRole("button", { name: "Profitable traders", exact: true }).click();
  await expect(panel.locator('[data-trade-id="small-profitable-entry"]')).toHaveCount(1);
  await page.clock.fastForward(60_002);
  await send(page, { type: "asset-price", data: { instrument: 0, point: { time: NOW + 60_002, priceUsd: 83_000 }, receivedAt: NOW + 60_002 } });
  await expect(panel.locator(".trade-graph-price")).toHaveText("$83,000.00");
  await expect(panel.locator("li[data-trade-id]")).toHaveCount(0);
  await expect(panel).toContainText("Waiting for a recent trader classification");
  await pendingRoute?.abort();
});

test("profit minimum and chart window survive asset switches and trader toggles", async ({ page }) => {
  await setup(page);
  const requests: string[] = [];
  await page.route(/\/api\/assets\/[01]\/market/, async (route) => {
    const url = new URL(route.request().url());
    requests.push(`${url.pathname}${url.search}`);
    const instrument = Number(url.pathname.split("/")[3]);
    const profitable = url.searchParams.get("segment") === "profitable";
    const minPnlUsd = Number(url.searchParams.get("minPnl") ?? 0) as 0 | 1000 | 10000 | 100000;
    const window = url.searchParams.get("window") as MarketWindow;
    const data = response(profitable, window);
    Object.assign(data, {
      ...marketResponse(instrument, false, NOW),
      segment: profitable ? "profitable" : "all",
    });
    // Small orders from a sufficiently profitable wallet still qualify.
    data.trades = profitable && minPnlUsd === 100000 ? [] : [
      { ...entry(`qualified-${instrument}`, 50), instrument, priceUsd: instrument ? 2500 : 82000 },
      ...(profitable && minPnlUsd === 0 ? [{ ...entry(`twenty-dollar-profit-${instrument}`), instrument, priceUsd: instrument ? 2501 : 82001 }] : []),
    ];
    data.chartSample!.trades = data.trades;
    if (data.segmentCoverage) {
      data.segmentCoverage.minPnlUsd = minPnlUsd;
      data.segmentCoverage.profitableWallets = data.trades.length;
    }
    await route.fulfill({ json: data });
  });
  await page.goto("/?view=assets&asset=0");
  const profitable = page.getByRole("button", { name: "Profitable traders", exact: true });
  const minimum = page.getByRole("combobox", { name: "Minimum realized profit" });
  await profitable.click();
  await expect(minimum).toHaveValue("1000");
  await expect(page.locator('[data-trade-id="qualified-0"]')).toHaveCount(1);
  await expect(page.locator('[data-trade-id="twenty-dollar-profit-0"]')).toHaveCount(0);
  await minimum.selectOption("0");
  await expect(page.locator('[data-trade-id="twenty-dollar-profit-0"]')).toHaveCount(1);
  await minimum.selectOption("100000");
  await expect(page.locator('.trade-graph-feed li[data-trade-id]')).toHaveCount(0);
  await expect(page.locator(".trade-graph-feed")).toContainText("at least $100K realized profit");
  await minimum.selectOption("10000");
  await page.getByRole("button", { name: "1h", exact: true }).click();
  await expect(page.locator('[data-trade-id="qualified-0"]')).toHaveCount(1);
  for (const [symbol, name, instrument] of [["ETH", "Ethereum", 1], ["BTC", "Bitcoin", 0]] as const) {
    await page.getByRole("button", { name: `${symbol} ${name}`, exact: true }).click();
    await expect(minimum).toHaveValue("10000");
    await expect(profitable).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "1h", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => requests).toContain(`/api/assets/${instrument}/market?window=1h&segment=profitable&minPnl=10000`);
    await expect(page.locator(`[data-trade-id="qualified-${instrument}"]`)).toHaveCount(1);
    await expect(page.locator(`[data-trade-id="qualified-${1 - instrument}"]`)).toHaveCount(0);
  }
  await page.getByRole("button", { name: "All traders", exact: true }).click();
  await expect(minimum).toHaveCount(0);
  await profitable.click();
  await expect(minimum).toHaveValue("10000");
  await expect(page.locator('[data-trade-id="qualified-0"]')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
});
