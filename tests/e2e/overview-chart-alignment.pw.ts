import { expect, test } from "@playwright/test";
import { mockSources, protocolChartsResponse } from "./fixtures";

test("overview chart rows stay aligned when switching 24h and 7d", async ({
  page,
}, testInfo) => {
  const at = Date.UTC(2026, 9, 22, 17, 32);
  const hour = 3_600_000;
  const currentHour = Math.floor(at / hour) * hour;
  await page.clock.install({ time: at });
  await mockSources(page);
  await page.route("**/api/protocol/charts", (route) => {
    const data = protocolChartsResponse(at);
    for (const key of ["volume", "openPositions"] as const) {
      data.series[key].points = Array.from({ length: 168 }, (_, index) => ({
        time: currentHour - (167 - index) * hour,
        value: key === "volume" ? 154_310_000 + index * 100_000 : 1_723 + index,
        ...(index === 167 ? { partial: true } : {}),
      }));
    }
    return route.fulfill({ json: data });
  });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);

  const history = page.getByRole("region", { name: "Protocol charts", exact: true });
  const volume = history.getByRole("region", { name: "Volume / hour chart card" });
  const positions = history.getByRole("region", { name: "Open positions chart card" });
  const widths = testInfo.project.name === "desktop" ? [1440, 1024, 651] : [390, 320];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    for (const range of ["24h", "7d", "24h"] as const) {
      await history.getByRole("button", { name: range, exact: true }).click();
      await expect(history.getByRole("button", { name: range, exact: true }))
        .toHaveAttribute("aria-pressed", "true");
      for (const chart of [volume, positions]) {
        await expect(chart.locator(".pc-chart-plot rect[data-partial]"))
          .toHaveCount(range === "7d" ? 168 : 24);
        if (range === "7d") await expect(chart.locator(".pc-chart-axis")).toContainText("Oct 2026");
        else await expect(chart.locator(".pc-chart-axis")).not.toContainText("Oct 2026");
      }
      await expect(positions.locator(".pc-chart-period-total"))
        .toHaveAttribute("aria-hidden", "true");
      expect((await positions.locator(".pc-chart-period-total").innerText()).trim()).toBe("");

      const cards = await history.locator(".overview-chart-grid > .pc-chart-card")
        .evaluateAll((elements) => elements.map((card) => {
          const bounds = card.getBoundingClientRect();
          return {
            name: card.getAttribute("aria-label"),
            row: Math.round(bounds.top),
            positions: [
              ".pc-chart-period-total",
              ".pc-chart-plot > svg",
              ".pc-chart-axis",
              ".pc-chart-inspect",
              ".pc-chart-meta",
            ].map((selector) => ({
              selector,
              y: card.querySelector(selector)!.getBoundingClientRect().top - bounds.top,
            })),
          };
        }));
      expect(cards).toHaveLength(6);
      // Compare each visible row; on phones compare the two hourly cards'
      // internal offsets because they are stacked instead of side by side.
      const rows = width > 650
        ? [...new Set(cards.map((card) => card.row))].map((row) => cards.filter((card) => card.row === row))
        : [cards.slice(-2)];
      for (const row of rows) {
        expect(row.length).toBeGreaterThan(1);
        for (const card of row.slice(1)) {
          card.positions.forEach((position, index) => {
            expect(
              Math.abs(position.y - row[0].positions[index].y),
              `${width}px ${range}: ${card.name} ${position.selector}`,
            ).toBeLessThan(1);
          });
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(width);
    }
  }
});
