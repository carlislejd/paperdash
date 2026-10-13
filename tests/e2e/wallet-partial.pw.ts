import { expect, test } from "@playwright/test";
import { mockSources, SECOND_WALLET, WALLET, walletResponse } from "./fixtures";

function savedWallet(at: number) {
  const wallet = walletResponse(WALLET, at);
  wallet.snapshot!.indexedThroughTimestamp = Math.floor(at / 1000);
  wallet.trades = {
    items: [
      {
        id: "saved-close",
        positionId: "42",
        symbol: "BTC",
        isLong: true,
        kind: "PositionClosed",
        leverage: 10,
        timestampMs: at - 60_000,
        adjustedPnlRaw: "1250000000000000000000",
      },
    ],
    nextCursor: null,
    receivedAt: at,
    stale: false,
  };
  return wallet;
}

test("a partial refresh preserves each failed source but a valid empty result clears it", async ({
  page,
}) => {
  const at = Date.now();
  await page.clock.install({ time: at });
  await mockSources(page);
  let mode: "saved" | "failed" | "empty" = "saved";
  let reads = 0;
  await page.route(`**/api/wallets/${WALLET}`, (route) => {
    reads++;
    const wallet = savedWallet(at);
    if (mode !== "saved") {
      wallet.cashflows = { items: [], nextCursor: null };
      wallet.trades = { items: [], nextCursor: null };
      wallet.portfolio = null;
      if (mode === "failed") {
        wallet.snapshot = null;
        wallet.stale = true;
        wallet.errors = [
          "Live account: temporarily unavailable",
          "Cashflows: read failed",
          "Closed trades: read failed",
          "Portfolio: read failed",
        ];
      }
    }
    return route.fulfill({ json: wallet });
  });
  await page.goto(`/?wallet=${WALLET}`);
  const drawer = page.locator(".wd-drawer");
  const portfolio = drawer.getByRole("region", {
    name: "Recorded wallet history",
  });
  await expect(
    drawer.getByText("Credited deposit", { exact: true }),
  ).toHaveCount(1);
  await expect(portfolio.getByRole("img")).toHaveCount(1);
  mode = "failed";
  const before = reads;
  await page.clock.fastForward(15_001);
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(
    drawer.getByText("Credited deposit", { exact: true }),
  ).toHaveCount(1);
  await expect(
    drawer.getByText("Cashflows could not be refreshed.", { exact: false }),
  ).toBeVisible();
  await expect(portfolio.getByRole("img")).toHaveCount(1);
  await expect(portfolio).toContainText("Last available history shown");
  await drawer.getByRole("tab", { name: /Closed trades/ }).click();
  await expect(drawer.locator(".wd-history-row")).toHaveCount(1);
  await expect(
    drawer.getByText("Closed trades could not be refreshed.", { exact: false }),
  ).toBeVisible();
  await expect(
    drawer.getByRole("region", { name: "Lifetime credited deposits" }),
  ).toContainText("$10,779.00");

  mode = "empty";
  await page.clock.fastForward(15_001);
  await expect(drawer).toContainText("No closed trades to show yet.");
  await expect(drawer.locator(".wd-history-row")).toHaveCount(0);
  await expect(portfolio.getByRole("img")).toHaveCount(0);
  await drawer.getByRole("tab", { name: /Deposits & withdrawals/ }).click();
  await expect(drawer).toContainText("No cashflows to show yet.");
});

