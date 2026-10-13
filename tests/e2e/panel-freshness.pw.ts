import { expect, test, type Page } from "@playwright/test";
import {
  mockSources,
  overview,
  paperEconomicsResponse,
  protocolChartsResponse,
} from "./fixtures";
import type { PanelRevisions } from "../../packages/shared/src/types";

const paths = [
  "/api/house",
  "/api/protocol/charts",
  "/api/paper/economics",
  "/api/liquidations/stats",
];
const at = Date.UTC(2026, 9, 12, 12);
function manifest(now: number, revision = "a", stale = false): PanelRevisions {
  return {
    version: 1,
    publishedAt: now,
    panels: Object.fromEntries(
      ["house", "protocol-charts", "paper-economics", "liquidation-stats"].map(
        (key) => [key, { revision, sourceAt: now, receivedAt: now, stale }],
      ),
    ),
  };
}
async function setup(page: Page) {
  await page.clock.install({ time: at });
  await page.clock.pauseAt(new Date(at));
  await page.addInitScript(() => {
    Math.random = () => 0;
    const sources: Source[] = [];
    class Source {
      closed = false;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      constructor() {
        sources.push(this);
        queueMicrotask(() => this.onopen?.());
      }
      close() {
        this.closed = true;
      }
    }
    Object.assign(window, {
      EventSource: Source,
      emitPanel: (message: unknown) =>
        sources
          .filter((s) => !s.closed)
          .forEach((s) => s.onmessage?.({ data: JSON.stringify(message) })),
      failPanel: () =>
        sources.filter((s) => !s.closed).forEach((s) => s.onerror?.()),
      activePanelStreams: () => sources.filter((s) => !s.closed).length,
    });
  });
  await mockSources(page);
  await page.route("**/api/house", (route) =>
    route.fulfill({
      json: {
        panelRevision: "a",
        sourceAt: at,
        receivedAt: at,
        stale: false,
        houseStale: false,
        house: {
          fundsRaw: "1000000000000000000",
          lpRaw: "1000000000000000000",
          openPnlRaw: "0",
          queueDebtRaw: "0",
        },
        paper: {
          supplyRaw: "0",
          stakedRaw: "0",
          stakerRewardsRaw: "0",
          pendingRewardsRaw: "0",
        },
        history: [],
        coverage: { partial: true },
      },
    }),
  );
  await page.route("**/api/liquidations/stats", (route) =>
    route.fulfill({
      json: {
        panelRevision: "a",
        receivedAt: at,
        stale: false,
        stats: {
          day: { count: 0, notionalUsd: 0 },
          hour: { count: 0, notionalUsd: 0 },
        },
      },
    }),
  );
  await page.route("**/api/protocol/charts", (route) =>
    route.fulfill({
      json: {
        ...protocolChartsResponse(),
        sourceAt: at,
        receivedAt: at,
        panelRevision: "a",
      },
    }),
  );
  await page.route("**/api/paper/economics", (route) =>
    route.fulfill({
      json: { ...paperEconomicsResponse(at), panelRevision: "a" },
    }),
  );
}
const emit = (page: Page, message: unknown) =>
  page.evaluate(
    (message) =>
      (
        window as unknown as { emitPanel: (message: unknown) => void }
      ).emitPanel(message),
    message,
  );

test("capable bootstrap shares four panels and avoids unchanged five-second downloads while preserving revision refresh", async ({
  page,
}) => {
  await setup(page);
  const reads = new Map(paths.map((path) => [path, 0]));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (reads.has(path)) reads.set(path, reads.get(path)! + 1);
  });
  await page.goto("/");
  await expect(
    page.getByRole("region", { name: "PAPER economics", exact: true }),
  ).toContainText("125.57M");
  await emit(page, {
    type: "overview",
    data: overview(),
    panels: manifest(at),
  });
  await page.clock.fastForward(5000);
  await expect.poll(() => [...reads.values()]).toEqual([2, 2, 2, 2]);
  const settled = new Map(reads);
  for (let elapsed = 10000; elapsed <= 30000; elapsed += 5000) {
    await page.clock.fastForward(5000);
    if (elapsed % 10000 === 0)
      await emit(page, {
        type: "panel-revisions",
        data: manifest(at + elapsed),
      });
  }
  expect([...reads]).toEqual([...settled]);
  // Without capability this same window requires seven reads per panel.
  expect([...reads.values()].every((count) => count <= 2)).toBe(true);
  await page.route("**/api/paper/economics", (route) =>
    route.fulfill({
      json: { ...paperEconomicsResponse(at + 30000), panelRevision: "b" },
    }),
  );
  await emit(page, {
    type: "panel-revisions",
    data: {
      version: 1,
      publishedAt: at + 30000,
      panels: {
        "paper-economics": {
          revision: "b",
          sourceAt: at + 30000,
          receivedAt: at + 30000,
          stale: false,
        },
      },
    },
  });
  await expect.poll(() => reads.get("/api/paper/economics")).toBe(3);
  expect(reads.get("/api/house")).toBe(settled.get("/api/house"));
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { activePanelStreams: () => number }
      ).activePanelStreams(),
    ),
  ).toBe(1);
});

test("source failure and lease expiry cannot leave fresh-looking panels; old servers continue polling", async ({
  page,
}) => {
  await setup(page);
  let reads = 0;
  await page.route("**/api/paper/economics", (route) => {
    reads++;
    return route.fulfill({
      json: { ...paperEconomicsResponse(at), panelRevision: "b" },
    });
  });
  await page.goto("/");
  const paper = page.getByRole("region", {
    name: "PAPER economics",
    exact: true,
  });
  await expect(paper).toContainText("125.57M");
  await emit(page, {
    type: "overview",
    data: overview(),
    panels: manifest(at),
  });
  await emit(page, { type: "panel-revisions", data: manifest(at, "b", true) });
  await expect(paper).toContainText("LAST AVAILABLE");
  await page.clock.fastForward(5000);
  await expect.poll(() => reads).toBe(2);
  // A successful GET containing older clocks cannot erase an explicit source failure.
  await expect(paper).toContainText("LAST AVAILABLE");
  await page.clock.fastForward(15001);
  await expect.poll(() => reads).toBe(3);
  await page.evaluate(() =>
    (window as unknown as { failPanel: () => void }).failPanel(),
  );
  await page.clock.fastForward(2000);
  await emit(page, { type: "overview", data: overview() });
  const oldServerReads = reads;
  await page.clock.fastForward(5000);
  await expect.poll(() => reads).toBeGreaterThan(oldServerReads);
  await page.clock.fastForward(60000);
  await expect(paper).toContainText("LAST AVAILABLE");
  await expect(paper).toContainText("125.57M");
});

test("panel hints and quote ticks cannot discard an in-flight overview fallback", async ({
  page,
}) => {
  await setup(page);
  let release!: () => void;
  let reads = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/overview", async (route) => {
    reads++;
    await gate;
    return route.fulfill({ json: overview() });
  });
  await page.goto("/");
  await page.clock.fastForward(3000);
  await expect.poll(() => reads).toBe(1);
  await emit(page, { type: "panel-revisions", data: manifest(at + 3000) });
  await emit(page, {
    type: "asset-price",
    data: {
      instrument: 0,
      point: { time: at + 3000, priceUsd: 80000 },
      receivedAt: at + 3000,
    },
  });
  release();
  await expect(
    page.getByRole("region", { name: "Protocol overview" }),
  ).toContainText("$66.32M");
});
