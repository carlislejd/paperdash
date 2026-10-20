import { expect, test } from "@playwright/test";
import { mockSources, WALLET, walletResponse } from "./fixtures";

test("wallet staking shows PAPER and lifetime claimed USDC without treating pendingBase as claimable rewards", async ({
  page,
}) => {
  await page.clock.install();
  await mockSources(page);
  const wallet = walletResponse();
  wallet.stale = true;
  wallet.snapshot!.paper.staked = "9876543210000000000000";
  wallet.snapshot!.paper.pendingBase = "99000000000000000000";
  wallet.snapshot!.lifetime.paperRewardsClaimedRaw = "12345678901234567890";
  await page.route(`**/api/wallets/${WALLET}`, (route) =>
    route.fulfill({ json: wallet }),
  );
  await page.goto(`/?view=wallets&wallet=${WALLET}`);
  const staking = page.getByRole("region", {
    name: "PAPER staking",
    exact: true,
  });
  await expect(staking.locator("dt")).toHaveText([
    "Amount staked",
    "Share of staked PAPER",
    "Pending rewards",
    "Claimed rewards",
  ]);
  await expect(staking.locator("dd")).toHaveText(["9,876.54", "—", "—", "$12.35"]);
  await expect(staking.locator("dd").first()).toHaveAttribute(
    "title",
    "9,876.54321 PAPER",
  );
  await expect(staking.locator("dd").last()).toHaveAttribute(
    "title",
    "12.34567890123456789 USDC",
  );
  await expect(staking).toContainText("USDC · lifetime");
  await expect(staking).toContainText("LAST AVAILABLE");
  await expect(staking).toContainText(
    "Pending rewards are unavailable for this snapshot.",
  );
  await expect(staking).not.toContainText("$99.00");
  expect(
    await page
      .getByRole("dialog")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await staking.screenshot({
    path: `/tmp/paperclub-wallet-staking-${test.info().project.name}.png`,
  });
});

test("wallet staking keeps a genuine zero distinct from unavailable pending rewards", async ({
  page,
}) => {
  await mockSources(page);
  await page.goto(`/?view=wallets&wallet=${WALLET}`);
  const staking = page.getByRole("region", {
    name: "PAPER staking",
    exact: true,
  });
  await expect(staking.locator("dd")).toHaveText(["0", "—", "—", "$0.00"]);
});

test("wallet staking preserves missing snapshot values", async ({ page }) => {
  await mockSources(page, { missingWalletSnapshot: true });
  await page.goto(`/?view=wallets&wallet=${WALLET}`);
  const staking = page.getByRole("region", {
    name: "PAPER staking",
    exact: true,
  });
  await expect(staking.locator("dd")).toHaveText(["—", "—", "—", "—"]);
  await expect(staking).toContainText("UNAVAILABLE");
  await expect(staking).not.toContainText("$0.00");
});

test("wallet staking uses verified pending rewards and preserves their delayed status", async ({ page }) => {
  await mockSources(page);
  const wallet = walletResponse();
  wallet.snapshot!.paper.pendingBase = "99000000000000000000";
  wallet.stakingRewards = {
    pendingRaw: "12345678901234567890",
    receivedAt: Date.now() - 60000,
    sourceAt: Date.now() - 60000,
    stale: true,
  };
  await page.route(`**/api/wallets/${WALLET}`, route => route.fulfill({ json: wallet }));
  await page.goto(`/?view=wallets&wallet=${WALLET}`);
  const staking = page.getByRole("region", { name: "PAPER staking", exact: true });
  await expect(staking.locator("dd")).toHaveText(["0", "—", "$12.35", "$0.00"]);
  await expect(staking.locator("dd").nth(2)).toHaveAttribute("title", "12.34567890123456789 USDC");
  await expect(staking).toContainText("USDC · delayed");
  await expect(staking).toContainText("Pending rewards have been distributed and are available to claim.");
  await expect(staking).not.toContainText("$99.00");
});

test("an older refresh keeps claimed and pending rewards paired with the saved account and cached card", async ({
  page,
}) => {
  const at = Math.floor(Date.now() / 1000) * 1000;
  const raw = (value: number) => (BigInt(value) * 10n ** 18n).toString();
  await page.clock.install({ time: at });
  await page.clock.pauseAt(at);
  await mockSources(page);
  let older = false;
  let reads = 0;
  await page.route(`**/api/wallets/${WALLET}`, (route) => {
    reads++;
    const sourceAt = older ? at - 60_000 : at;
    const wallet = walletResponse(WALLET, sourceAt);
    wallet.snapshot!.accountRevision = older ? 2 : 3;
    wallet.snapshot!.indexedThroughBlock = older ? 12344 : 12345;
    wallet.snapshot!.indexedThroughTimestamp = sourceAt / 1000;
    wallet.snapshot!.paper.staked = raw(older ? 20 : 10);
    wallet.snapshot!.lifetime.realizedPnlRaw = raw(older ? -10_000 : -200_000);
    wallet.snapshot!.lifetime.paperRewardsClaimedRaw = raw(older ? 50_000 : 100_000);
    wallet.accountFreshness = {
      sourceAt,
      receivedAt: older ? at + 15_000 : at,
      stale: false,
      refreshing: false,
    };
    wallet.stakingParticipation = {
      walletStakedRaw: raw(older ? 20 : 10),
      totalStakedRaw: raw(older ? 200 : 1000),
      receivedAt: older ? at + 15_000 : at,
      sourceAt,
      stale: false,
    };
    wallet.stakingRewards = {
      pendingRaw: raw(older ? 900_000 : 200_000),
      receivedAt: older ? at + 15_000 : at,
      sourceAt,
      stale: false,
    };
    return route.fulfill({ json: wallet });
  });
  await page.goto("/?view=wallets");
  await page.getByRole("button", { name: /^Aoi / }).click();
  const drawer = page.locator(".wd-drawer");
  const staking = page.getByRole("region", {
    name: "PAPER staking",
    exact: true,
  });
  await expect(staking.locator("dd")).toHaveText([
    "10",
    "1%",
    "$200,000.00",
    "$100,000.00",
  ]);
  await expect(staking).toContainText("USDC · claimable");

  const initialReads = reads;
  older = true;
  await page.clock.runFor(16_000);
  await expect.poll(() => reads).toBeGreaterThan(initialReads);
  await expect(staking.locator("dd")).toHaveText([
    "10",
    "1%",
    "$200,000.00",
    "$100,000.00",
  ]);
  await expect(staking).toContainText("USDC · delayed");
  await expect(staking).toContainText("LAST AVAILABLE");

  // Reopening uses the retained cached account and its matching rewards.
  const readsAfterRefresh = reads;
  await drawer.getByRole("button", { name: "Close wallet details" }).click();
  await page.getByRole("button", { name: /^Aoi / }).click();
  await expect(staking.locator("dd")).toHaveText([
    "10",
    "1%",
    "$200,000.00",
    "$100,000.00",
  ]);
  await expect(staking).toContainText("USDC · delayed");
  expect(reads).toBe(readsAfterRefresh);

  await drawer.getByRole("button", { name: "Share P&L card ↗" }).click();
  const card = page.getByRole("dialog", { name: "Your P&L card" });
  let advanced = 0;
  await expect.poll(async () => {
    if (advanced < 2000) {
      await page.clock.runFor(50);
      advanced += 50;
    }
    return card.getByRole("button", { name: "Download PNG" }).isEnabled();
  }, { timeout: 15_000 }).toBe(true);
  await expect(card.locator(".pnl-preview img")).toHaveAttribute(
    "alt",
    "WALLET HIDDEN · +$100,000.00 total P&L · −$200,000.00 realized trading P&L · +$300,000.00 rewards (Claimed + pending · USDC · delayed) · 10.00 PAPER owned · $0.00 Unrecovered trading loss (USDC after rewards · last available)",
  );
  await expect(card.locator(".pnl-accessible-summary")).not.toContainText("900,000");
  expect(reads).toBe(readsAfterRefresh);
});

test("current staking share remains precise and falls when the pool grows without adding a reward forecast", async ({ page }) => {
  const at = Math.floor(Date.now() / 1000) * 1000;
  await page.clock.install({ time: at });
  await page.clock.pauseAt(at);
  await mockSources(page);
  let phase = 0;
  let reads = 0;
  await page.route(`**/api/wallets/${WALLET}`, route => {
    reads++;
    const sourceAt = at + phase * 16_000;
    const wallet = walletResponse(WALLET, sourceAt);
    wallet.snapshot!.indexedThroughTimestamp = sourceAt / 1000;
    wallet.accountFreshness = { sourceAt, receivedAt: sourceAt, stale: false, refreshing: false };
    wallet.stale = true;
    wallet.errors = ["Closed trades: awaiting history"];
    wallet.snapshot!.paper.staked = "1000000000000000000";
    wallet.stakingParticipation = {
      walletStakedRaw: wallet.snapshot!.paper.staked,
      totalStakedRaw: phase === 0 ? "1000000000000000000000000" : "2000000000000000000000000",
      sourceAt, receivedAt: sourceAt, stale: phase === 2,
    };
    return route.fulfill({ json: wallet });
  });
  await page.goto(`/?view=wallets&wallet=${WALLET}`);
  const staking = page.getByRole("region", { name: "PAPER staking", exact: true });
  const share = staking.locator(".wd-staking-metrics > div").filter({ has: page.locator("dt", { hasText: "Share of staked PAPER" }) });
  await expect(share.locator("dd")).toHaveText("0.0001%");
  await expect(share).toContainText("Current snapshot");
  await expect(share.locator("dd")).toHaveAttribute("title", /1 of 1,000,000 staked PAPER · Observed/);
  await expect(staking).toContainText("An unchanged stake represents a smaller share when the staking pool grows.");
  const firstReads = reads;
  phase = 1;
  await page.clock.runFor(16_000);
  await expect.poll(() => reads).toBeGreaterThan(firstReads);
  await expect(share.locator("dd")).toHaveAttribute("title", new RegExp(new Date(at + 16_000).toISOString().slice(11, 19)));
  await expect(staking.locator("dd").first()).toHaveText("1");
  await expect(share.locator("dd")).toHaveText("5 × 10⁻⁵%");
  const secondReads = reads;
  phase = 2;
  await page.clock.runFor(16_000);
  await expect.poll(() => reads).toBeGreaterThan(secondReads);
  expect(await page.evaluate(() => Date.now())).toBe(at + 32000);
  await expect(share.locator("dd")).toHaveAttribute("title", new RegExp(new Date(at + 32_000).toISOString().slice(11, 19)));
  await expect(share).toContainText("Last available");
  await expect(share.locator("dd")).toHaveText("5 × 10⁻⁵%");
  expect(await page.getByRole("dialog").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await staking.screenshot({ path: `/tmp/paperclub-wallet-pool-share-${test.info().project.name}.png` });
});

test("zero staking share and an empty pool remain distinct", async ({ page }) => {
  await mockSources(page);
  const wallet = walletResponse();
  wallet.stakingParticipation = {
    walletStakedRaw: "0", totalStakedRaw: "1000000000000000000",
    sourceAt: Date.now(), receivedAt: Date.now(), stale: false,
  };
  await page.route(`**/api/wallets/${WALLET}`, route => route.fulfill({ json: wallet }));
  await page.goto(`/?view=wallets&wallet=${WALLET}`);
  const staking = page.getByRole("region", { name: "PAPER staking", exact: true });
  await expect(staking.locator("dd").nth(1)).toHaveText("0%");
  wallet.stakingParticipation.totalStakedRaw = "0";
  await page.reload();
  await expect(staking.locator("dd").nth(1)).toHaveText("—");
  await expect(staking.getByLabel("Staking pool share unavailable")).toBeVisible();
});
