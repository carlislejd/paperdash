import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { account, mockSources, WALLET, SECOND_WALLET } from "./fixtures";
import type {
  HouseResponse,
  LiquidationsResponse,
} from "../../packages/shared/src/types";
const raw = (n: number) => (BigInt(n) * 10n ** 18n).toString();
function house(): HouseResponse {
  const at = Date.now();
  return {
    sourceAt: at,
    receivedAt: at,
    stale: false,
    houseStale: false,
    house: {
      fundsRaw: raw(-10_000_000_000),
      lpRaw: raw(1_000_000),
      openPnlRaw: raw(-10_000_999_000),
      queueDebtRaw: raw(1000),
    },
    paper: {
      supplyRaw: raw(125571374),
      stakedRaw: "0",
      stakerRewardsRaw: raw(16271),
      pendingRewardsRaw: "0",
    },
    sourceBlock: "12345",
    summarySourceAt: at,
    annualizedStakingRevenue: {
      usdPerYearRaw: raw(1484728),
      lifetimeRewardsRaw: raw(16271),
      fromMs: at - 4 * 86400000,
      toMs: at,
      basis: "protocol-lifetime",
      yearDays: 365,
    },
    history: [
      {
        time: at - 600000,
        fundsRaw: raw(1_000_000),
        lpRaw: raw(1_000_000),
        openPnlRaw: raw(1000),
        queueDebtRaw: raw(1000),
      },
      {
        time: at - 500000,
        fundsRaw: raw(1_100_000),
        lpRaw: raw(1_100_000),
        openPnlRaw: raw(1000),
        queueDebtRaw: raw(1000),
      },
      {
        time: at - 60000,
        fundsRaw: raw(-9_000_000_000),
        lpRaw: raw(900_000),
        openPnlRaw: raw(-9_000_898_000),
        queueDebtRaw: raw(2000),
        gapBefore: true,
      },
      {
        time: at,
        fundsRaw: raw(-10_000_000_000),
        lpRaw: raw(1_000_000),
        openPnlRaw: raw(-10_000_999_000),
        queueDebtRaw: raw(1000),
      },
    ],
    change: {
      fromMs: at - 60000,
      toMs: at,
      sampleCount: 2,
      fundsRaw: raw(-1_000_000_000),
      lpRaw: raw(100_000),
      openPnlRaw: raw(-1_000_101_000),
      queueDebtRaw: raw(-1000),
    },
    coverage: {
      source: "retained-house-observations",
      approximate: true,
      observedFrom: at - 600000,
      partial: true,
    },
  };
}
function liquidations(
  instrument?: number,
  older = false,
): LiquidationsResponse {
  const at = Date.now(),
    totals = {
      count: 23,
      longCount: 20,
      shortCount: 3,
      notionalUsd: 10_000_000_000,
      estimatedMarginUsd: instrument === 1 ? 4_000_000 : 10_000_000,
      marginObservationCount: 23,
    };
  return {
    items: [
      {
        id: older ? "older" : "latest",
        ts: at - 1000,
        wallet: older ? SECOND_WALLET : WALLET,
        instrument: instrument ?? 0,
        side: "long",
        leverage: 1000,
        notionalUsd: 10_000_000_000,
        kind: "liq",
        pnlUsd: -1000,
        priceUsd: instrument ? 3000 : 80000,
        provenance: "public-stream",
      },
    ],
    nextCursor: older ? null : "older-page",
    stats: {
      day: totals,
      hour: {
        ...totals,
        notionalUsd: 1_000_000_000,
        estimatedMarginUsd: 1_000_000,
      },
    },
    hourly: {
      intervalMs: 3600000,
      from: at - 86400000,
      to: at,
      buckets: Array.from({ length: 25 }, (_, index) => ({
        time: Math.floor(at / 3600000) * 3600000 - (24 - index) * 3600000,
        partial: index === 0 || index === 24,
        assets: [
          {
            instrument: 0,
            count: index === 23 ? 4 : index === 24 ? 10 : 0,
            notionalUsd: index >= 23 ? 3_000_000_000 : 0,
          },
          {
            instrument: 1,
            count: index === 23 ? 3 : index === 24 ? 6 : 0,
            notionalUsd: index >= 23 ? 2_000_000_000 : 0,
          },
        ].filter(
          (asset) =>
            instrument === undefined || asset.instrument === instrument,
        ),
      })),
    },
    windowTo: at,
    receivedAt: at,
    stale: false,
    coverage: {
      source: "retained-public-observations",
      partial: true,
      identityAmbiguous: true,
      projectionBackfillComplete: true,
      observedFrom: at - 86400000,
      latestObservedAt: at,
    },
  };
}
async function sources(page: Parameters<typeof mockSources>[0]) {
  await mockSources(page);
  await page.route("**/api/house", (route) => route.fulfill({ json: house() }));
  await page.route("**/api/liquidations**", (route) => {
    const url = new URL(route.request().url());
    const data = liquidations(
      url.searchParams.has("instrument")
        ? Number(url.searchParams.get("instrument"))
        : undefined,
      url.searchParams.has("cursor"),
    );
    return route.fulfill({ json: data });
  });
}
test("house funds show signed billion values, retained gaps and PAPER independently", async ({
  page,
}) => {
  await sources(page);
  await page.goto("/");
  const panel = page.getByRole("region", {
    name: "House and PAPER statistics",
  });
  await expect(
    panel.locator(".house-funds .pc-chart-headline strong").first(),
  ).toHaveText("-$10B");
  await expect(panel).toContainText("125.57M");
  await expect(panel).toContainText("$16.27K");
  await expect(panel.locator(".annualized-revenue")).toContainText("$1.48M");
  await expect(panel.locator(".annualized-revenue")).toContainText(
    "Historical run rate, not APY or a forecast",
  );
  const paper = panel.locator(".paper-details");
  await expect(paper.locator("h3")).toHaveText([
    "PAPER supply",
    "PAPER staked",
    "Rewards allocated",
  ]);
  await expect(paper.locator(".pc-chart-headline > strong")).toHaveText([
    "125.57M",
    "0",
    "$16.27K",
  ]);
  await expect(
    paper.locator(".pc-chart-headline > strong").first(),
  ).toHaveAttribute("title", "125,571,374 PAPER");
  await expect(panel).toContainText("LP balance + open house PnL − queue debt");
  const d = await panel
    .locator(".house-funds > .pc-chart-card .pc-chart-plot path")
    .getAttribute("d");
  expect(d?.match(/M/g)).toHaveLength(2);
  const change = panel.getByRole("region", { name: "House funds change" });
  await expect(change.locator(".house-change-heading strong")).toHaveText(
    "-$1B",
  );
  await expect(change.locator("dd > span:last-child")).toHaveText([
    "+$100K",
    "-$1B",
    "+$1K",
  ]);
  await expect(change.locator("dd").nth(1)).toHaveAttribute(
    "title",
    "−$1,000,101,000.00 contribution to house funds",
  );
  await expect(change).toContainText("Queue debt effect");
  const componentCards = panel.locator(".house-components .pc-chart-card");
  await expect(componentCards.locator("h3")).toHaveText([
    "LP balance",
    "Open house PnL",
    "Queue debt",
  ]);
  const componentPaths = await componentCards
    .locator("path[stroke]")
    .evaluateAll((paths) => paths.map((path) => path.getAttribute("d")));
  expect(componentPaths.every((path) => path?.match(/M/g)?.length === 2)).toBe(
    true,
  );
  await expect(
    page.getByRole("button", { name: "View liquidations" }),
  ).toContainText("23");
  expect(
    await page
      .locator(".wordmark > svg")
      .evaluate((el) => getComputedStyle(el).color),
  ).toBe("rgb(179, 154, 206)");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  await panel.screenshot({
    path: `/tmp/paperclub-house-health-${test.info().project.name}.png`,
  });
  await panel.locator(".house-funds").screenshot({
    path: `/tmp/paperclub-house-health-panel-${test.info().project.name}.png`,
  });
});

