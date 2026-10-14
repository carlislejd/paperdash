import { expect, test } from "@playwright/test";
import { mockSources, WALLET, walletResponse } from "./fixtures";

function accountWallet(at: number, refreshing = false) {
  const wallet = walletResponse(WALLET, at);
  wallet.snapshot!.indexedThroughTimestamp = Math.floor(at / 1000);
  wallet.accountFreshness = {
    sourceAt: Math.floor(at / 1000) * 1000,
    receivedAt: at,
    stale: refreshing,
    refreshing,
  };
  return wallet;
}

test("a saved PAPER balance catches up promptly and keeps account freshness separate from old history", async ({
  page,
}) => {
  const at = Math.floor(Date.now() / 1000) * 1000;
  await page.clock.install({ time: at });
  await page.clock.pauseAt(at);
  await mockSources(page);
  let reads = 0;
  let old = true;
  await page.route(`**/api/wallets/${WALLET}`, (route) => {
    reads++;
    const wallet = accountWallet(old ? at - 46 * 3600_000 : at, old);
    wallet.snapshot!.paper = old
      ? {
          balance: "380129805385507247748000",
          staked: "4271189322701832493996174",
        }
      : {
          balance: "154000123456789012345678",
          staked: "6000000000000000000000000",
        };
    // Old history must not relabel a newly obtained account snapshot as old.
    wallet.receivedAt = at - 46 * 3600_000;
    wallet.stale = true;
    return route.fulfill({ json: wallet });
  });
  await page.goto(`/?wallet=${WALLET}`);
  const drawer = page.locator(".wd-drawer");
  const clock = drawer.getByRole("status", {
    name: "Account snapshot freshness",
  });
  const ownership = drawer
    .locator(".wd-metrics > div")
    .filter({ has: page.getByText("Total PAPER owned", { exact: true }) });
  await expect(ownership.locator("dd")).toHaveText("4,651,319.12");
  await expect(clock).toContainText("Updating account balances…");
  await expect(clock).toContainText("As of 1d ago");
  const initialReads = reads;
  old = false;
  await page.clock.runFor(2_100);
  await expect(ownership.locator("dd")).toHaveText("6,154,000.12");
  await expect(ownership.locator("dd")).toHaveAttribute(
    "title",
    "6,154,000.123456789012345678 PAPER",
  );
  await expect(ownership).toContainText(
    "Unstaked 154,000.12 · Staked 6,000,000",
  );
  await expect(clock).toHaveText(
    "Account snapshotAs of Just now · Checked Just now",
  );
  await expect(drawer).toContainText(
    "Account balances are current. Some history may be delayed.",
  );
  await page.clock.runFor(5_000);
  expect(reads).toBe(initialReads + 1);
  expect(
    await drawer.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await drawer.screenshot({
    path: `/tmp/paperclub-wallet-freshness-${test.info().project.name}.png`,
  });
});

test("account rechecks are bounded and stop when the drawer closes", async ({
  page,
}) => {
  const at = Math.floor(Date.now() / 1000) * 1000;
  await page.clock.install({ time: at });
  await page.clock.pauseAt(at);
  await mockSources(page);
  let reads = 0;
  await page.route(`**/api/wallets/${WALLET}`, (route) => {
    reads++;
    return route.fulfill({ json: accountWallet(at - 46 * 3600_000, true) });
  });
  await page.goto(`/?wallet=${WALLET}`);
  await expect(
    page.getByRole("status", { name: "Account snapshot freshness" }),
  ).toContainText("Updating account balances…");
  const initialReads = reads;
  await page.clock.runFor(2_100);
  await expect.poll(() => reads).toBe(initialReads + 1);
  await page.clock.runFor(2_100);
  await expect.poll(() => reads).toBe(initialReads + 2);
  await page.clock.runFor(5_000);
  expect(reads).toBe(initialReads + 2);
  await page.getByRole("button", { name: "Refresh wallet details" }).click();
  await expect.poll(() => reads).toBe(initialReads + 3);
  await page.getByRole("button", { name: "Close wallet details" }).click();
  await page.clock.runFor(20_000);
  expect(reads).toBe(initialReads + 3);
});

test("a retained newer account never borrows the rejected response's fresh clock", async ({
  page,
}) => {
  const at = Math.floor(Date.now() / 1000) * 1000;
  const old = at - 46 * 3600_000;
  await page.clock.install({ time: at });
  await page.clock.pauseAt(at);
  await mockSources(page);
  let reads = 0;
  let initial = true;
  await page.route(`**/api/wallets/${WALLET}`, (route) => {
    reads++;
    const wallet = accountWallet(initial ? old : at);
    wallet.snapshot!.accountRevision = initial ? 5 : 4;
    wallet.snapshot!.paper.staked = initial
      ? "6000000000000000000000000"
      : "4000000000000000000000000";
    return route.fulfill({ json: wallet });
  });
  await page.goto(`/?wallet=${WALLET}`);
  const clock = page.getByRole("status", {
    name: "Account snapshot freshness",
  });
  await expect(clock).toContainText("As of 1d ago");
  const initialReads = reads;
  initial = false;
  await page.clock.runFor(15_100);
  await expect.poll(() => reads).toBe(initialReads + 1);
  await expect(clock).toHaveText(
    "Saved account snapshotAs of 1d ago · Checked 1d ago",
  );
  await expect(page.locator(".wd-metrics")).toContainText("6,000,000");
  await expect(page.locator(".wd-metrics")).not.toContainText("4,000,000");
});

test("legacy responses without an account receipt are not labeled freshly checked", async ({
  page,
}) => {
  const at = Math.floor(Date.now() / 1000) * 1000;
  await page.clock.install({ time: at });
  await page.clock.pauseAt(at);
  await mockSources(page);
  await page.route(`**/api/wallets/${WALLET}`, (route) => {
    const wallet = accountWallet(at);
    delete wallet.accountFreshness;
    return route.fulfill({ json: wallet });
  });
  await page.goto(`/?wallet=${WALLET}`);
  await expect(
    page.getByRole("status", { name: "Account snapshot freshness" }),
  ).toHaveText("Saved account snapshotAs of Just now · Check time unavailable");
});

test("old history does not cause repeated hover fetches of a just-loaded account", async ({
  page,
}) => {
  const at = Math.floor(Date.now() / 1000) * 1000;
  await page.clock.install({ time: at });
  await page.clock.pauseAt(at);
  await mockSources(page);
  let reads = 0;
  await page.route(`**/api/wallets/${WALLET}`, (route) => {
    reads++;
    const wallet = accountWallet(at);
    wallet.receivedAt = at - 46 * 3600_000;
    wallet.stale = true;
    return route.fulfill({ json: wallet });
  });
  await page.goto(`/?view=wallets&wallet=${WALLET}`);
  await expect(
    page.getByRole("status", { name: "Account snapshot freshness" }),
  ).toContainText("Checked Just now");
  const initialReads = reads;
  await page.getByRole("button", { name: "Close wallet details" }).click();
  const row = page.getByRole("button", { name: /^Aoi / });
  await row.hover();
  await page.clock.runFor(100);
  await page.getByRole("button", { name: "paperclub overview" }).hover();
  await row.hover();
  await page.clock.runFor(100);
  expect(reads).toBe(initialReads);
  await page.getByRole("button", { name: "paperclub overview" }).hover();
  await page.clock.runFor(16_000);
  await row.hover();
  await page.clock.runFor(100);
  await expect.poll(() => reads).toBe(initialReads + 1);
});

test("a failed account recheck returns to normal polling without masking the error", async ({
  page,
}) => {
  const at = Math.floor(Date.now() / 1000) * 1000;
  await page.clock.install({ time: at });
  await page.clock.pauseAt(at);
  await mockSources(page);
  let reads = 0;
  let failed = false;
  await page.route(`**/api/wallets/${WALLET}`, (route) => {
    reads++;
    return failed
      ? route.fulfill({ status: 500, json: { error: "Unavailable" } })
      : route.fulfill({ json: accountWallet(at, true) });
  });
  await page.goto(`/?wallet=${WALLET}`);
  const clock = page.getByRole("status", {
    name: "Account snapshot freshness",
  });
  await expect(clock).toContainText("Updating account balances…");
  const initialReads = reads;
  failed = true;
  await page.clock.runFor(2_100);
  await expect(page.locator(".wd-error")).toContainText(
    "This wallet could not be refreshed",
  );
  await expect(clock).toContainText("Saved account snapshot");
  await expect(clock).not.toContainText("Updating account balances…");
  await page.clock.runFor(5_000);
  expect(reads).toBe(initialReads + 1);
});
