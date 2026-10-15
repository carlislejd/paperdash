import { expect, test, type Page } from "@playwright/test";
import { mockSources, WALLET, walletResponse } from "./fixtures";

const raw = (value: number) => (BigInt(value) * 10n ** 18n).toString();

async function openWallet(
  page: Page,
  options: {
    missingPending?: boolean;
    activeBalances?: boolean;
    large?: boolean;
  } = {},
) {
  const at = Math.floor(Date.now() / 1000) * 1000;
  await page.clock.install({ time: at });
  await page.clock.pauseAt(at);
  await mockSources(page);
  await page.route(`**/api/wallets/${WALLET}`, (route) => {
    const wallet = walletResponse(WALLET, at);
    wallet.leaderboardName = "pk";
    wallet.snapshot!.indexedThroughTimestamp = at / 1000;
    wallet.accountFreshness = {
      sourceAt: at,
      receivedAt: at,
      stale: false,
      refreshing: false,
    };
    wallet.stale = true;
    wallet.errors = ["Closed trades: history pending"];
    wallet.snapshot!.balance = "0";
    wallet.snapshot!.lifetime.depositedRaw = "99888530000000000000000";
    wallet.snapshot!.lifetime.realizedPnlRaw = raw(1250);
    wallet.snapshot!.lifetime.paperRewardsClaimedRaw = raw(300);
    wallet.snapshot!.paper = {
      balance: "0",
      staked: "7007532560000000000000000",
    };
    wallet.stakingRewards = {
      pendingRaw: options.missingPending ? null : raw(200),
      sourceAt: at,
      receivedAt: at,
      stale: false,
    };
    if (options.missingPending) {
      // This legacy PAPER field must not substitute for pending USDC rewards.
      wallet.snapshot!.paper.pendingBase = raw(99);
    }
    if (options.activeBalances) {
      wallet.snapshot!.locked = raw(2500);
      wallet.snapshot!.queued = raw(750);
    }
    if (options.large) {
      wallet.snapshot!.balance = raw(12_345_678_901);
      wallet.snapshot!.lifetime.realizedPnlRaw = raw(-10_000_000_000);
      wallet.snapshot!.lifetime.paperRewardsClaimedRaw = "0";
      wallet.stakingRewards.pendingRaw = "0";
      wallet.snapshot!.paper = {
        balance: raw(40_000_000_000),
        staked: raw(50_000_000_000),
      };
    }
    return route.fulfill({ json: wallet });
  });
  await page.goto(`/?wallet=${WALLET}`);
  const drawer = page.locator(".wd-drawer");
  await expect(
    drawer.getByRole("region", { name: "Wallet performance", exact: true }),
  ).toBeVisible();
  return drawer;
}

test("wallet leads with combined performance and keeps zero balances in account details", async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === "desktop") {
    await page.setViewportSize({ width: 1280, height: 1000 });
  }
  const drawer = await openWallet(page);
  const performance = drawer.getByRole("region", {
    name: "Wallet performance",
    exact: true,
  });
  await expect(performance.locator(".wd-performance-value")).toHaveText(
    "+$1,750.00",
  );
  await expect(performance).toContainText("Lifetime realized trading + rewards");
  await expect(performance).toContainText("+$1,250.00");
  await expect(performance).toContainText("+$500.00");
  await expect(performance).toContainText("Claimed + pending · USDC");
  const balances = drawer.locator(".wd-metrics");
  await expect(balances).toContainText("Available balance");
  await expect(balances).toContainText("Total PAPER owned");
  await expect(balances).toContainText("7,007,532.56");
  await expect(balances).not.toContainText("Locked margin");
  await expect(balances).not.toContainText("Queued claims");
  const deposits = drawer.getByRole("region", {
    name: "Lifetime credited deposits",
  });
  await expect(deposits).toBeVisible();
  await expect(deposits).toContainText("$99,888.53");
  await expect(drawer.locator(".wd-active-balances")).toHaveCount(0);
  const details = drawer.locator("details.wd-account-details");
  const locked = details.locator("dl > div").filter({ hasText: "Locked margin" });
  const queued = details.locator("dl > div").filter({ hasText: "Queued claims" });
  await expect(locked).toBeHidden();
  await expect(queued).toBeHidden();
  await details.locator("summary").click();
  await expect(locked).toBeVisible();
  await expect(queued).toBeVisible();
  await expect(locked.locator("dd")).toHaveText("$0.00");
  await expect(queued.locator("dd")).toHaveText("$0.00");
  await details.locator("summary").click();
  await expect(locked).toBeHidden();
  await expect(
    drawer.getByRole("button", { name: "Share P&L card ↗" }),
  ).toBeVisible();
  expect(
    await drawer.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  await drawer.evaluate((element) => {
    element.scrollTop = 0;
  });
  await drawer.screenshot({
    path: `/tmp/paperclub-wallet-redesign-${testInfo.project.name}.png`,
    scale: "css",
  });
});

