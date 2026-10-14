import { describe, expect, it } from "vitest";
import { isOlderWalletSnapshot } from "../packages/shared/src/wallet-snapshot.js";

const saved = {
  indexedThroughBlock: 100,
  indexedThroughTimestamp: 1000,
  accountRevision: 3,
};

describe("full wallet snapshot ordering", () => {
  it.each([
    {
      indexedThroughBlock: 101,
      indexedThroughTimestamp: 1001,
      accountRevision: 1,
    },
    {
      indexedThroughBlock: 100,
      indexedThroughTimestamp: 1000,
      accountRevision: 1,
    },
  ])(
    "accepts a bootstrap revision reset with equal or newer indexed clocks: %j",
    (candidate) => {
      expect(isOlderWalletSnapshot(candidate, saved)).toBe(false);
    },
  );

  it.each([
    {
      indexedThroughBlock: 99,
      indexedThroughTimestamp: 1001,
      accountRevision: 4,
    },
    {
      indexedThroughBlock: 101,
      indexedThroughTimestamp: 999,
      accountRevision: 4,
    },
    {
      indexedThroughBlock: 99,
      indexedThroughTimestamp: 999,
      accountRevision: 4,
    },
  ])(
    "rejects either regressed indexed clock despite a higher revision: %j",
    (candidate) => {
      expect(isOlderWalletSnapshot(candidate, saved)).toBe(true);
    },
  );
});
