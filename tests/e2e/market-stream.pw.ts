import { expect, test } from "@playwright/test";
import { marketResponse, mockSources, WALLET } from "./fixtures";

test("asset charts share one stream, retain live arrivals across polls, and isolate asset changes", async ({
  page,
}) => {
  const at = Date.now();
  await page.clock.install({ time: at });
  await page.addInitScript(() => {
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
  await mockSources(page);
  let marketReads = 0;
  await page.route("**/api/assets/*/market", async (route) => {
    marketReads++;
    const instrument = Number(
      new URL(route.request().url()).pathname.split("/")[3],
    );
    await route.fulfill({
      json: marketResponse(instrument, false, at - 10_000),
    });
  });
  await page.goto("/?view=assets&asset=0");
  const graph = page.getByRole("region", { name: "BTC price and trades" });
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
  const send = (message: unknown) =>
    page.evaluate((payload) => {
      (
        window as unknown as { emitDashboard: (message: unknown) => void }
      ).emitDashboard(payload);
    }, message);
  await send(quote);
  await send({ type: "trade", data: trade });
  await send({ type: "trade", data: trade });
  await expect(
    graph.locator('[data-trade-id="stream-integration-trade"]'),
  ).toHaveCount(1);
  await expect(graph.locator(".trade-graph-price")).toHaveText("$82,345.67");
  await page.clock.fastForward(5_001);
  await expect.poll(() => marketReads).toBeGreaterThan(1);
  await expect(
    graph.locator('[data-trade-id="stream-integration-trade"]'),
  ).toHaveCount(1);
  await expect(graph.locator(".trade-graph-price")).toHaveText("$82,345.67");

  await page.getByRole("button", { name: "ETH Ethereum" }).click();
  const eth = page.getByRole("region", { name: "ETH price and trades" });
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
