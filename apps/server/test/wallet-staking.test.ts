import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProtocolSummary,
  WalletSnapshot,
} from "../../../packages/shared/src/types.js";
import { walletSchema } from "../src/schemas.js";
import { createStore, type Saved, type Store } from "../src/store.js";
import {
  readWalletStakingRewards,
  readStakingSummary,
  walletStakingRewards,
} from "../src/wallet-staking.js";
import { RequestGate, Upstream } from "../src/upstream.js";
import { LocalCoordinator } from "../src/coordination.js";

const at = 1800000000000;
const address = `0x${"a".repeat(40)}`;
const usd = (value: bigint) => (value * 10n ** 18n).toString();
const snapshot = (): WalletSnapshot => ({
  address,
  indexedThroughBlock: 100,
  indexedThroughTimestamp: at / 1000,
  accountRevision: 1,
  balance: "0",
  queued: "0",
  locked: "0",
  lifetime: {
    depositedRaw: "0",
    withdrawnRaw: "0",
    realizedPnlRaw: usd(-200000n),
    feesPaidRaw: "0",
    tradedNotionalRaw: "0",
    paperRewardsClaimedRaw: usd(250000n),
  },
  paper: {
    balance: "0",
    staked: usd(100000n),
    pendingBase: usd(10000n),
    rewardDebt: usd(60000n),
  },
  openPositions: [],
});
const observed = () => ({ value: snapshot(), receivedAt: at, stale: false });
const summary = (): Saved<ProtocolSummary> => ({
  receivedAt: at,
  value: {
    ok: true,
    source: { block: "100", at },
    balances: { tvl: "0", margin: "0", lp: "0", reserve: "0", queue: "0" },
    activity: { volume: "0", open: 0 },
    fees: { pending: "0", lifetime: "0" },
    paper: { supply: "0", staked: "0", accumulator: (10n ** 27n).toString() },
  },
});
const stores: Store[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
});

