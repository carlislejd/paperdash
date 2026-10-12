import { expect, test, type Page } from "@playwright/test";
import {
  account,
  assetResponse,
  leaderboardResponse,
  marketResponse,
  mockSources,
  overview,
} from "./fixtures";

async function navigation(page: Page, label: string) {
  await page
    .getByRole("navigation")
    .getByRole("button", { name: label, exact: true })
    .click();
}

test("cached analytics remounts keep the original expiry and manual/error/visibility refresh behavior", async ({
  page,
}) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.addInitScript(() => {
    Math.random = () => 0;
  });
  await mockSources(page);
  let reads = 0,
    fail = false;
  await page.route("**/api/assets", (route) => {
    reads++;
    return route.fulfill(
      fail
        ? { status: 503, json: { message: "Fixture temporarily unavailable" } }
        : { json: assetResponse() },
    );
  });
  await page.goto("/?view=assets");
  await expect(
    page.getByRole("region", { name: "BTC analytics" }),
  ).toContainText("$8,000,000.00");
  const initial = reads;
  await page.clock.fastForward(2000);
  await navigation(page, "Overview");
  await navigation(page, "Assets");
  await expect(
    page.getByRole("region", { name: "BTC analytics" }),
  ).toContainText("$8,000,000.00");
  expect(reads).toBe(initial);
  await page.clock.fastForward(2999);
  expect(reads).toBe(initial);
  await page.clock.fastForward(1);
  await expect.poll(() => reads).toBe(initial + 1);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => reads).toBe(initial + 2);

  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(6000);
  expect(reads).toBe(initial + 2);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => reads).toBe(initial + 3);
  fail = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Fixture temporarily unavailable",
  );
  await navigation(page, "Overview");
  await navigation(page, "Assets");
  await expect(page.getByRole("status")).toContainText(
    "Fixture temporarily unavailable",
  );
  await expect(
    page.getByRole("region", { name: "BTC analytics" }),
  ).toContainText("$8,000,000.00");
});

test("expired analytics snapshots refresh on remount", async ({ page }) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await mockSources(page);
  let reads = 0;
  await page.route("**/api/assets", (route) => {
    reads++;
    return route.fulfill({ json: assetResponse() });
  });
  await page.goto("/?view=assets");
  await expect(
    page.getByRole("region", { name: "BTC analytics" }),
  ).toBeVisible();
  const initial = reads;
  await navigation(page, "Overview");
  await page.clock.fastForward(6000);
  await navigation(page, "Assets");
  await expect.poll(() => reads).toBeGreaterThan(initial);
});

