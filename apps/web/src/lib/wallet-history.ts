import type { HistoryPage } from "../../../../packages/shared/src/types";

function hasNewRetainedTail<T>(page: HistoryPage<T>): boolean {
  const coverage = page.coverage;
  return (
    page.nextCursor === null &&
    Boolean(
      coverage &&
        (coverage.retainedCount > page.items.length ||
          (coverage.retainedCountCapped &&
            coverage.retainedCount >= page.items.length)),
    )
  );
}

/** Keep a loaded tail only after matching its overlap with the refreshed head. */
export function mergeHistory<T>(
  current: HistoryPage<T>,
  latest: HistoryPage<T>,
  key: (item: T) => string,
): { page: HistoryPage<T>; newActivity: boolean } {
  if (!current.items.length) return { page: latest, newActivity: false };
  if (!latest.items.length) return { page: current, newActivity: false };
  const last = key(latest.items[latest.items.length - 1]);
  for (let anchor = current.items.length - 1; anchor >= 0; anchor--) {
    if (key(current.items[anchor]) !== last) continue;
    const overlap = Math.min(latest.items.length, anchor + 1);
    let consistent = true;
    for (let offset = 1; offset < overlap; offset++) {
      if (
        key(current.items[anchor - offset]) !==
        key(latest.items[latest.items.length - 1 - offset])
      ) {
        consistent = false;
        break;
      }
    }
    if (consistent) {
      const page = {
        ...latest,
        items: [...latest.items, ...current.items.slice(anchor + 1)],
        nextCursor: current.nextCursor,
      };
      // Backfill can append rows after an exhausted cursor. Keep the current
      // reading position and offer an explicit refresh; a head cursor does not
      // identify the end of the loaded tail and must not be substituted for it.
      return { page, newActivity: hasNewRetainedTail(page) };
    }
  }
  return { page: current, newActivity: true };
}
