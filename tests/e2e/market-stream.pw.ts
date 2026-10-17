import { expect, test, type Page } from "@playwright/test";
import { assetResponse, marketResponse, mockSources, overview, WALLET } from "./fixtures";

async function mockEventStream(page: Page) {
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
      onerror: (() => void) | null = null;
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
      dashboardConnections: () =>
        sources.filter((source) => !source.closed).length,
    });
  });
}

function sendDashboard(page: Page, message: unknown) {
  return page.evaluate((payload) => {
    (
      window as unknown as { emitDashboard: (message: unknown) => void }
    ).emitDashboard(payload);
  }, message);
}

test("asset charts share one stream, retain live arrivals across polls, and isolate asset changes", async ({
  page,
}) => {
  const at = Date.now();
  await page.clock.install({ time: at });
  await page.clock.pauseAt(new Date(at));
  await mockEventStream(page);
  await mockSources(page);
  let marketReads = 0;
  let assetReads = 0;
  await page.route("**/api/assets", async (route) => {
    assetReads++;
    const receivedAt = await page.evaluate(() => Date.now());
    await route.fulfill({
      json: {
        ...assetResponse(),
        receivedAt,
        sourceAt: receivedAt,
        activityReceivedAt: receivedAt,
      },
    });
  });
  await page.route("**/api/assets/*/market*", async (route) => {
    marketReads++;
    const instrument = Number(
      new URL(route.request().url()).pathname.split("/")[3],
    );
    const response = marketResponse(instrument, false, at - 10_000);
    response.chartSample = {
      windowFrom: response.windowTo - 900_000,
      windowTo: response.windowTo,
      bucketMs: 30_000,
      perBucket: 2,
      selection: "largest-notional-per-time-bucket",
      partial: true,
      trades: response.trades,
    };
    await route.fulfill({ json: response });
  });
  await page.goto("/?view=assets&asset=0");
  const graph = page.getByRole("region", { name: "BTC price and trades" });
  await graph.getByRole("button", { name: "All traders", exact: true }).click();
  await expect(
    graph.locator(".trade-graph-feed li[data-trade-id]"),
  ).toHaveCount(12);
  const trade = {
    id: "stream-integration-trade",
    ts: at,
    wallet: WALLET,
    instrument: 0,
    side: "long",
    kind: "open",
    leverage: 20,
    notionalUsd: 123_456,
    pnlUsd: null,
    priceUsd: 82_345.67,
    provenance: "public-stream",
  };
  const quote = {
    type: "asset-price",
    data: {
      instrument: 0,
      point: { time: at, priceUsd: 82_345.67 },
      receivedAt: at,
    },
  };
  const send = (message: unknown) => sendDashboard(page, message);
  await send(quote);
  await send({ type: "trade", data: trade });
  await send({ type: "trade", data: trade });
  await expect(
    graph.locator('[data-trade-id="stream-integration-trade"]'),
  ).toHaveCount(1);
  await expect(graph.locator(".trade-graph-price")).toHaveText("$82,345.67");
  const initialMarketReads = marketReads;
  const initialAssetReads = assetReads;
  await page.clock.fastForward(5_001);
  expect(marketReads).toBe(initialMarketReads);
  expect(assetReads).toBe(initialAssetReads);
  // Current prices/trades remain live while both full snapshots reconcile less often.
  for (let i = 0; i < 2; i++) {
    const now = await page.evaluate(() => Date.now());
    await send({
      ...quote,
      data: {
        ...quote.data,
        point: { ...quote.data.point, time: now },
        receivedAt: now,
      },
    });
    await page.clock.fastForward(10_000);
    expect(marketReads).toBe(initialMarketReads);
    await expect.poll(() => assetReads).toBe(initialAssetReads + 1);
  }
  const now = await page.evaluate(() => Date.now());
  await send({
    ...quote,
    data: {
      ...quote.data,
      point: { ...quote.data.point, time: now },
      receivedAt: now,
    },
  });
  await page.clock.fastForward(5_000);
  await expect.poll(() => marketReads).toBe(initialMarketReads + 1);
  await expect.poll(() => assetReads).toBe(initialAssetReads + 2);
  await expect(
    graph.locator('[data-trade-id="stream-integration-trade"]'),
  ).toHaveCount(1);
  await expect(graph.locator(".trade-graph-price")).toHaveText("$82,345.67");

  await page.evaluate((base) => {
    const emit = (
      window as unknown as { emitDashboard: (message: unknown) => void }
    ).emitDashboard;
    for (let i = 0; i < 500; i++)
      emit({
        type: "trade",
        data: { ...base, id: `burst-${i}`, notionalUsd: 1_000 + i },
      });
  }, trade);
  await expect(graph.locator('[data-trade-id="market-0-11"]')).toHaveCount(1);
  await expect(
    graph.locator('[data-trade-id="stream-integration-trade"]'),
  ).toHaveCount(1);
  expect(
    await graph.locator(".trade-graph-bubble").count(),
  ).toBeLessThanOrEqual(62);
  await page.clock.fastForward(6_001);
  await expect(graph.locator('[data-trade-id="market-0-11"]')).toHaveCount(1);
  await expect(
    graph.locator('[data-trade-id="stream-integration-trade"]'),
  ).toHaveCount(1);

  await page.getByRole("button", { name: "ETH Ethereum" }).click();
  const eth = page.getByRole("region", { name: "ETH price and trades" });
  await expect(
    eth.getByRole("button", { name: "All traders", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(eth.locator(".trade-graph-feed li[data-trade-id]")).toHaveCount(
    12,
  );
  await send({ type: "trade", data: { ...trade, id: "wrong-asset" } });
  await send(quote);
  await expect(eth.locator('[data-trade-id="wrong-asset"]')).toHaveCount(0);
  await expect(eth.locator(".trade-graph-price")).not.toHaveText("$82,345.67");
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { dashboardConnections: () => number }
      ).dashboardConnections(),
    ),
  ).toBe(1);

  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Overview", exact: true })
    .click();
  await expect(graph).toHaveCount(0);
  const previousReads = marketReads;
  await page.clock.fastForward(10_001);
  expect(marketReads).toBe(previousReads);
});