test("cold profiles expose retained trades and distinguish failed indexing without leaking another wallet", async ({
  page,
}) => {
  const at = Date.now();
  await mockSources(page);
  await page.route(`**/api/wallets/${WALLET}`, (route) => {
    const wallet = savedWallet(at);
    wallet.snapshot = null;
    wallet.stale = true;
    wallet.portfolio = null;
    wallet.errors = [
      "Live account: Live account snapshot is being collected.",
      "Portfolio: Portfolio history is being indexed.",
    ];
    wallet.cashflows = {
      items: [],
      nextCursor: null,
      coverage: {
        indexing: true,
        backfillComplete: false,
        sourceComplete: null,
        identity: "source-fields-and-occurrence",
        identityAmbiguous: true,
        retainedCount: 0,
        lastIndexedAt: null,
        error: "Source temporarily unavailable",
      },
    };
    return route.fulfill({ json: wallet });
  });
  await page.route(`**/api/wallets/${SECOND_WALLET}`, (route) => {
    const wallet = walletResponse(SECOND_WALLET, at);
    wallet.snapshot = null;
    wallet.cashflows = { items: [], nextCursor: null };
    wallet.trades = { items: [], nextCursor: null };
    wallet.portfolio = null;
    wallet.stale = true;
    wallet.errors = ["Live account: unavailable", "Closed trades: unavailable"];
    return route.fulfill({ json: wallet });
  });
  await page.goto(`/?wallet=${WALLET}`);
  const drawer = page.locator(".wd-drawer");
  await expect(drawer).toContainText(
    "Account snapshot is being collected. Retained history is shown below.",
  );
  await expect(drawer).toContainText("Portfolio history is being indexed.");
  await expect(drawer).toContainText("This history is unavailable.");
  await expect(drawer).not.toContainText("Indexing account history…");
  await drawer.getByRole("tab", { name: /Closed trades/ }).click();
  await expect(drawer.locator(".wd-history-row")).toHaveCount(1);
  await expect(drawer.locator(".wd-history-row")).toContainText("$1,250.00");
  await page.evaluate((address) => {
    history.pushState(null, "", `/?wallet=${address}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, SECOND_WALLET);
  await expect(
    drawer.getByRole("button", {
      name: `Copy wallet address ${SECOND_WALLET}`,
    }),
  ).toBeVisible();
  await drawer.getByRole("tab", { name: /Closed trades/ }).click();
  await expect(drawer).toContainText("This history is unavailable.");
  await expect(drawer.locator(".wd-history-row")).toHaveCount(0);
  await expect(
    drawer.getByRole("region", { name: "Lifetime credited deposits" }),
  ).toContainText("—");
});

test("a failed hover prefetch preserves bounded history when reopening a wallet", async ({
  page,
}) => {
  const at = Date.now();
  await page.clock.install({ time: at });
  await mockSources(page);
  let failed = false;
  let reads = 0;
  await page.route(`**/api/wallets/${WALLET}`, (route) => {
    reads++;
    const wallet = savedWallet(at);
    if (failed) {
      wallet.cashflows = { items: [], nextCursor: null };
      wallet.trades = { items: [], nextCursor: null };
      wallet.portfolio = null;
      wallet.stale = true;
      wallet.errors = [
        "Cashflows: unavailable",
        "Closed trades: unavailable",
        "Portfolio: unavailable",
      ];
    }
    return route.fulfill({ json: wallet });
  });
  await page.goto(`/?view=wallets&wallet=${WALLET}`);
  const drawer = page.locator(".wd-drawer");
  await expect(
    drawer.getByText("Credited deposit", { exact: true }),
  ).toHaveCount(1);
  // Appended rows stay in the open drawer; reopening retains only the head.
  await drawer.getByRole("button", { name: "Load older activity" }).click();
  await expect(
    drawer.getByText("Credited deposit", { exact: true }),
  ).toHaveCount(2);
  await drawer.getByRole("button", { name: "Close wallet details" }).click();
  failed = true;
  await page.clock.fastForward(16_000);
  const before = reads;
  await page.getByRole("button", { name: /^Aoi / }).hover();
  await page.clock.runFor(100);
  await expect.poll(() => reads).toBeGreaterThan(before);
  await page.getByRole("button", { name: /^Aoi / }).click();
  await expect(
    drawer.getByText("Cashflows could not be refreshed.", { exact: false }),
  ).toBeVisible();
  await expect(
    drawer.getByText("Credited deposit", { exact: true }),
  ).toHaveCount(1);
  await expect(
    drawer
      .getByRole("region", { name: "Recorded wallet history" })
      .getByRole("img"),
  ).toHaveCount(1);
  await drawer.getByRole("tab", { name: /Closed trades/ }).click();
  await expect(drawer.locator(".wd-history-row")).toHaveCount(1);
  await expect(drawer.locator(".wd-history-row")).toContainText("$1,250.00");
});
