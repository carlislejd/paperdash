import { describe, expect, it } from "vitest";
import {
  decodeFollowing,
  encodeFollowing,
  followingBatchPath,
  toggleFollowing,
} from "../apps/web/src/lib/following-storage";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
describe("followed wallet identities", () => {
  it("migrates legacy identities even when saved financial fields are obsolete, stripping all money", () => {
    const items = decodeFollowing(
      JSON.stringify([
        {
          address: address(10).toUpperCase().replace("0X", "0x"),
          leaderboardName: " Aoi ",
          currentBalance: "999",
          currentOpenPositionCount: "old schema",
        },
        { address: address(10), leaderboardName: "duplicate" },
        { address: "bad" },
      ]),
    );
    expect(items).toEqual([
      { address: address(10), nameHint: "Aoi", followedAt: null },
    ]);
    const encoded = encodeFollowing(items);
    expect(JSON.parse(encoded)).toEqual({ version: 2, items });
    expect(encoded).not.toContain("999");
    expect(decodeFollowing(encoded)).toEqual(items);
  });
  it("bounds and validates imported lists while preserving existing follows at the cap", () => {
    const entries = Array.from({ length: 120 }, (_, n) => ({
      address: address(n),
      nameHint: "x".repeat(150),
      followedAt: n,
    }));
    const items = decodeFollowing(
      JSON.stringify({ version: 2, items: entries }),
    );
    expect(items).toHaveLength(100);
    expect(items[0].nameHint).toHaveLength(100);
    expect(toggleFollowing(items, address(999))).toEqual(items);
    expect(toggleFollowing(items, address(0))).toHaveLength(99);
    expect(toggleFollowing([], address(1), "Aoi", 123)).toEqual([
      { address: address(1), nameHint: "Aoi", followedAt: 123 },
    ]);
  });
  it("does not invent identities for corrupt or unrecognized formats", () => {
    for (const raw of [
      null,
      "{bad",
      "null",
      "3",
      '{"version":3,"items":[]}',
      "[null,{},7]",
    ])
      expect(decodeFollowing(raw)).toEqual([]);
    expect(toggleFollowing([], "0xwrong")).toEqual([]);
  });
  it("canonicalizes batches without empty calls or oversized requests", () => {
    expect(followingBatchPath([])).toBeNull();
    expect(followingBatchPath([address(2), address(1), address(2)])).toBe(
      `/api/wallets/batch?addresses=${address(1)},${address(2)}`,
    );
    expect(() => followingBatchPath(["bad"])).toThrow();
    expect(() =>
      followingBatchPath(Array.from({ length: 26 }, (_, n) => address(n))),
    ).toThrow();
  });
});