test("fresh quotes stay live when trade snapshots lag and require fresh source and receipt clocks", async ({
  page,
}) => {
  const at = Date.now();
  await page.clock.install({ time: at });
  await page.clock.pauseAt(new Date(at));
  await mockEventStream(page);
  await mockSources(page);
  await page.route("**/api/assets/0/market*", (route) =>
    route.fulfill({ json: marketResponse(0, true, at) }),
  );
  await page.goto("/?view=assets&asset=0");
  const graph = page.getByRole("region", { name: "BTC price and trades" });
  const priceStatus = graph.locator(".trade-graph-status");
  const feedStatus = graph.locator(".trade-graph-feed-heading small");
  await expect(priceStatus).toHaveText("Delayed");
  await expect(feedStatus).toHaveText("Trade snapshot delayed");
  const snapshot = overview();
  snapshot.status.stream = "disconnected";
  await sendDashboard(page, { type: "overview", data: snapshot });
  const quote = (sourceAt: number, receivedAt: number) =>
    sendDashboard(page, {
      type: "asset-price",
      data: {
        instrument: 0,
        point: { time: sourceAt, priceUsd: 82_345.67 },
        receivedAt,
      },
    });
  await quote(at, at);
  await expect(graph.locator(".trade-graph-price")).toHaveText("$82,345.67");
  await expect(priceStatus).toHaveText("Live");
  await expect(feedStatus).toHaveText("Trade snapshot delayed");

  await page.clock.fastForward(31_001);
  await expect(priceStatus).toHaveText("Delayed");
  const now = await page.evaluate(() => Date.now());
  await quote(at + 1, now);
  await expect(priceStatus).toHaveText("Delayed");
  await quote(now, at);
  await expect(priceStatus).toHaveText("Delayed");
  await quote(now, now);
  await expect(priceStatus).toHaveText("Live");
  await expect(feedStatus).toHaveText("Trade snapshot delayed");
});
