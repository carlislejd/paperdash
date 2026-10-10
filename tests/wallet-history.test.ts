import { describe, expect, it } from "vitest";
import type { HistoryPage } from "../packages/shared/src/types";
import { mergeHistory } from "../apps/web/src/lib/wallet-history";

type Row = { id: string; status?: string };
const key = (row: Row) => row.id;
function page(
  ids: string[],
  nextCursor: string | null,
  retainedCount = ids.length,
): HistoryPage<Row> {
  return {
    items: ids.map((id) => ({ id })),
    nextCursor,
    coverage: {
      backfillComplete: false,
      sourceComplete: null,
      identity: "source-fields-and-occurrence",
      identityAmbiguous: true,
      retainedCount,
      indexing: true,
      lastIndexedAt: 100,
    },
  };
}

describe("wallet history refresh while indexing", () => {
  it("offers refresh when newly indexed older rows follow an exhausted loaded tail", () => {
    const result = mergeHistory(
      page(["a", "b"], null),
      page(["a"], "head-cursor", 3),
      key,
    );
    expect(result.newActivity).toBe(true);
    expect(result.page.items.map(key)).toEqual(["a", "b"]);
    expect(result.page.nextCursor).toBeNull();
    expect(result.page.coverage?.retainedCount).toBe(3);
  });
  it("preserves a usable older cursor without a redundant refresh notice", () => {
    const result = mergeHistory(
      page(["a", "b"], "older-tail"),
      page(["a"], "head-cursor", 8),
      key,
    );
    expect(result.newActivity).toBe(false);
    expect(result.page.nextCursor).toBe("older-tail");
  });
  it("retains distinct source occurrence IDs and applies refreshed head corrections", () => {
    const current = page(["same-tx:1", "same-tx:2"], null);
    const latest = page(["same-tx:1"], "head-cursor", 2);
    latest.items[0].status = "settled";
    const result = mergeHistory(current, latest, key);
    expect(result.newActivity).toBe(false);
    expect(result.page.items).toEqual([
      { id: "same-tx:1", status: "settled" },
      { id: "same-tx:2" },
    ]);
  });
  it("does not invent a join when new activity no longer overlaps loaded rows", () => {
    const current = page(["a", "b"], "older-tail");
    const result = mergeHistory(current, page(["d", "c"], "new-head", 4), key);
    expect(result).toEqual({ page: current, newActivity: true });
  });
  it("treats a capped count at the loaded limit as evidence of additional retained rows", () => {
    const latest = page(["a"], "head-cursor", 2);
    latest.coverage!.retainedCountCapped = true;
    expect(mergeHistory(page(["a", "b"], null), latest, key).newActivity).toBe(
      true,
    );
  });
});
