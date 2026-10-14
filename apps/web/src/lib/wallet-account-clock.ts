import type { WalletResponse } from "../../../../packages/shared/src/types";

/** Indexed time is the last account update, not the last successful check. */
export function walletAccountClock(
  wallet: WalletResponse | null,
  refreshFailed = false,
  now = Date.now(),
) {
  const sourceAt = wallet?.snapshot
    ? wallet.snapshot.indexedThroughTimestamp * 1000
    : null;
  const valid = (time: number | null | undefined): time is number =>
    time != null &&
    Number.isSafeInteger(time) &&
    time > 0 &&
    time <= now + 30_000;
  const freshness = wallet?.accountFreshness;
  const checkedAt = valid(freshness?.receivedAt) ? freshness.receivedAt : null;
  return {
    sourceAt: valid(sourceAt) ? sourceAt : null,
    checkedAt,
    refreshing: !refreshFailed && freshness?.refreshing === true,
    stale:
      refreshFailed ||
      !freshness ||
      freshness.stale ||
      !Number.isSafeInteger(wallet?.snapshot?.indexedThroughBlock) ||
      (wallet?.snapshot?.indexedThroughBlock ?? -1) < 0 ||
      !valid(sourceAt) ||
      freshness.sourceAt !== sourceAt ||
      checkedAt === null ||
      (sourceAt !== null &&
        checkedAt !== null &&
        sourceAt > checkedAt + 30_000) ||
      now - checkedAt > 30_000 ||
      Boolean(
        wallet?.errors.some((error) =>
          /^(?:Live account:|Wallet snapshot\b)/i.test(error),
        ),
      ),
  };
}
