import { expect, test } from "@playwright/test";
import type { WalletBatchResponse } from "../../packages/shared/src/types";
import { account, mockSources, WALLET, SECOND_WALLET } from "./fixtures";

const raw = (n: number) => (BigInt(n) * 10n ** 18n).toString();
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
function batch(addresses: string[], balance = 100): WalletBatchResponse {
  const at = Date.now();
  return {
    rows: addresses.map((address) => ({
      address,
      account: {
        ...account(address, address === WALLET ? "Aoi" : "Yuki"),
        currentBalance: raw(balance),
        currentUnrealizedPnl: raw(12),
        currentOpenPositionCount: 2,
      },
      sourceAt: null,
      receivedAt: at,
      stale: false,
      refreshQueued: false,
    })),
    activity: {
      items: addresses.map((wallet, i) => ({
        id: `trade-${wallet}`,
        wallet,
        ts: at - i * 1000,
        instrument: 0,
        side: "long",
        leverage: 10,
        notionalUsd: 10000,
        kind: "open",
        pnlUsd: 0,
        provenance: "public-stream",
      })),
      windowFrom: at - 86400000,
      windowTo: at,
      receivedAt: at,
      stale: false,
      coverage: {
        source: "retained-public-observations",
        partial: true,
        identityAmbiguous: true,
        projectionBackfillComplete: true,
        observedFrom: at - 86400000,
        truncated: false,
      },
    },
    receivedAt: at,
    stale: false,
  };
}

test("legacy follows become identities and one visible batch refreshes current values while errors preserve last good data", async ({
  page,
}) => {
  await page.setViewportSize({
    width: test.info().project.name === "desktop" ? 1440 : 393,
    height: 900,
  });
  await page.clock.install();
  await page.addInitScript(
    ({ wallet }) => {
      if (!localStorage.getItem("paperdash:following"))
        localStorage.setItem(
          "paperdash:following",
          JSON.stringify([
            {
              address: wallet,
              leaderboardName: "Aoi",
              currentBalance: "999000000000000000000",
            },
          ]),
        );
    },
    { wallet: WALLET },
  );
  await mockSources(page);
  let reads = 0,
    fail = false;
  const calls: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/"))
      calls.push(new URL(request.url()).pathname);
  });
  await page.route("**/api/wallets/batch?**", (route) => {
    reads++;
    return route.fulfill(
      fail
        ? {
            status: 503,
            headers: { "Retry-After": "30" },
            json: { error: "Retained data temporarily unavailable" },
          }
        : { json: batch([WALLET], reads === 1 ? 100 : 200) },
    );
  });
  await page.goto("/?view=following");
  await expect(page.locator(".following-balance")).toHaveText("$100.00");
  expect(reads).toBe(1);
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("paperdash:following")!),
  );
  expect(stored).toEqual({
    version: 2,
    items: [{ address: WALLET, nameHint: "Aoi", followedAt: null }],
  });
  await expect(page.locator(".following-view")).not.toContainText("999");
  await page.clock.fastForward(12500);
  await expect(page.locator(".following-balance")).toHaveText("$200.00");
  await page.screenshot({
    path: `/tmp/paperclub-following-${test.info().project.name}.png`,
  });
  fail = true;
  await page.clock.fastForward(12500);
  await expect(
    page.locator(".following-view").getByRole("status"),
  ).toContainText("Showing last available observations");
  await expect(page.locator(".following-balance")).toHaveText("$200.00");
  await expect(page.locator(".following-observed")).toContainText(
    "Last available",
  );
  if (test.info().project.name === "mobile") {
    await expect(page.locator(".following-wallet-status")).toBeVisible();
    await expect(page.locator(".following-wallet-status")).toContainText(
      "Last available",
    );
  }
  await expect(page.locator(".following-activity .freshness")).toHaveText(
    "Last available",
  );
  const before = reads;
  await page.clock.fastForward(20000);
  expect(reads).toBe(before);
  expect(
    calls.filter(
      (path) =>
        path.startsWith("/api/wallets/") && path !== "/api/wallets/batch",
    ),
  ).toEqual([]);
  expect(calls).not.toContain("/api/accounts");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({
    path: `/tmp/paperclub-following-error-${test.info().project.name}.png`,
  });
});