async function fakeStream(page: Page) {
  await page.addInitScript(() => {
    const sources: {
      closed?: boolean;
      onmessage?: (e: { data: string }) => void;
    }[] = [];
    class Source {
      closed = false;
      onopen?: () => void;
      onmessage?: (e: { data: string }) => void;
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
      emit: (data: unknown) =>
        sources
          .filter((s) => !s.closed)
          .forEach((s) =>
            s.onmessage?.({ data: JSON.stringify({ type: "overview", data }) }),
          ),
      shifts: [] as { value: number; classes: string[] }[],
    });
    new PerformanceObserver((list) => {
      for (const item of list.getEntries()) {
        const e = item as PerformanceEntry & {
          hadRecentInput: boolean;
          value: number;
          sources: { node: Element }[];
        };
        if (!e.hadRecentInput)
          (window as unknown as { shifts: unknown[] }).shifts.push({
            value: e.value,
            classes: e.sources.map((source) => source.node?.className ?? ""),
          });
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
}
const emit = (page: Page, data: unknown) =>
  page.evaluate(
    (data) =>
      (window as unknown as { emit: (data: unknown) => void }).emit(data),
    data,
  );

test("live trade slots reserve space and keep hovered and keyboard-focused wallets stable", async ({
  page,
}, testInfo) => {
  await fakeStream(page);
  await mockSources(page);
  const at = Date.now(),
    data = overview(),
    trades = marketResponse(0, false, at).trades.slice(0, 10);
  await page.route("**/api/accounts?**", (route) =>
    route.fulfill({
      json: {
        accounts: Array.from({ length: 10 }, (_, i) => ({
          ...account(
            `0x${(i + 1).toString(16).padStart(40, "0")}`,
            `Trader ${i}`,
          ),
          currentUnrealizedPnl: "1000000000000000000",
          currentOpenPositionCount: 1,
        })),
        count: 10,
        pageInfo: { page: 0, totalPages: 1 },
        receivedAt: at,
        stale: false,
      },
    }),
  );
  await page.goto("/");
  await emit(page, data);
  const panel = page.locator("#activity");
  await panel.scrollIntoViewIfNeeded();
  await expect(panel.getByText("No recent trades")).toBeVisible();
  const before = (await panel.boundingBox())!;
  await emit(page, { ...data, trades });
  await expect(panel.locator(".trade-row")).toHaveCount(10);
  expect(
    Math.abs((await panel.boundingBox())!.height - before.height),
  ).toBeLessThanOrEqual(1);
  // Allow recent-input exclusion to expire: this checks actual LayoutShift entries.
  await page.waitForTimeout(650);
  await page.evaluate(() => {
    (window as unknown as { shifts: unknown[] }).shifts = [];
  });
  const updated = [
    { ...trades[0], id: "new-top", wallet: `0x${"ab".repeat(20)}` },
    ...trades,
  ].slice(0, 10);
  await emit(page, { ...data, trades: updated });
  await expect(panel.locator(".trade-row").first()).toHaveAttribute(
    "data-trade-id",
    "new-top",
  );
  await page.waitForTimeout(100);
  const shifts = await page.evaluate(
    () =>
      (window as unknown as { shifts: { value: number; classes: string[] }[] })
        .shifts,
  );
  expect(shifts.filter((s) => s.classes.includes("trade-row"))).toEqual([]);
  const row = panel.locator(".trade-row").first();
  await row.focus();
  await expect(panel.getByText("Paused while reading")).toBeVisible();
  await emit(page, {
    ...data,
    trades: [
      { ...updated[0], id: "after-focus", wallet: `0x${"cd".repeat(20)}` },
      ...updated,
    ].slice(0, 10),
  });
  await expect(row).toHaveAttribute("data-trade-id", "new-top");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog").getByRole("button", {
      name: `Copy wallet address 0x${"ab".repeat(20)}`,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close wallet details", exact: true })
    .click();
  await panel.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Resume", exact: true }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(row).toHaveAttribute("data-trade-id", "after-focus");
  if (testInfo.project.name === "desktop") {
    await row.hover();
    const heldId = await row.getAttribute("data-trade-id");
    await emit(page, {
      ...data,
      trades: [{ ...updated[0], id: "after-hover" }, ...updated].slice(0, 10),
    });
    await expect(row).toHaveAttribute("data-trade-id", heldId!);
    await page.mouse.move(0, 0);
    await expect(row).toHaveAttribute("data-trade-id", "after-hover");
  }
  await panel.getByRole("button", { name: "All markets", exact: true }).focus();
  await row.dispatchEvent("pointerdown", {
    pointerType: "touch",
    pointerId: 7,
  });
  const pressedId = await row.getAttribute("data-trade-id");
  await emit(page, {
    ...data,
    trades: [
      { ...updated[0], id: "after-touch", wallet: `0x${"ef".repeat(20)}` },
      ...updated,
    ].slice(0, 10),
  });
  await expect(row).toHaveAttribute("data-trade-id", pressedId!);
  await row.dispatchEvent("pointercancel", {
    pointerType: "touch",
    pointerId: 7,
  });
  await expect(row).toHaveAttribute("data-trade-id", "after-touch");
  await row.dispatchEvent("pointerdown", {
    pointerType: "touch",
    pointerId: 8,
  });
  await emit(page, {
    ...data,
    trades: [
      {
        ...updated[0],
        id: "after-touch-click",
        wallet: `0x${"12".repeat(20)}`,
      },
      ...updated,
    ].slice(0, 10),
  });
  await expect(row).toHaveAttribute("data-trade-id", "after-touch");
  // A physical pointerup and click belong to one interaction; the target must
  // remain the pressed wallet even with a newer source event waiting.
  await row.evaluate((element) => {
    element.dispatchEvent(
      new PointerEvent("pointerup", {
        pointerType: "touch",
        pointerId: 8,
        bubbles: true,
      }),
    );
    (element as HTMLElement).click();
  });
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", {
        name: `Copy wallet address 0x${"ef".repeat(20)}`,
        exact: true,
      }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close wallet details", exact: true })
    .click();
  await panel.getByRole("button", { name: "All markets", exact: true }).focus();
  await expect(row).toHaveAttribute("data-trade-id", "after-touch-click");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  await panel.screenshot({
    path: `/tmp/paperclub-stable-feed-${testInfo.project.name}.png`,
  });
});

for (const view of ["wallets", "leaderboard"])
  test(`${view} full-page loading reserves the table footer position`, async ({
    page,
  }) => {
    await mockSources(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      view === "wallets" ? "**/api/accounts?**" : "**/api/leaderboard?**",
      async (route) => {
        await gate;
        if (view === "wallets")
          return route.fulfill({
            json: {
              accounts: Array.from({ length: 25 }, (_, i) =>
                account(
                  `0x${(i + 1).toString(16).padStart(40, "0")}`,
                  `Trader ${i}`,
                ),
              ),
              count: 25,
              pageInfo: { page: 0, totalPages: 1 },
              summary: { uniqueAccounts: 25 },
              receivedAt: Date.now(),
              stale: false,
            },
          });
        const result = leaderboardResponse();
        result.rows = Array.from({ length: 25 }, (_, i) => ({
          ...result.rows[0],
          address: `0x${(i + 1).toString(16).padStart(40, "0")}`,
          rank: i + 1,
        }));
        return route.fulfill({ json: result });
      },
    );
    await page.goto(`/?view=${view}`);
    const table = page.locator(
      view === "wallets" ? "#wallets" : ".leaderboard-view",
    );
    await expect(table.locator(".skeleton-row")).toHaveCount(25);
    const top = () =>
      table
        .locator(".table-footer")
        .evaluate((e) => e.getBoundingClientRect().top + window.scrollY);
    const before = await top();
    release();
    await expect(table.locator("tbody tr:not(.skeleton-row)")).toHaveCount(25);
    expect(Math.abs((await top()) - before)).toBeLessThanOrEqual(1);
  });
