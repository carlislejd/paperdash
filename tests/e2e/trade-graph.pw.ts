import { expect, test } from "@playwright/test";
import { marketResponse, mockSources, WALLET } from "./fixtures";

test("price bubbles and side feed share selection, keyboard inspection and wallet navigation", async ({
  page,
}) => {
  await mockSources(page);
  await page.goto("/?view=assets&asset=0");
  const panel = page.getByRole("region", { name: "BTC price and trades" });
  await panel.getByRole("button", { name: "All traders", exact: true }).click();
  const chart = panel.getByRole("group", {
    name: "BTC reference price and execution markers",
  });
  await expect(chart.getByRole("button")).toHaveCount(12);
  await expect(panel).toContainText(
    "Recent observations only; full-window trade sampling is not available.",
  );
  const bubble = chart.getByRole("button", {
    name: /^Closed BTC long, \$50,000\.00 notional/,
  });
  await bubble.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(bubble).toHaveAttribute("aria-pressed", "true");
  await expect(panel.locator('[data-trade-id="market-0-0"]')).toHaveClass(
    "is-active",
  );
  await expect(panel.locator(".trade-graph-inspect")).toContainText(
    "Exit price",
  );
  await chart.press("Home");
  await expect(panel.locator('[data-trade-id="market-0-11"]')).toHaveClass(
    "is-active",
  );
  await expect(panel.locator(".trade-graph-inspect")).toContainText("$600K");
  await chart.press("End");
  await expect(panel.locator('[data-trade-id="market-0-0"]')).toHaveClass(
    "is-active",
  );
  await expect(panel.locator(".trade-graph-edge")).toHaveCSS(
    "animation-name",
    "none",
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  await panel.screenshot({ path: test.info().outputPath("trade-graph.png") });
  await panel.locator(".trade-graph-selected-wallet").click();
  await expect(page).toHaveURL(
    new RegExp(`view=assets&asset=0&wallet=${WALLET}`),
  );
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(chart).toBeVisible();
  await chart.press("Escape");
  await expect(panel.locator(".trade-graph-inspect")).toContainText(
    "Hover a marker to inspect",
  );
  await panel
    .locator('[data-trade-id="market-0-0"]')
    .getByRole("button", { name: /^View wallet/ })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("pausing freezes the chart cohort while new data is buffered and resumes to the latest quote", async ({
  page,
}) => {
  const now = Date.now();
  await page.clock.install({ time: now });
  await mockSources(page);
  let response = marketResponse();
  await page.route("**/api/assets/0/market*", (route) =>
    route.fulfill({ json: response }),
  );
  await page.goto("/?view=assets&asset=0");
  const panel = page.getByRole("region", { name: "BTC price and trades" });
  await panel.getByRole("button", { name: "All traders", exact: true }).click();
  const chart = panel.getByRole("group", {
    name: "BTC reference price and execution markers",
  });
  await expect(chart.getByRole("button")).toHaveCount(12);
  const initialPrice = await panel.locator(".trade-graph-price").innerText();
  await panel.getByRole("button", { name: "Pause chart", exact: true }).click();
  response = {
    ...response,
    receivedAt: now + 5_000,
    price: { priceUsd: 92_000, sourceAt: now + 5_000, receivedAt: now + 5_000 },
    points: [...response.points, { time: now + 5_000, priceUsd: 92_000 }],
    trades: [
      {
        ...response.trades[0],
        id: "new-trade",
        ts: now + 5_000,
        priceUsd: 92_001,
      },
      ...response.trades,
    ],
  };
  await page.clock.fastForward(6_001);
  await expect(panel.locator(".trade-graph-price")).toHaveText(initialPrice);
  await expect(chart.getByRole("button")).toHaveCount(12);
  await panel
    .getByRole("button", { name: "Resume live chart", exact: true })
    .click();
  await expect(panel.locator(".trade-graph-price")).toHaveText("$92,000.00");
  await expect(chart.getByRole("button")).toHaveCount(13);
  await panel.getByRole("button", { name: "5m", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "5m", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(await chart.getByRole("button").count()).toBeLessThan(13);
  await panel.getByRole("button", { name: "Pause chart", exact: true }).click();
  response = {
    ...response,
    receivedAt: now + 12_000,
    price: { priceUsd: 93_000, sourceAt: now + 12_000, receivedAt: now + 12_000 },
    points: [...response.points, { time: now + 12_000, priceUsd: 93_000 }],
  };
  await page.getByRole("button", { name: "ETH Ethereum", exact: true }).click();
  const eth = page.getByRole("region", { name: "ETH price and trades" });
  await expect(eth).toBeVisible();
  await expect(
    eth.getByRole("button", { name: "5m", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    eth.getByRole("button", { name: "Pause chart", exact: true }),
  ).toBeVisible();
  await page.clock.fastForward(6_001);
  await page.getByRole("button", { name: "BTC Bitcoin", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Pause chart", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "5m", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(panel.locator(".trade-graph-price")).toHaveText("$93,000.00");
  await expect(panel.locator(".trade-graph-status")).not.toHaveText("Paused");
});

test("unpriced executions stay in the feed without invented price bubbles", async ({
  page,
}) => {
  await mockSources(page);
  const response = marketResponse();
  response.price = null;
  response.points = [];
  response.stale = true;
  response.trades = [{ ...response.trades[0], priceUsd: null }];
  await page.route("**/api/assets/0/market*", (route) =>
    route.fulfill({ json: response }),
  );
  await page.goto("/?view=assets&asset=0");
  const panel = page.getByRole("region", { name: "BTC price and trades" });
  await panel.getByRole("button", { name: "All traders", exact: true }).click();
  await expect(
    panel.getByText("Waiting for price observations", { exact: true }),
  ).toBeVisible();
  await expect(panel.locator(".trade-graph-price")).toHaveText("—");
  await expect(panel.locator(".trade-graph-bubble")).toHaveCount(0);
  await expect(panel).toContainText(
    "1 trade without a valid price or notional appears in the feed only.",
  );
  await expect(
    panel
      .getByRole("complementary", { name: "BTC chart trade feed" })
      .getByRole("listitem"),
  ).toHaveCount(1);
  await panel.getByRole("button", { name: /^View wallet/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("window-wide samples spread bubbles without a notional cutoff and request the selected window", async ({
  page,
}) => {
  const now = Date.now();
  await page.clock.install({ time: now });
  await mockSources(page);
  const windows: string[] = [];
  const rows = [
    { id: "small-old", age: 14 * 60_000, notional: 50_000 },
    { id: "large-old", age: 12 * 60_000, notional: 150_000 },
    { id: "million-middle", age: 7 * 60_000, notional: 2_000_000 },
    { id: "whale-new", age: 60_000, notional: 12_000_000 },
  ].map((row, index) => ({
    ...marketResponse().trades[0],
    id: row.id,
    ts: now - row.age,
    notionalUsd: row.notional,
    priceUsd: 82_000 + index * 5,
  }));
  await page.route("**/api/assets/0/market*", async (route) => {
    const window =
      new URL(route.request().url()).searchParams.get("window") ?? "1h";
    windows.push(window);
    const duration = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000 }[
      window
    ]!;
    await route.fulfill({
      json: {
        ...marketResponse(0, false, now),
        trades: [
          rows[3],
          {
            ...rows[3],
            id: "unpriced-recent",
            priceUsd: null,
            notionalUsd: 500_000,
          },
        ],
        chartSample: {
          windowFrom: now - duration,
          windowTo: now,
          bucketMs: duration / 30,
          perBucket: 2,
          selection: "largest-notional-per-time-bucket",
          partial: true,
          trades: rows.filter((row) => row.ts >= now - duration),
        },
      },
    });
  });
  await page.goto("/?view=assets&asset=0");
  const panel = page.getByRole("region", { name: "BTC price and trades" });
  const segment = panel.getByRole("button", {
    name: "All traders",
    exact: true,
  });
  await expect(segment).toHaveAttribute("aria-pressed", "true");
  await expect(panel.locator(".trade-graph-bubble")).toHaveCount(4);
  await expect(panel.locator(".trade-graph-feed h4")).toContainText(
    "Largest observed trades",
  );
  await expect(panel).toContainText("across 15m");
  expect(windows).toContain("15m");
  await expect(panel.locator('[data-trade-id="unpriced-recent"]')).toHaveCount(
    1,
  );
  await expect(panel).toContainText(
    "1 trade without a valid price or notional appears in the feed only.",
  );
  const positions = await panel
    .locator(".trade-graph-bubble")
    .evaluateAll((els) =>
      els.map((el) =>
        Number(
          (el as SVGElement).style.transform.match(/translate\(([-.\d]+)/)?.[1],
        ),
      ),
    );
  const width = await panel
    .locator(".trade-graph-canvas")
    .evaluate((el) => el.clientWidth);
  expect(Math.max(...positions) - Math.min(...positions)).toBeGreaterThan(
    (width - 85) * 0.65,
  );
  await panel.getByRole("button", { name: "Pause chart", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "5m", exact: true }),
  ).toBeDisabled();
  await panel
    .getByRole("button", { name: "Resume live chart", exact: true })
    .click();
  await panel.getByRole("button", { name: "5m", exact: true }).click();
  await expect.poll(() => windows.at(-1)).toBe("5m");
  await expect(panel.locator(".trade-graph-bubble")).toHaveCount(1);
  await panel.getByRole("button", { name: "1h", exact: true }).click();
  await expect.poll(() => windows.at(-1)).toBe("1h");
  await expect(panel.locator(".trade-graph-bubble")).toHaveCount(4);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  await panel.getByRole("button", { name: "15m", exact: true }).click();
  await expect(panel.locator(".trade-graph-bubble")).toHaveCount(4);
  await page.mouse.move(0, 0);
  await panel.screenshot({
    path: test.info().outputPath("windowed-trade-sample.png"),
  });
});
