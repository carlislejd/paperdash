import { describe, expect, it } from "vitest";
import { walletAccountClock } from "../apps/web/src/lib/wallet-account-clock";
import { WALLET, walletResponse } from "./e2e/fixtures";

const now = Date.UTC(2026, 9, 14, 6);
function current() {
  const wallet = walletResponse(WALLET, now);
  wallet.snapshot!.indexedThroughTimestamp = (now - 4 * 3600_000) / 1000;
  wallet.accountFreshness = {
    sourceAt: now - 4 * 3600_000,
    receivedAt: now,
    stale: false,
    refreshing: false,
  };
  return wallet;
}

describe("account observation clock", () => {
  it("keeps fresh account checks independent of account inactivity and old history", () => {
    const wallet = current();
    wallet.stale = true;
    wallet.errors = ["Closed trades: awaiting history"];
    expect(walletAccountClock(wallet, false, now)).toMatchObject({
      stale: false,
      sourceAt: now - 4 * 3600_000,
      checkedAt: now,
    });
    expect(walletAccountClock(wallet, true, now).stale).toBe(true);
    expect(walletAccountClock(wallet, false, now + 30_001).stale).toBe(true);
  });

  it.each([
    "receipt",
    "source",
    "future",
    "block",
    "mismatch",
    "error",
    "afterReceipt",
  ])("keeps %s failures stale", (kind) => {
    const wallet = current();
    if (kind === "receipt") wallet.accountFreshness!.receivedAt = null;
    if (kind === "source") wallet.snapshot!.indexedThroughTimestamp = 0;
    if (kind === "future") wallet.accountFreshness!.receivedAt = now + 31_000;
    if (kind === "block") wallet.snapshot!.indexedThroughBlock = -1;
    if (kind === "mismatch") wallet.accountFreshness!.sourceAt!++;
    if (kind === "error") wallet.errors = ["Live account: connection failed"];
    if (kind === "afterReceipt") {
      wallet.snapshot!.indexedThroughTimestamp = (now + 20_000) / 1000;
      wallet.accountFreshness!.sourceAt = now + 20_000;
      wallet.accountFreshness!.receivedAt = now - 20_000;
    }
    expect(walletAccountClock(wallet, false, now).stale).toBe(true);
  });
});
