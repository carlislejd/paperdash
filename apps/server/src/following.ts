import type {
  Account,
  WalletBatchResponse,
} from "../../../packages/shared/src/types.js";
import type { Store } from "./store.js";
import type { Upstream } from "./upstream.js";
import { savedActivityDelayed } from "./activity-health.js";
import { accountKey, batchAddresses } from "./following-store.js";
import { accountSchema } from "./schemas.js";

export async function readWalletBatch(
  store: Store,
  input: string[],
  now = Date.now(),
): Promise<WalletBatchResponse> {
  const addresses = batchAddresses(input);
  const queued = new Set(await store.following.touch(addresses, now));
  const [saved, activity] = await Promise.all([
    store.getMany<
      | Account
      | { at: number; errors?: Record<string, string> }
      | { status: { stream: string } }
    >([...addresses.map(accountKey), "collector-heartbeat", "overview"]),
    store.following.activity(addresses, now),
  ]);
  const heartbeat = saved["collector-heartbeat"]?.value as
    { at: number; errors?: Record<string, string> } | undefined;
  const overview = saved.overview?.value as
    { status: { stream: string } } | undefined;
  const delayed =
    !heartbeat || now - heartbeat.at > 30000 || heartbeat.at > now + 30000;
  const rows = addresses.map((address) => {
    const row = saved[accountKey(address)];
    const parsed = accountSchema.safeParse(row?.value);
    const account = parsed.success ? parsed.data : null;
    const valid = account?.address === address;
    return {
      address,
      account: valid ? account : null,
      receivedAt: valid ? row.receivedAt : null,
      sourceAt: null,
      stale:
        !valid ||
        delayed ||
        now - row.receivedAt > 60000 ||
        row.receivedAt > now + 30000,
      refreshQueued: queued.has(address),
    };
  });
  activity.stale =
    savedActivityDelayed(heartbeat, overview?.status.stream, now) ||
    !activity.coverage.projectionBackfillComplete ||
    activity.coverage.observedFrom === null;
  const stale = rows.some((r) => r.stale) || activity.stale;
  return {
    rows,
    activity,
    receivedAt: now,
    stale,
    ...(stale
      ? { error: "Some wallet values or activity are delayed or unavailable." }
      : {}),
  };
}

/** Invoked only by the exclusive collector, at most once every five seconds. */
export async function refreshWatchedWallet(
  store: Store,
  upstream: Upstream,
  now = Date.now(),
): Promise<void> {
  const job = await store.following.nextWatch(now);
  if (!job) return;
  try {
    const saved = await store.get<Account>(accountKey(job.address));
    const parsed = accountSchema.safeParse(saved?.value);
    if (
      saved &&
      parsed.success &&
      parsed.data.address === job.address &&
      saved.receivedAt <= now &&
      now - saved.receivedAt < 60000
    ) {
      await store.following.completeWatch(job.address, saved.receivedAt);
      return;
    }
    const result = await upstream.directoryPage(
      job.address,
      "currentBalance",
      0,
      10,
      true,
    );
    if (
      result.stale ||
      !result.value.accounts.some((a) => a.address === job.address)
    )
      throw new Error(
        "The source did not provide a fresh matching account summary.",
      );
    await store.following.retainAccounts(
      result.value.accounts,
      result.receivedAt,
      true,
    );
    // The loader may already have retained this same millisecond's receipt.
    // Explicit success must still clear an earlier failure counter.
    await store.following.completeWatch(job.address, result.receivedAt);
    // Original cached receipt time is retained; cache reads never re-age rows.
  } catch (error) {
    await store.following.failWatch(
      job.address,
      job.failures,
      Date.now(),
      (error as { retryAt?: number }).retryAt,
    );
    throw error;
  }
}
