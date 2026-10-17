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
  const segment = panel.getByRole("combobox", { name: "Trader segment" });
  await expect(segment).toHaveValue("all");
  await expect(panel.locator('[data-trade-id="large-losing-entry"]')).toHaveCount(1);
  await segment.selectOption("profitable");
  await expect(panel.locator('[data-trade-id="small-profitable-entry"]')).toHaveCount(1);
  await expect(panel.locator('[data-trade-id="large-losing-entry"]')).toHaveCount(0);
  await expect(panel.locator('[data-trade-id="unexpected-close"]')).toHaveCount(0);
  await expect(panel).toContainText("$50");
  await expect(panel).toContainText("Rewards and unrealized P&L excluded");
  await expect(panel).toContainText("not profitability at entry");
  await expect(panel).toContainText("2 of 3 observed wallets checked, 1 unknown excluded");
  await expect(panel.locator(".trade-graph-feed h4")).toContainText("Profitable trader entries");
  await expect(page.getByText("All traders · retained observations · rolling 24h")).toBeVisible();
  await panel.getByRole("button", { name: "Pause chart", exact: true }).click();
  await expect(segment).toBeDisabled();
  await expect(panel.getByRole("button", { name: "5m", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "Resume live chart", exact: true }).click();
  for (const window of ["5m", "1h", "15m"]) {
    await panel.getByRole("button", { name: window, exact: true }).click();
    await expect.poll(() => requests).toContain(`?window=${window}&segment=profitable`);
    await expect(panel.getByRole("button", { name: window, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(panel.locator('[data-trade-id="small-profitable-entry"]')).toHaveCount(1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.mouse.move(0, 0);
  await panel.screenshot({ path: test.info().outputPath("profitable-traders.png") });
  await panel.locator('[data-trade-id="small-profitable-entry"]').getByRole("button", { name: /^View wallet/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await segment.selectOption("all");
  await expect(panel.locator('[data-trade-id="large-losing-entry"]')).toHaveCount(1);
  await expect(panel.locator('[data-trade-id="small-profitable-entry"]')).toHaveCount(0);
  await page.getByRole("button", { name: "ETH Ethereum", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Trader segment" })).toHaveValue("all");
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
  const segment = panel.getByRole("combobox", { name: "Trader segment" });
  await expect(panel.locator('[data-trade-id="large-losing-entry"]')).toHaveCount(1);
  await send(page, { type: "trade", data: entry("prior-stream-entry", 5_000) });
  await expect(panel.locator('[data-trade-id="prior-stream-entry"]')).toHaveCount(1);
  await segment.selectOption("profitable");
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
  await page.clock.fastForward(30_001);
  await expect(panel.locator('[data-trade-id="unclassified-stream-entry"]')).toHaveCount(1);
  await expect(panel.locator('[data-trade-id="unknown-stream-entry"]')).toHaveCount(0);
  await segment.selectOption("all");
  await expect(panel.locator('[data-trade-id="unknown-stream-entry"]')).toHaveCount(1);
  await segment.selectOption("profitable");
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
  await panel.getByRole("combobox", { name: "Trader segment" }).selectOption("profitable");
  await expect(panel.locator('[data-trade-id="small-profitable-entry"]')).toHaveCount(1);
  for (const invalid of [
    { ...response(true), segment: undefined, segmentCoverage: undefined },
    { ...response(true), segment: "all" as const },
    { ...response(true), instrument: 1 },
    { ...response(true), segmentCoverage: { ...response(true).segmentCoverage!, classifiedAt: NOW - 60_001 } },
  ]) {
    data = invalid;
    await page.clock.fastForward(5_001);
    await expect(panel.locator("li[data-trade-id]")).toHaveCount(0);
    await expect(panel).toContainText("Waiting for a recent trader classification");
  }
  data = response(true);
  await page.clock.fastForward(5_001);
  await expect(panel.locator('[data-trade-id="small-profitable-entry"]')).toHaveCount(1);
  failed = true;
  await page.clock.fastForward(5_001);
  await expect(panel.locator("li[data-trade-id]")).toHaveCount(0);
  await expect(panel).toContainText("Classification unavailable");
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
  await panel.getByRole("combobox", { name: "Trader segment" }).selectOption("profitable");
  await expect(panel.locator('[data-trade-id="small-profitable-entry"]')).toHaveCount(1);
  await page.clock.fastForward(60_002);
  await send(page, { type: "asset-price", data: { instrument: 0, point: { time: NOW + 60_002, priceUsd: 83_000 }, receivedAt: NOW + 60_002 } });
  await expect(panel.locator(".trade-graph-price")).toHaveText("$83,000.00");
  await expect(panel.locator("li[data-trade-id]")).toHaveCount(0);
  await expect(panel).toContainText("Waiting for a recent trader classification");
  await pendingRoute?.abort();
});
