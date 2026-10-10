import { expect, test } from "@playwright/test";
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
    history: [
      { time: at - 600000, fundsRaw: raw(1_000_000) },
      { time: at - 500000, fundsRaw: raw(1_100_000) },
      { time: at - 60000, fundsRaw: raw(-9_000_000_000), gapBefore: true },
      { time: at, fundsRaw: raw(-10_000_000_000) },
    ],
    coverage: {
      source: "retained-house-observations",
      approximate: true,
      observedFrom: at - 600000,
      partial: true,
    },
  };
}
function liquidations(instrument = 0, older = false): LiquidationsResponse {
  const at = Date.now(),
    totals = {
      count: 23,
      longCount: 20,
      shortCount: 3,
      notionalUsd: 10_000_000_000,
    };
  return {
    items: [
      {
        id: older ? "older" : "latest",
        ts: at - 1000,
        wallet: older ? SECOND_WALLET : WALLET,
        instrument,
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
    stats: { day: totals, hour: totals },
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
      Number(url.searchParams.get("instrument") ?? 0),
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
  await expect(panel.locator(".house-value strong")).toHaveText("-$10B");
  await expect(panel).toContainText("125.57M");
  await expect(panel).toContainText("$16.27K");
  await expect(panel).toContainText("LP balance + open house PnL − queue debt");
  const d = await panel.locator("svg path").getAttribute("d");
  expect(d?.match(/M/g)).toHaveLength(2);
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
  await page.screenshot({
    path: `/tmp/paperdash-house-${test.info().project.name}.png`,
    fullPage: true,
  });
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
test("overview requests ten wallets and avoids showing prior page rows under new ranks", async ({
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
  await page.goto("/");
  await expect(page.locator(".wallet-table tbody tr")).toHaveCount(10);
  expect(sizes[0]).toBe("10");
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /^Person 1 Papertrade/ }),
  ).toHaveCount(0);
  await expect(page.locator(".wallet-table tbody tr").first()).toContainText(
    "11",
  );
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Wallets", exact: true })
    .click();
  await expect(page.locator(".wallet-table tbody tr")).toHaveCount(25);
  expect(sizes.at(-1)).toBe("25");
});

test("directory refresh failures preserve saved rows with an explicit notice", async ({
  page,
}) => {
  await page.clock.install();
  await sources(page);
  await page.goto("/");
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