test("house component links expand and export without mixing PAPER freshness", async ({
  page,
}) => {
  await sources(page);
  await page.route("**/api/house", (route) => {
    const data = house();
    data.stale = true;
    data.houseStale = false;
    data.error = "Protocol summary is delayed";
    return route.fulfill({ json: data });
  });
  await page.goto("/?view=overview&chart=house-open-pnl");
  const dialog = page.getByRole("dialog", {
    name: "Open house PnL",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toContainText("Last available");
  await expect(dialog).not.toContainText("Protocol summary is delayed");
  const d = await dialog.locator(".pc-chart-plot path").getAttribute("d");
  expect(d?.match(/M/g)).toHaveLength(2);
  const downloadEvent = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download PNG" }).click();
  const download = await downloadEvent;
  const bytes = await readFile((await download.path())!);
  expect(bytes.subarray(1, 4).toString()).toBe("PNG");
  expect(bytes.readUInt32BE(16)).toBe(1800);
  await download.saveAs(
    `/tmp/paperclub-house-pnl-export-${test.info().project.name}.png`,
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Expand Queue debt chart" }).click();
  await expect(
    page.getByRole("dialog", { name: "Queue debt", exact: true }),
  ).toBeVisible();
});

test("house legacy history keeps current amounts and marks missing components and changes unavailable", async ({
  page,
}) => {
  await sources(page);
  await page.route("**/api/house", (route) => {
    const data = house();
    data.stale = true;
    delete data.houseStale;
    delete data.change;
    data.history = data.history.map(({ time, fundsRaw, gapBefore }) => ({
      time,
      fundsRaw,
      gapBefore,
    }));
    return route.fulfill({ json: data });
  });
  await page.goto("/");
  const housePanel = page.locator(".house-funds");
  await expect(
    housePanel.locator(".house-components .pc-chart-headline strong"),
  ).toHaveText(["$1M", "-$10B", "$1K"]);
  await expect(
    housePanel
      .locator(".house-components")
      .getByRole("img", { name: /no observations/ }),
  ).toHaveCount(3);
  await expect(housePanel).toContainText(
    "Change unavailable for the available history",
  );
  await expect(housePanel.locator(".house-contributions")).toHaveCount(0);
  await expect(housePanel).toContainText("Last available");
  await expect(
    page.getByRole("region", { name: "PAPER economics" }),
  ).not.toContainText("LAST AVAILABLE");
});

test("house change handles zero and giant signed contributions without overflow", async ({
  page,
}) => {
  await sources(page);
  let large = false;
  await page.route("**/api/house", (route) => {
    const data = house();
    const giant = (2n ** 255n - 1n).toString();
    const values = {
      fundsRaw: large ? `-${giant}` : "0",
      lpRaw: large ? giant : "0",
      openPnlRaw: large ? `-${giant}` : "0",
      queueDebtRaw: large ? giant : "0",
    };
    data.house = values;
    data.history = [
      {
        time: data.sourceAt! - 60000,
        fundsRaw: "0",
        lpRaw: "0",
        openPnlRaw: "0",
        queueDebtRaw: "0",
      },
      { time: data.sourceAt!, ...values },
    ];
    data.change = {
      fromMs: data.sourceAt! - 60000,
      toMs: data.sourceAt!,
      sampleCount: 2,
      ...values,
    };
    return route.fulfill({ json: data });
  });
  await page.goto("/");
  const change = page.getByRole("region", { name: "House funds change" });
  await expect(change.locator(".house-change-heading strong")).toHaveText("$0");
  await expect(change.locator("dd > span:last-child")).toHaveText([
    "$0",
    "$0",
    "$0",
  ]);
  expect(
    await change
      .locator("i")
      .evaluateAll((bars) => bars.every((bar) => bar.style.width === "0%")),
  ).toBe(true);
  large = true;
  await page.reload();
  await expect(change.locator("dd").nth(2)).toHaveClass("negative");
  expect(
    await change
      .locator("i")
      .evaluateAll((bars) =>
        bars.every((bar) => Number.parseFloat(bar.style.width) === 50),
      ),
  ).toBe(true);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
});
test("liquidation filtering, retained pagination and wallet links remain bounded", async ({
  page,
}) => {
  await sources(page);
  await page.goto("/?view=liquidations");
  const panel = page.getByRole("region", { name: "Liquidations", exact: true });
  await expect(panel).toContainText("$10B");
  await expect(panel).toContainText("1,000×");
  await expect(panel).toContainText("not lost collateral");
  await panel.getByRole("button", { name: "ETH", exact: true }).click();
  await expect(panel.locator("tbody")).toContainText("ETH");
  await panel.getByRole("button", { name: "Next liquidation page" }).click();
  await expect(panel.locator("tbody")).toContainText("0x2222");
  await panel.getByRole("button", { name: "Back to latest" }).click();
  await expect(panel.locator("tbody")).toContainText("0x1111");
  await panel.locator(".liquidation-wallet").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/view=liquidations/);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({
    path: `/tmp/paperdash-liquidations-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test("estimated liquidation margin is a same-weight headline across responsive sizes and asset filters", async ({
  page,
}) => {
  await sources(page);
  await page.goto("/?view=liquidations");
  const metrics = page.locator(".liquidation-metrics");
  const margin = metrics
    .locator("> div")
    .filter({ hasText: "Liquidated margin · 24h" });
  await expect(metrics.locator("> div")).toHaveCount(5);
  await expect(margin.locator("dd")).toHaveText("$10M");
  await expect(margin.locator("dd")).toHaveAttribute("title", "$10,000,000.00");
  await expect(margin).toContainText("Est.");
  await expect(
    page.locator(".liquidations-view .protocol-method"),
  ).toContainText("Initial margin estimated from notional ÷ entry leverage.");
  await expect(
    metrics
      .locator("> div")
      .filter({ hasText: "Liquidated notional · 1h" })
      .locator("dd"),
  ).toHaveText("$1B");
  const widths =
    test.info().project.name === "desktop" ? [1440, 1024, 720, 320] : [393];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    const sizes = await metrics.locator("dd").evaluateAll((items) =>
      items.map((item) => {
        const style = getComputedStyle(item);
        return `${style.fontSize}/${style.fontWeight}`;
      }),
    );
    expect(new Set(sizes).size).toBe(1);
    expect(
      await metrics
        .locator("> div")
        .evaluateAll((items) =>
          items.every((item) => item.scrollWidth <= item.clientWidth),
        ),
    ).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    if (width === 1440 || width === 393)
      await page.screenshot({
        path: `/tmp/paperclub-liquidation-margin-${width}.png`,
      });
  }
  await page
    .locator(".liquidation-toolbar")
    .getByRole("button", { name: "ETH", exact: true })
    .click();
  await expect(margin.locator("dd")).toHaveText("$4M");
  await expect(page.locator(".liquidation-table tbody")).toContainText("ETH");
});

test("liquidation margin distinguishes missing legacy data, incomplete estimates and observed zero", async ({
  page,
}) => {
  await sources(page);
  let value: number | null | undefined;
  await page.route("**/api/liquidations", (route) => {
    const data = liquidations();
    if (value === undefined) {
      delete data.stats.day.estimatedMarginUsd;
      delete data.stats.day.marginObservationCount;
    } else {
      data.stats.day.estimatedMarginUsd = value;
      data.stats.day.marginObservationCount = 0;
      if (value === 0) data.stats.day.count = 0;
    }
    return route.fulfill({ json: data });
  });
  const margin = page
    .locator(".liquidation-metrics > div")
    .filter({ hasText: "Liquidated margin · 24h" })
    .locator("dd");
  await page.goto("/?view=liquidations");
  await expect(margin).toHaveText("—");
  value = null;
  await page.reload();
  await expect(margin).toHaveText("—");
  value = 0;
  await page.reload();
  await expect(margin).toHaveText("$0");
});

test("hourly liquidations stack assets, switch metric and export an expanded chart", async ({
  page,
}) => {
  await sources(page);
  await page.goto("/?view=liquidations");
  const chart = page.getByRole("region", {
    name: "Hourly liquidations by asset",
  });
  await expect(chart).toBeVisible();
  const metricsBox = await page.locator(".liquidation-metrics").boundingBox();
  const chartBox = await chart.boundingBox();
  const tableBox = await page.locator(".liquidation-table").boundingBox();
  expect(chartBox!.y).toBeGreaterThan(metricsBox!.y + metricsBox!.height);
  expect(tableBox!.y).toBeGreaterThan(chartBox!.y + chartBox!.height);
  await chart.getByRole("img").focus();
  await page.keyboard.press("End");
  await expect(chart.locator(".pc-chart-inspect")).toContainText("BTC");
  await expect(chart.locator(".pc-chart-inspect")).toContainText("ETH");
  await expect(chart.locator(".pc-chart-inspect")).toContainText("partial");
  await expect(chart.locator(".pc-chart-inspect")).toContainText(
    "3,000,000,000",
  );
  await expect(chart.locator(".pc-chart-inspect")).toContainText(
    "2,000,000,000",
  );
  await chart.getByRole("button", { name: "Count", exact: true }).click();
  await chart.getByRole("img").focus();
  await page.keyboard.press("End");
  await expect(chart.locator(".pc-chart-inspect")).toContainText(
    "16 liquidations",
  );
  await chart
    .getByRole("button", { name: "Expand Liquidations / hour chart" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Liquidations / hour" });
  await expect(dialog).toContainText("BTC");
  await expect(dialog).toContainText("ETH");
  const downloadEvent = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download PNG" }).click();
  const download = await downloadEvent;
  const bytes = await readFile((await download.path())!);
  expect(bytes.subarray(1, 4).toString()).toBe("PNG");
  expect(bytes.readUInt32BE(16)).toBe(1800);
  await download.saveAs(
    `/tmp/paperclub-liquidations-share-${test.info().project.name}.png`,
  );
  await page.keyboard.press("Escape");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({
    path: `/tmp/paperclub-liquidations-chart-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test("shared liquidation charts keep the asset and metric while missing history stays unavailable", async ({
  page,
}) => {
  await sources(page);
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Copy unavailable in test");
        },
      },
    }),
  );
  await page.goto(
    "/?view=liquidations&chart=liquidations-count&instrument=1&note=private#discard",
  );
  const dialog = page.getByRole("dialog", { name: "Liquidations / hour" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("ETH");
  await expect(dialog).not.toContainText("BTC");
  await dialog.getByRole("img").focus();
  await page.keyboard.press("End");
  await expect(dialog.locator(".pc-chart-inspect")).toContainText(
    "6 liquidations",
  );
  await dialog.getByRole("button", { name: "Copy chart link" }).click();
  await expect(dialog.getByRole("textbox", { name: "Chart link" })).toHaveValue(
    `${new URL(page.url()).origin}/?view=liquidations&chart=liquidations-count&instrument=1`,
  );
  await page.keyboard.press("Escape");
  await expect(
    page
      .locator(".liquidation-toolbar")
      .getByRole("button", { name: "ETH", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.route("**/api/liquidations**", (route) => {
    const data = liquidations();
    delete data.hourly;
    return route.fulfill({ json: data });
  });
  await page.reload();
  const chart = page.getByRole("region", {
    name: "Hourly liquidations by asset",
  });
  await expect(chart).toContainText("Hourly history is not yet available");
  await expect(chart.locator(".pc-chart-headline strong")).toHaveText("—");
  await expect(chart.getByRole("img")).toHaveAttribute(
    "aria-label",
    /no observations/,
  );
});
test("wallet directory avoids showing prior page rows under new ranks", async ({
  page,
}) => {
  await sources(page);
  const sizes: string[] = [];
  await page.route("**/api/accounts?**", async (route) => {
    const url = new URL(route.request().url()),
      size = Number(url.searchParams.get("pageSize")),
      pageNumber = Number(url.searchParams.get("page"));
    sizes.push(String(size));
    if (pageNumber === 1)
      await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      json: {
        accounts: Array.from({ length: size }, (_, i) =>
          account(
            `0x${(pageNumber * size + i + 1).toString(16).padStart(40, "0")}`,
            `Person ${pageNumber * size + i + 1}`,
          ),
        ),
        count: 75,
        pageInfo: { page: pageNumber, totalPages: Math.ceil(75 / size) },
        summary: {
          uniqueAccounts: 75,
          trackedBalance: "0",
          trackedQueued: "0",
          trackedOpenNotional: "0",
          trackedPaper: "0",
        },
        receivedAt: Date.now(),
        stale: false,
      },
    });
  });
  await page.goto("/?view=wallets");
  await expect(page.locator(".wallet-table tbody tr")).toHaveCount(25);
  expect(sizes[0]).toBe("25");
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /^Person 1 Papertrade/ }),
  ).toHaveCount(0);
  await expect(page.locator(".wallet-table tbody tr").first()).toContainText(
    "26",
  );
});

test("directory refresh failures preserve saved rows with an explicit notice", async ({
  page,
}) => {
  await page.clock.install();
  await sources(page);
  await page.goto("/?view=wallets");
  const table = page.locator("#wallets");
  await expect(table.getByRole("button", { name: /^Aoi / })).toBeVisible();
  await page.route("**/api/accounts?**", (route) =>
    route.fulfill({
      status: 503,
      headers: { "Retry-After": "30" },
      json: { error: "Directory temporarily unavailable" },
    }),
  );
  await page.clock.fastForward(30001);
  await expect(table.getByRole("status")).toContainText(
    "Showing the saved directory",
  );
  await expect(table.getByRole("button", { name: /^Aoi / })).toBeVisible();
});

test("liquidation notifications coalesce without bypassing source cooldown", async ({
  page,
}) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.addInitScript(() => {
    let current: {
      onmessage: ((event: { data: string }) => void) | null;
    } | null = null;
    class Source {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      constructor() {
        current = this;
        queueMicrotask(() => this.onopen?.());
      }
      close() {
        if (current === this) current = null;
      }
    }
    Object.assign(window, {
      EventSource: Source,
      emitLiquidation: () =>
        current?.onmessage?.({
          data: JSON.stringify({
            type: "trade",
            data: { id: "notify", ts: Date.now(), kind: "liq", instrument: 0 },
          }),
        }),
    });
  });
  await sources(page);
  let reads = 0,
    fail = false;
  await page.route("**/api/liquidations", (route) => {
    reads++;
    return route.fulfill(
      fail
        ? {
            status: 503,
            headers: { "Retry-After": "30" },
            json: { error: "Source delayed" },
          }
        : { json: liquidations() },
    );
  });
  await page.goto("/?view=liquidations");
  await expect(page.locator(".liquidation-table tbody tr")).toHaveCount(1);
  const initialReads = reads;
  expect(initialReads).toBeGreaterThan(0);
  const burst = () =>
    page.evaluate(() => {
      for (let i = 0; i < 100; i++)
        (
          window as unknown as { emitLiquidation: () => void }
        ).emitLiquidation();
    });
  await burst();
  await page.clock.fastForward(4999);
  expect(reads).toBe(initialReads);
  fail = true;
  await page.clock.fastForward(2);
  await expect.poll(() => reads).toBe(initialReads + 1);
  await expect(
    page
      .getByRole("region", { name: "Liquidations", exact: true })
      .getByRole("status"),
  ).toContainText("Source delayed");
  await burst();
  await page.clock.fastForward(10000);
  expect(reads).toBe(initialReads + 1);
  await expect(page.locator(".liquidation-table tbody tr")).toHaveCount(1);
});
