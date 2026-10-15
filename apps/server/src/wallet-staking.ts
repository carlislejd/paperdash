import type {
  ProtocolSummary,
  WalletResponse,
  WalletSnapshot,
} from "../../../packages/shared/src/types.js";
import type { Saved, Store } from "./store.js";
import type { Cached } from "./upstream.js";
import { PublicReadCache } from "./public-read-cache.js";

type Rewards = NonNullable<WalletResponse["stakingRewards"]>;
/** Internal cache envelope: its rewards are captured atomically with this account. */
export type RetainedWalletSnapshot = WalletSnapshot & { stakingRewards?: Rewards };
const unsigned = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9]\d{0,77})$/.test(value);
const clock = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 8.64e15;
const caches = new WeakMap<Pick<Store, "get">, PublicReadCache>();
function summaryCache(store: Pick<Store, "get">) {
  let cache = caches.get(store);
  if (!cache) {
    cache = new PublicReadCache({
      ttl: 1000,
      maxEntries: 1,
      maxBytes: 16384,
      maxPending: 1,
    });
    caches.set(store, cache);
  }
  return cache;
}

/** Derive claimable USDC from one wallet state and the saved global accumulator.
 * The accumulator is scaled by 1e27; wallet rewards remain 18-decimal USDC. */
export function walletStakingRewards(
  snapshot: Cached<WalletSnapshot> | null,
  summary: Saved<ProtocolSummary> | null,
  now = Date.now(),
): Rewards {
  const sourceAt = clock(summary?.value?.source?.at)
    ? summary.value.source.at
    : null;
  const receivedAt =
    clock(snapshot?.receivedAt) && clock(summary?.receivedAt)
      ? Math.min(snapshot.receivedAt, summary.receivedAt)
      : null;
  const unavailable: Rewards = {
    pendingRaw: null,
    sourceAt,
    receivedAt,
    stale: true,
  };
  const paper = snapshot?.value.paper;
  const accumulator = summary?.value?.paper?.accumulator;
  const summaryBlock = summary?.value?.source?.block;
  const indexedBlock = snapshot?.value.indexedThroughBlock;
  const accountBlock = snapshot?.value.walletRevision ?? indexedBlock;
  const accountSourceAt = (snapshot?.value.indexedThroughTimestamp ?? NaN) * 1000;
  if (
    summary?.value.ok !== true ||
    !paper ||
    !unsigned(paper.staked) ||
    !unsigned(paper.pendingBase) ||
    !unsigned(paper.rewardDebt) ||
    !unsigned(accumulator) ||
    !unsigned(summaryBlock) ||
    !clock(indexedBlock) ||
    !clock(accountBlock) ||
    accountBlock <= 0 ||
    accountBlock > indexedBlock ||
    !clock(accountSourceAt) ||
    accountSourceAt <= 0 ||
    BigInt(summaryBlock) < BigInt(accountBlock) ||
    sourceAt === null ||
    receivedAt === null ||
    !clock(now) ||
    sourceAt > now + 30000 ||
    summary!.receivedAt > now + 30000 ||
    snapshot!.receivedAt > now + 30000 ||
    // The summary is read before opening the account stream. A newer summary
    // cannot be combined with an older stake that may already have changed.
    summary!.receivedAt > snapshot!.receivedAt ||
    sourceAt > summary!.receivedAt + 30000 ||
    accountSourceAt > snapshot!.receivedAt + 30000 ||
    accountSourceAt > sourceAt + 30000
  )
    return unavailable;
  const accrued = (BigInt(paper.staked) * BigInt(accumulator)) / 10n ** 27n;
  const debt = BigInt(paper.rewardDebt);
  // A regressed accumulator or mismatched account state is unknown, never zero.
  if (accrued < debt) return unavailable;
  return {
    pendingRaw: (BigInt(paper.pendingBase) + accrued - debt).toString(),
    sourceAt,
    receivedAt,
    stale:
      snapshot!.stale ||
      Boolean(snapshot!.error) ||
      now - receivedAt > 30000 ||
      now - sourceAt > 30000,
  };
}

/** Capture this saved observation before opening the existing account stream. */
export async function readStakingSummary(
  store: Pick<Store, "get">,
): Promise<Saved<ProtocolSummary> | null> {
  try {
    return await summaryCache(store).read("summary", () =>
      store.get<ProtocolSummary>("summary"),
    );
  } catch {
    return null;
  }
}

/** Reuse only the accumulator paired with this snapshot, never a newer global
 * accumulator that could accrue rewards against an account's obsolete stake. */
export function readWalletStakingRewards(
  snapshot: Cached<RetainedWalletSnapshot> | null,
  now = Date.now(),
): Rewards {
  const rewards = snapshot?.value.stakingRewards;
  if (
    !rewards ||
    !unsigned(rewards.pendingRaw) ||
    !clock(rewards.receivedAt) ||
    !clock(rewards.sourceAt) ||
    rewards.receivedAt > now + 30000 ||
    rewards.sourceAt > now + 30000
  )
    return { pendingRaw: null, receivedAt: null, sourceAt: null, stale: true };
  return {
    ...rewards,
    stale:
      rewards.stale ||
      snapshot!.stale ||
      Boolean(snapshot!.error) ||
      now - rewards.receivedAt > 30000 ||
      now - rewards.sourceAt > 30000,
  };
}

export function publicWalletSnapshot(snapshot: RetainedWalletSnapshot): WalletSnapshot {
  const { stakingRewards: _pairedRewards, ...account } = snapshot;
  return account;
}
