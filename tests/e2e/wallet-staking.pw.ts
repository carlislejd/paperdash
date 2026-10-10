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
    "Pending rewards",
    "Claimed rewards",
  ]);
  await expect(staking.locator("dd")).toHaveText(["9,876.54", "—", "$12.35"]);
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
    "Pending rewards aren't available in this view yet.",
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
  await expect(staking.locator("dd")).toHaveText(["0", "—", "$0.00"]);
});

test("wallet staking preserves missing snapshot values", async ({ page }) => {
  await mockSources(page, { missingWalletSnapshot: true });
  await page.goto(`/?view=wallets&wallet=${WALLET}`);
  const staking = page.getByRole("region", {
    name: "PAPER staking",
    exact: true,
  });
  await expect(staking.locator("dd")).toHaveText(["—", "—", "—"]);
  await expect(staking).toContainText("UNAVAILABLE");
  await expect(staking).not.toContainText("$0.00");
});