test("unavailable pending rewards do not become zero or a partial total", async ({
  page,
}) => {
  const drawer = await openWallet(page, { missingPending: true });
  const performance = drawer.getByRole("region", { name: "Wallet performance" });
  await expect(performance.locator(".wd-performance-value")).toHaveText("—");
  await expect(performance).toContainText("Pending rewards unavailable");
  await expect(performance).toContainText("+$1,250.00");
  await expect(performance).toContainText("Claimed +$300.00 · pending unavailable");
  await expect(performance).not.toContainText("$0.00");
  await expect(performance).not.toContainText("+$1,550.00");
});

test("locked margin and queued claims surface when funds are active", async ({
  page,
}) => {
  const drawer = await openWallet(page, { activeBalances: true });
  const active = drawer.locator(".wd-active-balances");
  await expect(active).toBeVisible();
  await expect(active.getByText("Locked margin", { exact: true })).toBeVisible();
  await expect(active.getByText("Queued claims", { exact: true })).toBeVisible();
  await expect(active).toContainText("$2,500.00");
  await expect(active).toContainText("$750.00");
});

test("large signed totals and account balances fit the wallet on every viewport", async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === "desktop") {
    await page.setViewportSize({ width: 1280, height: 1000 });
  }
  const drawer = await openWallet(page, { large: true });
  const total = drawer.locator(".wd-performance-value");
  await expect(total).toHaveText("−$10,000,000,000.00");
  await expect(drawer.locator(".wd-metrics")).toContainText("$12,345,678,901.00");
  await expect(drawer.locator(".wd-metrics")).toContainText("90,000,000,000");
  await page.evaluate(async () => { await document.fonts.ready; });
  const viewport = page.viewportSize()!;
  const widths = testInfo.project.name === "mobile"
    ? [viewport.width, 320]
    : [viewport.width];
  for (const width of widths) {
    await page.setViewportSize({ width, height: viewport.height });
    for (const element of [drawer, total, drawer.locator(".wd-metrics")]) {
      expect(
        await element.evaluate((node) => node.scrollWidth - node.clientWidth),
      ).toBeLessThanOrEqual(1);
    }
    for (const amount of await drawer
      .locator(".wd-performance-value, .wd-performance-breakdown dd, .wd-metrics dd")
      .all()) {
      const size = await amount.evaluate((node) => ({
        overflow: node.scrollWidth - node.clientWidth,
        height: node.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(getComputedStyle(node).lineHeight),
      }));
      const label = `${width}px: ${await amount.textContent()}`;
      expect(size.overflow, label).toBeLessThanOrEqual(1);
      expect(size.height, `${label} stays on one line`).toBeLessThanOrEqual(
        size.lineHeight + 1,
      );
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await drawer.screenshot({
      path: `/tmp/paperclub-wallet-redesign-large-${testInfo.project.name}${width === 320 ? "-320" : ""}.png`,
      scale: "css",
    });
  }
});
