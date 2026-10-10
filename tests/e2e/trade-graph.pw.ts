import { expect, test } from "@playwright/test";
import { marketResponse, mockSources, WALLET } from "./fixtures";

test("price bubbles and side feed share selection, keyboard inspection and wallet navigation", async ({
  page,
}) => {
  await mockSources(page);
  await page.goto("/?view=assets&asset=0");
  const panel = page.getByRole("region", { name: "BTC price and trades" });
  const chart = panel.getByRole("group", {
    name: "BTC reference price and execution bubbles",
  });
  await expect(chart.getByRole("button")).toHaveCount(12);
  const bubble = chart.getByRole("button", {
    name: /^Closed BTC long, \$50,000\.00 notional/,
  });
  await bubble.click();
  await expect(bubble).toHaveAttribute("aria-pressed", "true");
  await expect(panel.locator('[data-trade-id="market-0-0"]')).toHaveClass(
    "is-active",
  );
  await expect(panel.locator(".trade-graph-inspect")).toContainText(
    "Execution price",
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
    "Select a bubble",
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
  await page.route("**/api/assets/0/market", (route) =>
    route.fulfill({ json: response }),
  );
  await page.goto("/?view=assets&asset=0");
  const panel = page.getByRole("region", { name: "BTC price and trades" });
  const chart = panel.getByRole("group", {
    name: "BTC reference price and execution bubbles",
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
  await page.getByRole("button", { name: "ETH Ethereum", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "ETH price and trades" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Pause chart", exact: true }),
  ).toBeVisible();
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
  await page.route("**/api/assets/0/market", (route) =>
    route.fulfill({ json: response }),
  );
  await page.goto("/?view=assets&asset=0");
  const panel = page.getByRole("region", { name: "BTC price and trades" });
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
