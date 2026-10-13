import { z } from "zod";
import { accountsSchema } from "./schemas.js";
import type { Store } from "./store.js";
import { canonicalPath, type Upstream } from "./upstream.js";

const rotationKey = "directory-head-rotation";
const rotationSchema = z.object({
  version: z.literal(1),
  nextTurn: z.enum(["balance", "paper"]),
  paperPage: z.number().int().min(0).max(3),
});

// Called serially by the leased collector's existing directory loop. At its
// default 30s cadence, balance heads refresh every 60s and the top 100 PAPER
// accounts every four minutes. Failures / Retry-After stretch those intervals.
// The independent balance-directory sweep keeps its existing request budget.
export async function refreshDirectoryHead(
  store: Pick<Store, "get" | "put" | "following" | "history">,
  upstream: Pick<Upstream, "request">,
): Promise<void> {
  const saved = rotationSchema.safeParse((await store.get(rotationKey))?.value);
  const state = saved.success
    ? saved.data
    : ({ version: 1, nextTurn: "balance", paperPage: 0 } as const);
  const paper = state.nextTurn === "paper";
  const reserved = {
    ...state,
    nextTurn: paper ? ("balance" as const) : ("paper" as const),
  };

  // Reserve the next sort before fetching. A failed PAPER request cannot
  // monopolize the next directory turn, while its page remains retryable.
  // A crash can skip a turn, but cannot mark an unretained PAPER page complete.
  await store.put(rotationKey, reserved);
  const path = canonicalPath("/state/leaderboard/accounts", {
    window: "all",
    sortKey: paper ? "paperTotal" : "currentBalance",
    sortDir: "desc",
    page: paper ? state.paperPage : 0,
    pageSize: 25,
  });
  const source = await upstream.request(path, accountsSchema);
  const receivedAt = Date.now();
  const accounts = [
    ...new Map(
      source.accounts.slice(0, 25).map((account) => [account.address, account]),
    ).values(),
  ];
  await store.following.retainAccounts(accounts, receivedAt, true);
  await store.put("account-count", source.summary.uniqueAccounts, receivedAt);
  // This is the same canonical raw-page key read by the source-ranked
  // leaderboard; browsing it reuses the retained page instead of refetching.
  await store.put(`cache:${path}`, { ...source, accounts }, receivedAt);
  if (paper) {
    const holders = accounts.filter(
      (account) => BigInt(account.paperTotal) > 0n,
    );
    const empty = accounts.filter(
      (account) => BigInt(account.paperTotal) === 0n,
    );
    if (holders.length)
      // Existing discovery activates for ten minutes, preserves stronger trade
      // priority 20, and leaves retained cursors and failed-job backoff intact.
      await store.history.discoverWallets(
        holders.map((account) => account.address),
        10,
      );
    if (empty.length)
      await store.history.discoverWallets(
        empty.map((account) => account.address),
      );
    // Advance only after every cache/retention/discovery operation succeeds.
    // These idempotent writes can safely repeat after a partial failure/restart.
    await store.put(rotationKey, {
      ...reserved,
      paperPage:
        state.paperPage + 1 < Math.min(4, source.pageInfo.totalPages)
          ? state.paperPage + 1
          : 0,
    });
  } else {
    await store.history.discoverWallets(
      accounts.map((account) => account.address),
    );
  }
}
