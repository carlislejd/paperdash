import { z } from "zod";
import { accountKey } from "./following-store.js";
import { accountSchema, addressSchema } from "./schemas.js";
import type { Store } from "./store.js";
import type { Upstream } from "./upstream.js";

export const ACTIVE_PROFIT_REFRESH_INTERVAL_MS = 2000;
export const ACTIVE_PROFIT_REFRESH_KEY = "active-profit-refresh";
export const ACTIVE_PROFIT_MAX_PAGES = 64;
const retrySchema = z.object({
  address: addressSchema,
  failures: z.number().int().min(1).max(100),
  retryAt: z.number().int().nonnegative(),
});
const stateSchema = z.object({
  version: z.literal(1),
  page: z.number().int().min(0).max(ACTIVE_PROFIT_MAX_PAGES - 1),
  turn: z.number().int().min(0).max(4),
  cursor: z.union([z.literal(""), addressSchema]),
  nextRunAt: z.number().int().nonnegative(),
  pageRetryAt: z.number().int().nonnegative(),
  pageFailures: z.number().int().min(0).max(100),
  retries: z.array(retrySchema).max(256),
});
type State = z.infer<typeof stateSchema>;
const initialState = (): State => ({
  version: 1, page: 0, turn: 0, cursor: "", nextRunAt: 0,
  pageRetryAt: 0, pageFailures: 0, retries: [],
});

function deadline(error: unknown, failures: number, now: number): number {
  const retryAt = (error as { retryAt?: number } | null)?.retryAt;
  return Math.max(
    now + Math.min(60000, 5000 * 2 ** Math.min(failures, 4)),
    typeof retryAt === "number" && Number.isSafeInteger(retryAt) ? retryAt : 0,
  );
}

/**
 * Exclusive collector only: one source lookup per two-second turn, under the
 * existing shared request gate. Four turns batch 100 recent-active accounts;
 * the fifth repairs an observed trader that mutable directory paging missed.
 * No viewer is needed, and the durable cursor immediately covers the retained
 * cohort after deployment/restart. Source failures may extend the cadence.
 */
export async function refreshActiveTraderProfits(
  store: Pick<Store, "get" | "put" | "following">,
  upstream: Pick<Upstream, "directoryPage">,
  now = Date.now(),
): Promise<void> {
  const parsed = stateSchema.safeParse((await store.get(ACTIVE_PROFIT_REFRESH_KEY))?.value);
  const state = parsed.success ? parsed.data : initialState();
  if (state.nextRunAt > now) return;
  const targeted = state.turn === 4;
  state.turn = (state.turn + 1) % 5;
  state.nextRunAt = now + ACTIVE_PROFIT_REFRESH_INTERVAL_MS;
  // A crash never advances the bulk page before its accounts are retained.
  // Reserving the turn/deadline first also prevents rapid restart retry loops.
  await store.put(ACTIVE_PROFIT_REFRESH_KEY, state, now);

  if (targeted) {
    const candidates = await store.following.profitRefreshCandidates(state.cursor, now);
    const candidate = candidates.find((address) => !state.retries.some(
      (retry) => retry.address === address && retry.retryAt > now,
    ));
    if (candidates.length) state.cursor = candidate ?? candidates.at(-1)!;
    // Reserve the round-robin cursor before fetching: missing/failed wallets
    // remain unknown without starving other currently active wallets.
    await store.put(ACTIVE_PROFIT_REFRESH_KEY, state, now);
    if (!candidate) return;
    try {
      const saved = await store.get(accountKey(candidate));
      const account = accountSchema.safeParse(saved?.value);
      if (!(account.success && account.data.address === candidate && saved &&
        saved.receivedAt <= now && now - saved.receivedAt < 240000)) {
        const result = await upstream.directoryPage(candidate, "currentBalance", 0, 10, true);
        if (result.stale || result.receivedAt > Date.now() ||
          !result.value.accounts.some((value) => value.address === candidate))
          throw new Error("Active trader source did not provide a fresh matching account summary.");
        // Cache hits retain their original receipt; existing newer observations
        // win in retainAccounts. Never turn an old cached value into fresh P&L.
        await store.following.retainAccounts(result.value.accounts, result.receivedAt, true);
      }
      state.retries = state.retries.filter((retry) => retry.address !== candidate);
      await store.put(ACTIVE_PROFIT_REFRESH_KEY, state);
    } catch (error) {
      const failures = state.retries.find((retry) => retry.address === candidate)?.failures ?? 0;
      state.retries = [...state.retries.filter((retry) => retry.address !== candidate), {
        address: candidate, failures: Math.min(100, failures + 1),
        retryAt: deadline(error, failures, Date.now()),
      }].slice(-256);
      // A shared Retry-After blocks both lanes and survives collector restart.
      const retryAt = (error as { retryAt?: number } | null)?.retryAt;
      if (typeof retryAt === "number" && Number.isSafeInteger(retryAt))
        state.nextRunAt = Math.max(state.nextRunAt, retryAt);
      await store.put(ACTIVE_PROFIT_REFRESH_KEY, state);
      throw error;
    }
    return;
  }

  if (state.pageRetryAt > now) return;
  try {
    // The verified source limit is 100; the public directory UI keeps 10/25.
    const result = await upstream.directoryPage("", "lastActiveTs", state.page, 100, true);
    if (result.stale || result.receivedAt > Date.now() || result.value.pageInfo.page !== state.page)
      throw new Error("Active trader directory did not provide the requested fresh page.");
    await store.following.retainAccounts(result.value.accounts, result.receivedAt, true);
    const accounts = result.value.accounts;
    // Include five minutes beyond the observation window to tolerate boundary
    // movement. lastActiveTs is the source's Unix-seconds field. Pages are mutable,
    // so the targeted lane repairs misses and coverage remains explicitly partial.
    const reachedOlderAccounts = accounts.length > 0 &&
      accounts.every((account) => account.lastActiveTs * 1000 < now - 3900000);
    state.page = !accounts.length || reachedOlderAccounts ||
      state.page + 1 >= Math.min(ACTIVE_PROFIT_MAX_PAGES, result.value.pageInfo.totalPages)
      ? 0 : state.page + 1;
    state.pageRetryAt = 0;
    state.pageFailures = 0;
    await store.put(ACTIVE_PROFIT_REFRESH_KEY, state);
  } catch (error) {
    state.pageRetryAt = deadline(error, state.pageFailures, Date.now());
    state.pageFailures = Math.min(100, state.pageFailures + 1);
    // A changing directory can invalidate an old page; periodically return to
    // its head instead of allowing one permanently failing page to block it.
    if (state.pageFailures >= 3) state.page = 0;
    const retryAt = (error as { retryAt?: number } | null)?.retryAt;
    if (typeof retryAt === "number" && Number.isSafeInteger(retryAt))
      state.nextRunAt = Math.max(state.nextRunAt, retryAt);
    await store.put(ACTIVE_PROFIT_REFRESH_KEY, state);
    throw error;
  }
}
