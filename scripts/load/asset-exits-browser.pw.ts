import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { marketResponse, mockSources, WALLET } from "../../tests/e2e/fixtures";
import type { MarketActivity, TradeEvent } from "../../packages/shared/src/types";

// Local production-bundle benchmark only: all API responses and SSE are mocked.
// Coordinate an otherwise idle host before collecting comparison evidence.
test("measure a 20 second live burst while switching activities and assets", async ({ page }, info) => {
  await mkdir(".private/asset-exit-browser-load", { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  if (info.project.name.includes("4x")) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const sources: any[] = [];
    class MockEventSource {
      closed = false;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      constructor() { sources.push(this); queueMicrotask(() => this.onopen?.()); }
      close() { this.closed = true; }
    }
    let result: any;
    const emit = (message: unknown) => {
      const data = JSON.stringify(message);
      for (const source of sources) if (!source.closed) source.onmessage?.({ data });
    };
    const quoteSentAt = new Map<string, number>();
    let previousPrice = "", previousFrame = 0;
    new PerformanceObserver((entries) => {
      if (result?.running) for (const entry of entries.getEntries())
        result.longTasks.push(entry.duration);
    }).observe({ type: "longtask", buffered: false });
    const frame = (at: number) => {
      if (result?.running) {
        if (previousFrame) result.frameGaps.push(at - previousFrame);
        previousFrame = at;
        const price = document.querySelector(".trade-graph-price")?.textContent ?? "";
        if (price !== previousPrice && quoteSentAt.has(price)) {
          result.quoteToDomMs.push(performance.now() - quoteSentAt.get(price)!);
          previousPrice = price;
        }
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
    Object.assign(window, { EventSource: MockEventSource, startLoad: () => {
      result = { running: true, startedAt: performance.now(), tradeMessages: 0, quoteMessages: 0, frameGaps: [], longTasks: [], quoteToDomMs: [], maxMarkers: 0, maxFeedRows: 0, maxDomNodes: 0, maxConnections: 0, maxBacklog: 0 };
      previousFrame = 0;
      const emitTrade = () => {
        const index = result.tradeMessages++, instrument = index % 2, now = Date.now();
        const kind = index % 10 < 6 ? "open" : index % 10 < 9 ? "close" : "liq";
        emit({ type: "trade", data: {
          id: `load-${index}`, ts: now, wallet: "0x" + "1".repeat(40), instrument,
          side: index % 4 < 2 ? "long" : "short", kind, leverage: 10,
          notionalUsd: 1000 + index * 17, pnlUsd: kind === "open" ? null : index % 3 ? 200 : -100,
          priceUsd: (instrument ? 2500 : 82000) + Math.sin(index / 20) * 5,
          provenance: "public-stream",
        } });
      };
      const trades = setInterval(() => {
        const due = Math.min(2000, Math.floor((performance.now() - result.startedAt) / 10));
        result.maxBacklog = Math.max(result.maxBacklog, due - result.tradeMessages);
        while (result.tradeMessages < due) emitTrade();
      }, 10);
      const quotes = setInterval(() => {
        for (const instrument of [0, 1]) {
          const now = Date.now(), priceUsd = (instrument ? 2500 : 82000) + ++result.quoteMessages / 100;
          quoteSentAt.set(usd.format(priceUsd), performance.now());
          emit({ type: "asset-price", data: { instrument, point: { time: now, priceUsd }, receivedAt: now } });
        }
      }, 100);
      const bounds = setInterval(() => {
        result.maxMarkers = Math.max(result.maxMarkers, document.querySelectorAll(".trade-graph-bubble").length);
        result.maxFeedRows = Math.max(result.maxFeedRows, document.querySelectorAll(".trade-graph-feed li[data-trade-id]").length);
        result.maxDomNodes = Math.max(result.maxDomNodes, document.querySelectorAll("*").length);
        result.maxConnections = Math.max(result.maxConnections, sources.filter((source) => !source.closed).length);
      }, 200);
      setTimeout(() => {
        clearInterval(trades); clearInterval(quotes); clearInterval(bounds);
        result.elapsedMs = performance.now() - result.startedAt;
        result.running = false;
      }, 20_000);
    }, loadResult: () => result });
  });
  await mockSources(page);
  let marketRequests = 0;
  await page.route("**/api/assets/*/market*", async (route) => {
    marketRequests++;
    const url = new URL(route.request().url()), instrument = Number(url.pathname.split("/")[3]);
    const now = Date.now(), activity = url.searchParams.get("activity") as MarketActivity;
    const window = url.searchParams.get("window") ?? "15m";
    const duration = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000 }[window]!;
    const response = marketResponse(instrument, false, now, activity);
    const seed: TradeEvent[] = Array.from({ length: 200 }, (_, index) => ({
      id: `seed-${instrument}-${index}`, ts: now - 20_000 - index * 4400,
      wallet: WALLET, instrument, kind: index % 3 === 0 ? "open" : index % 3 === 1 ? "close" : "liq",
      side: index % 2 ? "long" : "short", leverage: 10, notionalUsd: 500_000 + index,
      pnlUsd: index % 3 === 0 ? null : index % 2 ? 20 : -20,
      priceUsd: (instrument ? 2500 : 82000) + Math.sin(index) * 10, provenance: "public-stream",
    }));
    const selected = seed.filter((trade) => activity === "all" || (activity === "entries" ? trade.kind === "open" : trade.kind !== "open"));
    response.trades = selected;
    response.points = Array.from({ length: 720 }, (_, index) => ({ time: now - (719-index)*5000, priceUsd: (instrument ? 2500 : 82000) + Math.sin(index/20)*5 }));
    response.chartSample = { windowFrom: now-duration, windowTo: now, bucketMs: duration/30, perBucket: 2, selection: "largest-notional-per-time-bucket", partial: true, trades: selected.filter((_, index) => index % 3 === 0).slice(0,60) };
    await new Promise((resolve) => setTimeout(resolve, 25));
    await route.fulfill({ json: response });
  });
  await page.goto("/?view=assets&asset=0");
  await expect(page.locator(".trade-graph-bubble").first()).toBeVisible();
  await page.waitForTimeout(1000);
  await cdp.send("HeapProfiler.collectGarbage");
  const baselineHeap = await cdp.send("Runtime.getHeapUsage");
  const beforeMetrics = await cdp.send("Performance.getMetrics");
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.start");
  await page.evaluate(() => (window as any).startLoad());
  const interactions: { action: string; elapsedMs: number }[] = [];
  const actions = ["Exits and liquidations", "ETH Ethereum", "Entries only", "BTC Bitcoin", "Entries and exits", "ETH Ethereum", "Exits and liquidations", "BTC Bitcoin"];
  for (const action of actions) {
    await page.waitForTimeout(2000);
    const at = performance.now();
    await page.getByRole("button", { name: action, exact: true }).click();
    await expect(page.getByRole("button", { name: action, exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.evaluate(() => new Promise(requestAnimationFrame));
    interactions.push({ action, elapsedMs: performance.now()-at });
  }
  await expect.poll(() => page.evaluate(() => (window as any).loadResult().running), { timeout: 10_000 }).toBe(false);
  await page.waitForTimeout(300);
  const result = await page.evaluate(() => (window as any).loadResult());
  const profile = await cdp.send("Profiler.stop");
  await writeFile(`.private/asset-exit-browser-load/${info.project.name}.cpuprofile`, JSON.stringify(profile.profile));
  const afterMetrics = await cdp.send("Performance.getMetrics");
  await cdp.send("HeapProfiler.collectGarbage");
  const afterHeap = await cdp.send("Runtime.getHeapUsage");
  const summarize = (input: number[]) => {
    const values = [...input].sort((a,b) => a-b);
    const p = (n: number) => values[Math.min(values.length-1, Math.floor(values.length*n))] ?? 0;
    return { count: values.length, p50: p(.5), p95: p(.95), p99: p(.99), max: values.at(-1) ?? 0, sum: values.reduce((a,b) => a+b,0) };
  };
  const metrics = (name: string) => afterMetrics.metrics.find((metric) => metric.name === name)!.value - beforeMetrics.metrics.find((metric) => metric.name === name)!.value;
  const evidence = {
    project: info.project.name, durationMs: result.elapsedMs,
    environment: "Local production Vite bundle; mocked SSE/API; desktop Chromium or Pixel viewport with 4x CPU throttling; one viewer; not physical mobile or network/server concurrency",
    requestedTradesPerSecond: 100, deliveredTradesPerSecond: result.tradeMessages / result.elapsedMs * 1000,
    requestedQuoteUpdatesPerAssetPerSecond: 10, tradeMessages: result.tradeMessages, quoteMessages: result.quoteMessages,
    frameGapsMs: summarize(result.frameGaps), framesOver50Ms: result.frameGaps.filter((n:number) => n>50).length,
    longTasksMs: summarize(result.longTasks), quoteToDomMs: summarize(result.quoteToDomMs),
    interactions, interactionMs: summarize(interactions.map((item) => item.elapsedMs)),
    maxMarkers: result.maxMarkers, maxFeedRows: result.maxFeedRows, maxDomNodes: result.maxDomNodes,
    maxConnections: result.maxConnections, maxBacklog: result.maxBacklog, marketRequests, baselineHeap, afterHeap,
    heapGrowthBytes: afterHeap.usedSize-baselineHeap.usedSize,
    scriptDurationSeconds: metrics("ScriptDuration"), taskDurationSeconds: metrics("TaskDuration"),
    layoutDurationSeconds: metrics("LayoutDuration"), recalcStyleDurationSeconds: metrics("RecalcStyleDuration"), pageErrors,
  };
  await writeFile(`.private/asset-exit-browser-load/${info.project.name}.json`, JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence,null,2));
  expect(pageErrors).toEqual([]);
  expect(result.maxConnections).toBe(1);
  expect(result.maxMarkers).toBeLessThanOrEqual(62);
  expect(result.maxFeedRows).toBeLessThanOrEqual(82);
});