test("following pagination and cross-tab changes keep batches and feed limited to the visible identities", async ({
  page,
  context,
}) => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    address: address(i + 1),
    nameHint: `Wallet ${i + 1}`,
    followedAt: 123,
  }));
  await page.addInitScript(
    (items) =>
      localStorage.setItem(
        "paperdash:following",
        JSON.stringify({ version: 2, items }),
      ),
    items,
  );
  await mockSources(page);
  const requested: string[][] = [];
  await page.route("**/api/wallets/batch?**", async (route) => {
    const addresses = new URL(route.request().url()).searchParams
      .get("addresses")!
      .split(",");
    requested.push(addresses);
    if (addresses.length === 10)
      await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ json: batch(addresses) }).catch(() => {});
  });
  await page.goto("/?view=following");
  await expect(page.locator(".following-table tbody tr")).toHaveCount(10);
  await page.getByRole("button", { name: "Next following page" }).click();
  await expect(page.locator(".following-table tbody tr")).toHaveCount(2);
  await expect(page.locator(".following-trades .trade-row")).toHaveCount(2);
  await page.waitForTimeout(400);
  expect(requested[0]).toHaveLength(10);
  expect(requested.at(-1)).toEqual([address(11), address(12)]);
  await expect(page.locator(".following-activity")).toContainText(
    "Wallets on this page",
  );
  const other = await context.newPage();
  await mockSources(other);
  await other.goto("/");
  await other.evaluate(
    (items) =>
      localStorage.setItem(
        "paperdash:following",
        JSON.stringify({ version: 2, items }),
      ),
    [{ address: SECOND_WALLET, nameHint: "Yuki", followedAt: 123 }],
  );
  await expect(page.locator(".following-table tbody tr")).toHaveCount(1);
  await expect.poll(() => requested.at(-1)).toEqual([SECOND_WALLET]);
  await page
    .getByRole("button", { name: "Unfollow Yuki", exact: true })
    .click();
  await expect(page.getByText("No followed wallets")).toBeVisible();
  const before = requested.length;
  await page.waitForTimeout(100);
  expect(requested).toHaveLength(before);
  await other.close();
});

test("missing and aging snapshots remain honest and wallet drawer follows share the same identity store", async ({
  page,
}) => {
  await page.clock.install();
  await mockSources(page);
  let available = false,
    at = Date.now();
  await page.route("**/api/wallets/batch?**", (route) => {
    const value = batch([WALLET], 0);
    value.rows[0].receivedAt = available ? at : null;
    value.rows[0].account = available ? value.rows[0].account : null;
    value.rows[0].refreshQueued = true;
    value.activity.receivedAt = at;
    return route.fulfill({ json: value });
  });
  await page.goto(`/?wallet=${WALLET}`);
  const drawer = page.getByRole("dialog");
  const follow = drawer.getByRole("button", { name: /^Follow 0x/ });
  await follow.click();
  await expect(
    drawer.getByRole("button", { name: /^Unfollow 0x/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: /^Following/ })
    .click();
  await expect(page.locator(".following-balance")).toHaveText("—");
  await expect(page.locator(".following-observed")).toContainText(
    "Awaiting snapshot",
  );
  // The same empty values appear during loading; let the initial read finish
  // and schedule its next poll before advancing the browser clock.
  await expect(page.locator(".following-view .table-scroll")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  available = true;
  await page.clock.fastForward(12500);
  await expect(page.locator(".following-balance")).toHaveText("$0.00");
  await page.clock.fastForward(70000);
  await expect(page.locator(".following-observed")).toContainText(
    "Last available",
  );
  await expect(page.locator(".following-activity .freshness")).toHaveText(
    "Last available",
  );
  await page.locator(".following-table .wallet-identity").click();
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: /^Unfollow / }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByText("No followed wallets")).toBeVisible();
});

test("empty, hidden and unmounted Following stops batch reads and the saved-wallet limit is explicit", async ({
  page,
}) => {
  await page.clock.install();
  await mockSources(page);
  let reads = 0;
  const topics: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/events")
      topics.push(url.searchParams.get("topics") ?? "");
  });
  await page.route("**/api/wallets/batch?**", (route) => {
    reads++;
    return route.fulfill({ json: batch([WALLET]) });
  });
  await page.goto("/?view=following");
  await expect(page.getByText("No followed wallets")).toBeVisible();
  await page.clock.fastForward(20000);
  expect(reads).toBe(0);
  await page.evaluate((wallet) => {
    const value = JSON.stringify({
      version: 2,
      items: [{ address: wallet, nameHint: "Aoi", followedAt: 123 }],
    });
    localStorage.setItem("paperdash:following", value);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "paperdash:following",
        newValue: value,
      }),
    );
  }, WALLET);
  await expect(page.locator(".following-balance")).toHaveText("$100.00");
  expect(reads).toBe(1);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(30000);
  expect(reads).toBe(1);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(12500);
  await expect.poll(() => reads).toBeGreaterThan(1);
  expect(new Set(topics)).toEqual(new Set(["overview"]));
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Wallets", exact: true })
    .click();
  const before = reads;
  await page.clock.fastForward(30000);
  expect(reads).toBe(before);
  await page.evaluate(
    (items) => {
      const value = JSON.stringify({ version: 2, items });
      localStorage.setItem("paperdash:following", value);
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "paperdash:following",
          newValue: value,
        }),
      );
    },
    Array.from({ length: 100 }, (_, i) => ({
      address: address(i + 1),
      nameHint: null,
      followedAt: 123,
    })),
  );
  const follow = page.getByRole("button", { name: "Follow Aoi", exact: true });
  await expect(follow).toBeDisabled();
  await expect(follow).toHaveAttribute(
    "title",
    /limit reached \(100 wallets\)/,
  );
});
