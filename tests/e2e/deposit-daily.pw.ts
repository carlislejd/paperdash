import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { mockSources, protocolChartsResponse } from "./fixtures";

const at = Date.UTC(2026, 9, 13, 12, 25);
const day = 86400000;

test("daily deposit charts share the existing request, grow today, and expand/export with integer wallet ticks", async ({
  page,
}) => {
  await page.clock.install({ time: at });
  await page.clock.pauseAt(new Date(at));
  await page.addInitScript(() => {
    Math.random = () => 0;
  });
  await mockSources(page);
  let reads = 0,
    amount = 125;
  const walletReads: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/wallets/"))
      walletReads.push(request.url());
  });
  await page.route("**/api/protocol/charts", (route) => {
    reads++;
    const data = protocolChartsResponse(at);
    data.deposits!.days.at(-1)!.depositVolumeRaw = (
      BigInt(amount) *
      10n ** 18n
    ).toString();
    return route.fulfill({ json: data });
  });
  await page.goto("/");
  const first = page.getByRole("region", {
    name: "First-time depositors chart card",
    exact: true,
  });
  const volume = page.getByRole("region", {
    name: "Deposit volume / day chart card",
    exact: true,
  });
  await expect(first.locator(".pc-chart-headline > strong")).toHaveText("1");
  await expect(volume.locator(".pc-chart-headline > strong")).toHaveText("125");
  await expect(first).toContainText("Earliest recorded deposit per wallet");
  await expect(volume).toContainText("including repeat deposits");
  await expect(first).toContainText("Partial history");
  await expect(first).toContainText("Stored totals updated:");
  await expect(first).toContainText("Today so far");
  expect(reads).toBe(1);
  expect(walletReads).toEqual([]);
  for (const label of await first
    .locator(".pc-chart-y-axis span")
    .allTextContents())
    expect(label).toMatch(/^\d+$/);
  const bars = volume.locator(".pc-chart-plot rect[data-partial]");
  await expect(bars).toHaveCount(7);
  await expect(bars.last()).toHaveAttribute("data-partial", "true");
  await expect(bars.first()).toHaveAttribute("data-partial", "false");
  const width = Number(await bars.last().getAttribute("width"));
  const height = Number(await bars.last().getAttribute("height"));
  amount = 250;
  await page.clock.fastForward(5000);
  await expect.poll(() => reads).toBe(2);
  await expect(volume.locator(".pc-chart-headline > strong")).toHaveText("250");
  expect(Number(await bars.last().getAttribute("width"))).toBeCloseTo(width, 4);
  expect(Number(await bars.last().getAttribute("height"))).toBeCloseTo(
    height * 2,
    4,
  );
  await first
    .getByRole("button", { name: "Expand First-time depositors chart" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "First-time depositors",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("img").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(dialog.locator(".pc-chart-inspect")).toContainText("0 wallets");
  const event = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download PNG" }).click();
  const download = await event;
  const image = await readFile((await download.path())!);
  expect(image.subarray(1, 4).toString()).toBe("PNG");
  expect(image.readUInt32BE(16)).toBe(1800);
  expect(image.byteLength).toBeGreaterThan(10000);
  await download.saveAs(
    `/tmp/paperclub-depositors-${test.info().project.name}.png`,
  );
  await page.keyboard.press("Escape");
  expect(reads).toBe(2);
  expect(walletReads).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
  });
  await page.locator(".overview-chart-grid").screenshot({
    path: `/tmp/paperclub-deposits-overview-${test.info().project.name}.png`,
  });
  await page.goto("/?view=overview&chart=daily-deposit-volume");
  await expect(
    page.getByRole("dialog", { name: "Deposit volume / day", exact: true }),
  ).toBeVisible();
});

test("catching-up and stale retained history preserve known bars but never invent zero days or recycle yesterday's headline", async ({
  page,
}) => {
  await page.clock.install({ time: at });
  await page.clock.pauseAt(new Date(at));
  await mockSources(page);
  let stale = false,
    outerStale = false;
  await page.route("**/api/protocol/charts", (route) => {
    const data = protocolChartsResponse(at);
    data.deposits!.coverage.pending = !stale;
    data.deposits!.stale = stale && !outerStale;
    data.stale = outerStale;
    // All retained bars precede today; this is not a measured zero for today.
    data.deposits!.days = data.deposits!.days.filter(
      (row) => row.time < Math.floor(at / day) * day,
    );
    return route.fulfill({ json: data });
  });
  await page.goto("/?chart=first-time-depositors");
  const dialog = page.getByRole("dialog", {
    name: "First-time depositors",
    exact: true,
  });
  await expect(dialog.locator(".pc-chart-headline > strong")).toHaveText("—");
  await expect(dialog).toContainText("stored history catching up");
  await expect(dialog.locator(".pc-chart-plot rect[data-partial]")).toHaveCount(
    5,
  );
  await dialog.getByRole("img").focus();
  await page.keyboard.press("End");
  await expect(dialog.locator(".pc-chart-inspect")).toContainText("— wallets");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(dialog.locator(".pc-chart-inspect")).toContainText("— wallets");
  stale = true;
  await page.reload();
  await expect(dialog.locator(".pc-chart-headline > strong")).toHaveText("—");
  await expect(dialog).toContainText("Last available");
  await expect(dialog.locator(".pc-chart-plot rect[data-partial]")).toHaveCount(
    5,
  );
  outerStale = true;
  await page.reload();
  await expect(dialog.locator(".pc-chart-headline > strong")).toHaveText("—");
  await expect(dialog).toContainText("Last available");
});

test("an older collector response leaves both deposit charts unavailable", async ({
  page,
}) => {
  await mockSources(page);
  await page.route("**/api/protocol/charts", (route) => {
    const data = protocolChartsResponse();
    delete data.deposits;
    return route.fulfill({ json: data });
  });
  await page.goto("/");
  for (const title of ["First-time depositors", "Deposit volume / day"]) {
    const card = page.getByRole("region", {
      name: `${title} chart card`,
      exact: true,
    });
    await expect(card.locator(".pc-chart-headline > strong")).toHaveText("—");
    await expect(card).toContainText("Awaiting retained deposit history");
    await expect(card.locator(".pc-chart-plot rect[data-partial]")).toHaveCount(
      0,
    );
  }
});
