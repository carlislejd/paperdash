import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { mockSources, paperEconomicsResponse } from "./fixtures";

test("PAPER uses its own coherent totals and clock, shares daily changes and preserves range without wallet reads", async ({
  page,
}) => {
  const at = Date.UTC(2026, 9, 10, 12, 25);
  await page.clock.install({ time: at });
  await mockSources(page);
  let reads = 0;
  const walletReads: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/wallets/"))
      walletReads.push(request.url());
  });
  await page.route("**/api/house", (route) =>
    route.fulfill({
      status: 503,
      json: { message: "House temporarily unavailable" },
    }),
  );
  await page.route("**/api/paper/economics", (route) => {
    reads++;
    const data = paperEconomicsResponse(at - 5_000);
    data.stakedRaw = "62785687000000000000000000";
    data.stakeRatioBps = 5000;
    return route.fulfill({ json: data });
  });
  await page.goto("/");
  const paper = page.getByRole("region", {
    name: "PAPER economics",
    exact: true,
  });
  await expect(paper).toContainText("125.57M");
  await expect(paper).toContainText("50.00% of supply");
  await expect(paper).toContainText("Rewards allocated");
  await expect(paper).toContainText("$16.27K");
  await expect(paper).toContainText("Pending rewards source-reported");
  await expect(paper.locator(".paper-pending")).toContainText("$324");
  await expect(paper).not.toContainText("LAST AVAILABLE");
  await expect(paper).toContainText(
    "Historical run rate, not APY or a forecast",
  );
  await expect(
    paper.getByRole("region", { name: "PAPER supply chart card" }),
  ).toContainText("12:24 UTC");
  const history = page.getByRole("region", {
    name: "Protocol charts",
    exact: true,
  });
  const daily = history.getByRole("region", {
    name: "Staking rewards / day chart card",
  });
  const growth = history.getByRole("region", {
    name: "PAPER supply growth / day chart card",
  });
  await expect(growth).toContainText(/Net supply (change|growth)/);
  await expect(daily).toContainText(/not (distributions|cash distributions)/);
  await expect(daily).toContainText("Today so far");
  await expect(
    daily.locator('.pc-chart-plot rect[data-partial="true"]'),
  ).toHaveCount(1);
  await expect(daily).toContainText("Daily UTC buckets");
  await expect(
    page.getByRole("region", { name: "TVL chart card", exact: true }),
  ).toHaveCount(0);
  await expect(
    history.locator(".overview-chart-grid > .pc-chart-card"),
  ).toHaveCount(6);
  await expect(
    page.getByRole("region", { name: "PAPER hourly history" }),
  ).toHaveCount(0);
  await page.screenshot({
    path: `/tmp/paperclub-daily-overview-${test.info().project.name}.png`,
    fullPage: false,
  });
  await page.getByRole("button", { name: "7d", exact: true }).click();
  await expect(history).toContainText(/7.*days/);
  const expand = daily.getByRole("button", {
    name: "Expand Staking rewards / day chart",
  });
  await expand.click();
  const dialog = page.getByRole("dialog", { name: "Staking rewards / day" });
  await expect(dialog).toContainText("approximate history");
  await dialog.getByRole("img").focus();
  await page.keyboard.press("End");
  await expect(dialog.locator(".pc-chart-inspect")).toContainText("partial");
  const downloadEvent = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download PNG" }).click();
  const download = await downloadEvent,
    png = await readFile((await download.path())!);
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  expect(png.readUInt32BE(16)).toBe(1800);
  await download.saveAs(
    `/tmp/paperclub-paper-allocation-${test.info().project.name}.png`,
  );
  await page.keyboard.press("Escape");
  await expect(expand).toBeFocused();
  expect(reads).toBeLessThanOrEqual(2);
  expect(walletReads).toEqual([]);
  await page.getByRole("button", { name: "24h", exact: true }).click();
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
  });
  await paper.screenshot({
    path: `/tmp/paperclub-paper-economics-${test.info().project.name}.png`,
  });
  await history.screenshot({
    path: `/tmp/paperclub-paper-history-${test.info().project.name}.png`,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test("zero, unavailable and failed refresh stay distinct while PAPER keeps the last good response", async ({
  page,
}) => {
  const at = Date.now();
  await page.clock.install({ time: at });
  await mockSources(page);
  let failure = false,
    missing = false;
  await page.route("**/api/paper/economics", (route) => {
    if (failure)
      return route.fulfill({
        status: 503,
        json: { message: "Temporarily unavailable" },
      });
    const data = paperEconomicsResponse(at);
    data.supplyRaw = missing ? null : "0";
    data.stakedRaw = missing ? null : "0";
    data.allocatedRewardsRaw = missing ? null : "0";
    data.pendingRewardsRaw = missing ? null : "0";
    data.stakeRatioBps = null;
    data.annualized.usdPerYearRaw = null;
    for (const series of Object.values(data.series)) series.points = [];
    if (data.daily)
      for (const key of ["supplyChange", "rewardAllocation"] as const)
        data.daily[key].points = [];
    return route.fulfill({ json: data });
  });
  await page.goto("/");
  const paper = page.getByRole("region", {
    name: "PAPER economics",
    exact: true,
  });
  await expect(
    paper.locator(".paper-details .pc-chart-headline > strong"),
  ).toHaveText(["0", "0", "$0"]);
  await expect(paper).toContainText("Share unavailable");
  await expect(paper.locator(".paper-pending dd")).toHaveText("$0 USDC");
  failure = true;
  await page.clock.fastForward(30_000);
  await expect(paper.getByRole("status")).toContainText("Saved values shown");
  await expect(paper).toContainText("LAST AVAILABLE");
  await expect(
    paper.locator(".paper-details .pc-chart-headline > strong"),
  ).toHaveText(["0", "0", "$0"]);
  failure = false;
  missing = true;
  await page.clock.fastForward(30_000);
  await expect(
    paper.locator(".paper-details .pc-chart-headline > strong"),
  ).toHaveText(["—", "—", "—"]);
  await expect(paper.locator(".paper-pending dd")).toHaveText("— USDC");
});

test("an older API rollout leaves PAPER unavailable rather than borrowing House totals", async ({
  page,
}) => {
  await mockSources(page);
  await page.route("**/api/paper/economics", (route) =>
    route.fulfill({ status: 404, json: { message: "Not found" } }),
  );
  await page.goto("/?chart=staking-revenue&range=7d");
  const dialog = page.getByRole("dialog", { name: "Rewards allocated" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("7 days");
  await page.keyboard.press("Escape");
  const paper = page.getByRole("region", {
    name: "PAPER economics",
    exact: true,
  });
  await expect(paper.getByRole("status")).toContainText(
    "PAPER economics data is not available yet",
  );
  await expect(
    paper.locator(".paper-details .pc-chart-headline > strong"),
  ).toHaveText(["—", "—", "—"]);
});

test("daily rewards grow inside a full UTC-day slot while missing days, zero and signed supply stay distinct", async ({
  page,
}) => {
  const at = Date.UTC(2026, 9, 10, 12, 25);
  await page.clock.install({ time: at });
  await page.clock.pauseAt(new Date(at));
  await page.addInitScript(() => {
    Math.random = () => 0;
  });
  await mockSources(page);
  let reads = 0,
    amount = 125;
  await page.route("**/api/paper/economics", (route) => {
    reads++;
    const data = paperEconomicsResponse(at);
    data.daily!.rewardAllocation.points.at(-1)!.value = amount;
    data.daily!.rewardAllocation.points.at(-1)!.valueRaw = (
      BigInt(amount) *
      10n ** 18n
    ).toString();
    return route.fulfill({ json: data });
  });
  await page.goto("/?chart=paper-reward-allocation");
  const dialog = page.getByRole("dialog", {
    name: "Staking rewards / day",
    exact: true,
  });
  await expect(dialog).toContainText("Today so far");
  await expect(dialog.locator(".pc-chart-headline > strong")).toHaveText("125");
  await expect(dialog).toContainText("Daily UTC buckets");
  const bars = dialog.locator(".pc-chart-plot rect[data-partial]");
  await expect(bars).toHaveCount(6);
  const partial = bars.last();
  await expect(partial).toHaveAttribute("data-partial", "true");
  const before = await partial.evaluate((e) => ({
    height: Number(e.getAttribute("height")),
    width: Number(e.getAttribute("width")),
  }));
  expect(before.width).toBeCloseTo(
    Number(await bars.first().getAttribute("width")),
    4,
  );
  await dialog.getByRole("img").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await expect(dialog.locator(".pc-chart-inspect")).toContainText("0 USDC");
  await page.keyboard.press("ArrowRight");
  await expect(dialog.locator(".pc-chart-inspect")).toContainText("— USDC");
  await page.keyboard.press("End");
  await expect(dialog.locator(".pc-chart-inspect")).toContainText(
    "10 Oct 2026, 00:00 UTC · bucket start · partial",
  );
  amount = 250;
  const beforeReads = reads;
  await page.clock.fastForward(5000);
  await expect.poll(() => reads).toBe(beforeReads + 1);
  await expect(dialog.locator(".pc-chart-headline > strong")).toHaveText("250");
  expect(Number(await partial.getAttribute("height"))).toBeCloseTo(
    before.height * 2,
    4,
  );
  expect(Number(await partial.getAttribute("width"))).toBeCloseTo(
    before.width,
    4,
  );
  await page.keyboard.press("Escape");
  const growth = page.getByRole("region", {
    name: "PAPER supply growth / day chart card",
    exact: true,
  });
  await growth.getByRole("img").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(growth.locator(".pc-chart-inspect")).toContainText(
    "-2,000,000 PAPER",
  );
});

test("old daily payload stays unavailable without borrowing hourly values or fabricating zero", async ({
  page,
}) => {
  await mockSources(page);
  await page.route("**/api/paper/economics", (route) => {
    const data = paperEconomicsResponse();
    delete data.daily;
    return route.fulfill({ json: data });
  });
  await page.goto("/?chart=paper-supply-change");
  const dialog = page.getByRole("dialog", {
    name: "PAPER supply growth / day",
    exact: true,
  });
  await expect(dialog.locator(".pc-chart-headline > strong")).toHaveText("—");
  await expect(dialog).toContainText("No observations in this range");
  await expect(dialog.locator(".pc-chart-plot rect[data-partial]")).toHaveCount(
    0,
  );
  await page.keyboard.press("Escape");
  const rewards = page.getByRole("region", {
    name: "Staking rewards / day chart card",
    exact: true,
  });
  await expect(rewards.locator(".pc-chart-headline > strong")).toHaveText("—");
  await expect(
    rewards.locator(".pc-chart-plot rect[data-partial]"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "PAPER economics", exact: true }),
  ).toContainText("$16.27K");
});

test("fresh daily history from yesterday cannot become today's headline and today's observed zero stays zero", async ({
  page,
}) => {
  const at = Date.UTC(2026, 9, 11, 0, 0, 15);
  const today = Math.floor(at / 86_400_000) * 86_400_000;
  await page.clock.install({ time: at });
  await page.clock.pauseAt(new Date(at));
  await page.addInitScript(() => {
    Math.random = () => 0;
  });
  await mockSources(page);
  let includeToday = false;
  await page.route("**/api/paper/economics", (route) => {
    const data = paperEconomicsResponse(at);
    for (const key of ["rewardAllocation", "supplyChange"] as const) {
      const series = data.daily![key];
      if (!includeToday)
        series.points = series.points.filter((point) => point.time < today);
      else {
        series.points.at(-1)!.value = 0;
        series.points.at(-1)!.valueRaw = "0";
      }
    }
    return route.fulfill({ json: data });
  });
  await page.goto("/");
  for (const title of ["Staking rewards / day", "PAPER supply growth / day"]) {
    const card = page.getByRole("region", {
      name: `${title} chart card`,
      exact: true,
    });
    await expect(card).toContainText("Today so far");
    await expect(card.locator(".pc-chart-headline > strong")).toHaveText("—");
    await expect(
      card.locator('.pc-chart-plot rect[data-partial="true"]'),
    ).toHaveCount(0);
    await expect(
      card.locator('.pc-chart-plot rect[data-partial="false"]'),
    ).toHaveCount(5);
  }
  includeToday = true;
  await page.clock.fastForward(5000);
  for (const title of ["Staking rewards / day", "PAPER supply growth / day"]) {
    const card = page.getByRole("region", {
      name: `${title} chart card`,
      exact: true,
    });
    await expect(card.locator(".pc-chart-headline > strong")).toHaveText("0");
    await expect(card).toContainText("Today so far");
  }
});
