import { expect, test } from "@playwright/test";
import type { Cashflow, HistoryPage } from "../../packages/shared/src/types";
import { deposit, mockSources, WALLET, walletResponse } from "./fixtures";

test("an exhausted wallet history can refresh newly indexed older records", async ({
  page,
}) => {
  await page.clock.install();
  await mockSources(page);
  const at = Date.now();
  let retainedCount = 2;
  const rows = [
    { ...deposit(3000, "a", at - 86_400_000), id: "retained-a:1" },
    { ...deposit(7779, "b", at - 172_800_000), id: "retained-b:1" },
    { ...deposit(100, "c", at - 259_200_000), id: "retained-c:1" },
  ];
  function history(
    items: Cashflow[],
    nextCursor: string | null,
  ): HistoryPage<Cashflow> {
    return {
      items,
      nextCursor,
      coverage: {
        backfillComplete: retainedCount === 3,
        sourceComplete: null,
        identity: "source-fields-and-occurrence",
        identityAmbiguous: true,
        retainedCount,
        indexing: retainedCount < 3,
        lastIndexedAt: at,
      },
    };
  }
  await page.route(`**/api/wallets/${WALLET}**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/cashflows")) {
      const finalPage = url.searchParams.get("cursor") === "newly-indexed";
      await route.fulfill({
        json: finalPage
          ? history([rows[2]], null)
          : history([rows[1]], retainedCount === 3 ? "newly-indexed" : null),
      });
      return;
    }
    if (url.pathname !== `/api/wallets/${WALLET}`) {
      await route.fallback();
      return;
    }
    const wallet = walletResponse(WALLET, at);
    wallet.cashflows = history([rows[0]], "older-deposits");
    await route.fulfill({ json: wallet });
  });
  await page.goto(`/?wallet=${WALLET}`);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Load older activity" }).click();
  await expect(
    dialog.getByText("Credited deposit", { exact: true }),
  ).toHaveCount(2);
  await expect(
    dialog.getByRole("button", { name: "Load older activity" }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Refresh history", exact: true }),
  ).toBeVisible();

  retainedCount = 3;
  await page.clock.fastForward(15_001);
  const refresh = dialog.getByRole("button", {
    name: "History updated · refresh",
    exact: true,
  });
  await expect(refresh).toBeVisible();
  await expect(
    dialog.getByText("Credited deposit", { exact: true }),
  ).toHaveCount(2);
  await refresh.click();
  await expect(
    dialog.getByText("Credited deposit", { exact: true }),
  ).toHaveCount(1);
  await dialog.getByRole("button", { name: "Load older activity" }).click();
  await expect(
    dialog.getByText("Credited deposit", { exact: true }),
  ).toHaveCount(2);
  await dialog.getByRole("button", { name: "Load older activity" }).click();
  await expect(
    dialog.getByText("Credited deposit", { exact: true }),
  ).toHaveCount(3);
  await expect(
    dialog.getByRole("button", { name: "Load older activity" }),
  ).toHaveCount(0);
});