describe("wallet staking rewards", () => {
  it("matches the pinned on-chain pendingReward result with exact 18-decimal arithmetic", () => {
    // Live contract comparison recorded in docs/WALLET_REWARDS.md.
    const account = observed();
    account.value.paper = {
      balance: "0",
      staked: "252057160476062350514411978",
      pendingBase: "0",
      rewardDebt: "2947212262480263776256006",
    };
    const protocol = summary();
    protocol.value.paper.accumulator = "11885583543202400471492696";
    expect(walletStakingRewards(account, protocol, at)).toMatchObject({
      pendingRaw: "48634176020349430583451",
      stale: false,
    });
  });

  it("includes pendingBase and preserves earned rewards across a claim", () => {
    const account = observed();
    const before = walletStakingRewards(account, summary(), at);
    expect(before.pendingRaw).toBe(usd(50000n));
    const totalBefore =
      BigInt(account.value.lifetime.paperRewardsClaimedRaw) +
      BigInt(before.pendingRaw!);
    account.value.lifetime.paperRewardsClaimedRaw = usd(300000n);
    account.value.paper.pendingBase = "0";
    account.value.paper.rewardDebt = usd(100000n);
    const after = walletStakingRewards(account, summary(), at);
    expect(after.pendingRaw).toBe("0");
    expect(
      BigInt(account.value.lifetime.paperRewardsClaimedRaw) +
        BigInt(after.pendingRaw!),
    ).toBe(totalBefore);
  });

  it("truncates accumulator division before subtracting debt without floating-point loss", () => {
    const account = observed();
    account.value.paper.staked = "1000000000000000000000000001";
    account.value.paper.rewardDebt = "0";
    account.value.paper.pendingBase = "7";
    const protocol = summary();
    protocol.value.paper.accumulator = "999999999999999999999999999";
    expect(walletStakingRewards(account, protocol, at).pendingRaw).toBe(
      "1000000000000000000000000006",
    );
  });

  it("keeps missing, malformed and incoherent reward inputs distinct from zero", () => {
    expect(walletStakingRewards(null, summary(), at).pendingRaw).toBeNull();
    expect(walletStakingRewards(observed(), null, at).pendingRaw).toBeNull();
    for (const field of ["staked", "pendingBase", "rewardDebt"] as const) {
      for (const invalid of [undefined, "-1", "1.5", "1e18", "9".repeat(79)]) {
        const account = observed();
        Object.assign(account.value.paper, { [field]: invalid });
        expect(walletStakingRewards(account, summary(), at).pendingRaw).toBeNull();
      }
    }
    const account = observed();
    account.value.paper.rewardDebt = usd(100001n);
    expect(walletStakingRewards(account, summary(), at).pendingRaw).toBeNull();
    const behind = summary();
    behind.value.source.block = "99";
    expect(walletStakingRewards(observed(), behind, at).pendingRaw).toBeNull();
    const indexedLater = observed();
    indexedLater.value.walletRevision = 99;
    indexedLater.value.indexedThroughBlock = 101;
    expect(walletStakingRewards(indexedLater, summary(), at).pendingRaw).toBe(usd(50000n));
    indexedLater.value.walletRevision = 102;
    expect(walletStakingRewards(indexedLater, summary(), at).pendingRaw).toBeNull();
    const absentAccumulator = summary();
    delete absentAccumulator.value.paper.accumulator;
    expect(walletStakingRewards(observed(), absentAccumulator, at).pendingRaw).toBeNull();
    const failedSummary = summary();
    failedSummary.value.ok = false;
    expect(walletStakingRewards(observed(), failedSummary, at).pendingRaw).toBeNull();
    const zero = observed();
    zero.value.paper = { balance: "0", staked: "0", pendingBase: "0", rewardDebt: "0" };
    expect(walletStakingRewards(zero, summary(), at).pendingRaw).toBe("0");
  });

  it("preserves account and accumulator freshness without using unrelated wallet history clocks", () => {
    const account = observed();
    account.value.indexedThroughTimestamp = (at - 86400000) / 1000;
    expect(walletStakingRewards(account, summary(), at).stale).toBe(false);
    for (const delay of ["account", "summary", "source"] as const) {
      const current = observed();
      const protocol = summary();
      if (delay === "account") {
        current.receivedAt -= 30001;
        current.value.indexedThroughTimestamp -= 31;
        protocol.receivedAt -= 30001;
        protocol.value.source.at -= 30001;
      }
      if (delay === "summary") {
        protocol.receivedAt -= 30001;
        protocol.value.source.at -= 30001;
        current.value.indexedThroughTimestamp -= 31;
      }
      if (delay === "source") {
        protocol.value.source.at -= 30001;
        current.value.indexedThroughTimestamp -= 31;
      }
      expect(walletStakingRewards(current, protocol, at)).toMatchObject({
        pendingRaw: usd(50000n),
        stale: true,
      });
    }
    const future = summary();
    future.value.source.at = at + 30001;
    expect(walletStakingRewards(observed(), future, at).pendingRaw).toBeNull();
    const futureAccount = observed();
    futureAccount.value.indexedThroughTimestamp += 31;
    expect(walletStakingRewards(futureAccount, summary(), at).pendingRaw).toBeNull();
    expect(walletStakingRewards({ ...observed(), stale: true }, summary(), at).stale).toBe(true);
  });

  it("retains rewardDebt and shares one saved summary read across wallet requests", async () => {
    expect(walletSchema.parse(snapshot()).paper.rewardDebt).toBe(usd(60000n));
    const store = await createStore({ memory: true, databaseUrl: "" });
    stores.push(store);
    await store.put("summary", summary().value, at);
    const get = vi.spyOn(store, "get");
    const result = await Promise.all([
      readStakingSummary(store),
      readStakingSummary(store),
    ]);
    expect(result[0]).toEqual(result[1]);
    expect(walletStakingRewards(observed(), result[0], at).pendingRaw).toBe(usd(50000n));
    expect(get).toHaveBeenCalledExactlyOnceWith("summary");
  });

  it("adds rewards to the wallet API using the existing account fetch and saved summary", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(at);
    const store = await createStore({ memory: true, databaseUrl: "" });
    stores.push(store);
    await store.put("summary", summary().value, at);
    const account = snapshot();
    const fetcher = vi.fn(async () =>
      new Response(`event: wallet\ndata: ${JSON.stringify(account)}\n\n`),
    );
    const client = new Upstream(store, fetcher as typeof fetch, "https://papertrade.test", new RequestGate(3, 0), new LocalCoordinator());
    try {
      const wallet = await client.wallet(address);
      expect(wallet.stakingRewards).toEqual({
        pendingRaw: usd(50000n), receivedAt: at, sourceAt: at, stale: false,
      });
      expect(wallet.snapshot?.paper.rewardDebt).toBe(usd(60000n));
      expect(wallet.snapshot).not.toHaveProperty("stakingRewards");
      expect(fetcher).toHaveBeenCalledTimes(1);
      // A newer accumulator must not accrue against this cached, obsolete stake.
      clock.mockReturnValue(at + 2000);
      const newer = summary();
      newer.value.paper.accumulator = (2n * 10n ** 27n).toString();
      newer.value.source.at = at + 2000;
      await store.put("summary", newer.value, at + 2000);
      const cached = await client.wallet(address);
      expect(cached.stakingRewards).toEqual(wallet.stakingRewards);
      expect(fetcher).toHaveBeenCalledTimes(1);
      // The next real account observation captures the changed stake and summary together.
      clock.mockReturnValue(at + 31000);
      account.paper.staked = usd(200000n);
      account.paper.rewardDebt = usd(300000n);
      account.accountRevision++;
      const refreshed = await client.wallet(address);
      expect(refreshed.stakingRewards?.pendingRaw).toBe(usd(110000n));
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      await client.close();
    }
  });

  it("keeps older unpaired snapshots unavailable and ages retained pairs", () => {
    expect(readWalletStakingRewards(observed(), at).pendingRaw).toBeNull();
    const account = observed();
    const paired = {
      ...account,
      value: { ...account.value, stakingRewards: walletStakingRewards(account, summary(), at) },
    };
    expect(readWalletStakingRewards(paired, at + 30001)).toMatchObject({
      pendingRaw: usd(50000n), stale: true, receivedAt: at,
    });
    const newer = summary();
    newer.receivedAt = at + 1;
    expect(walletStakingRewards(account, newer, at + 1).pendingRaw).toBeNull();
  });
});
