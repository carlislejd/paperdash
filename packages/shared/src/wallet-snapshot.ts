import type { WalletSnapshot } from "./types.js";

type IndexedWalletClock = Pick<
  WalletSnapshot,
  "indexedThroughBlock" | "indexedThroughTimestamp"
>;

/** Order full snapshots by indexed chain progress. accountRevision can reset
 * between full stream bootstraps; it remains useful for snapshot identity,
 * but is not a globally monotonic age marker. */
export function isOlderWalletSnapshot(
  candidate: IndexedWalletClock,
  saved: IndexedWalletClock,
): boolean {
  return (
    candidate.indexedThroughBlock < saved.indexedThroughBlock ||
    candidate.indexedThroughTimestamp < saved.indexedThroughTimestamp
  );
}
