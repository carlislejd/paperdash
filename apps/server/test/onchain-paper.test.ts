import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type Store } from "../src/store.js";
import { HYPEREVM_DEPLOYMENT, type HyperEvmPaperSnapshot } from "../src/hyperevm.js";
import { applyOnchainPaper, ONCHAIN_PAPER_KEY, refreshOnchainPaper, type OnchainPaperPublication } from "../src/onchain-paper.js";
import { readPaperEconomics, refreshProtocolCharts } from "../src/protocol-charts.js";
import { refreshStakerYield } from "../src/staking-yield.js";
import { VERIFIED_PROTOCOL_GENESIS } from "../../../packages/shared/src/staking-yield.js";
import type { ProtocolSummary } from "../../../packages/shared/src/types.js";

const at = Date.UTC(2026, 9, 22, 17);
const HOUR = 3600000;
const stores: Store[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
function snapshot(time = at, block = "50000000", accumulator = 10n ** 27n): HyperEvmPaperSnapshot {
  return {
    source: "hyperevm-rpc", chainId: 999, consistency: "atomic-multicall",
    block: { number: block, hash: `0x${BigInt(block).toString(16).padStart(64, "0")}`, timestampMs: time },
    paper: { supplyRaw: "9007199254740993000000000", stakedRaw: "4503599627370496500000000", stakingCustodyRaw: "4503599627370496500000000" },
    staking: { accumulatorRaw: String(accumulator) }, receivedAt: time + 100,
    callTimestampMs: time,
    deployment: {
      paperImplementation: HYPEREVM_DEPLOYMENT.paperImplementation,
      stakingImplementation: HYPEREVM_DEPLOYMENT.stakingImplementation,
      multicallCodeSha256: HYPEREVM_DEPLOYMENT.multicallCodeSha256,
    },
  };
}
async function memory() {
  const store = await createStore({ memory: true, databaseUrl: "" });
  stores.push(store);
  return store;
}
async function capture(store: Store, value = snapshot()) {
  await refreshOnchainPaper(store, async () => value, () => value.receivedAt);
  await store.put("collector-heartbeat", { at: value.receivedAt, errors: {} }, value.receivedAt);
  await refreshProtocolCharts(store, value.receivedAt);
  return readPaperEconomics(store, value.receivedAt);
}

describe("independent PAPER observations", () => {
  it("publishes exact chain balances without any Papertrade summary or API call", async () => {
    const store = await memory();
    const fetcher = vi.spyOn(globalThis, "fetch");
    const data = await capture(store);
    expect(data).toMatchObject({
      supplyRaw: snapshot().paper.supplyRaw, stakedRaw: snapshot().paper.stakedRaw,
      stakeRatioBps: 5000, allocatedRewardsRaw: null, pendingRewardsRaw: null,
      sourceAt: null, stale: true,
      onchain: { source: "hyperevm-rpc", blockNumber: "50000000", sourceAt: at, stale: false },
      stakingYield: { fromMs: at, toMs: at, usdPerPaperPerYearRaw: null },
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(data.stakingRewardHistory?.days[0]).toMatchObject({ source: "hyperevm-rpc", partial: true });
  });

  it("keeps chain freshness independent from upstream failures and expires retained clocks", async () => {
    const store = await memory();
    await capture(store);
    await store.put("collector-heartbeat", { at: at + 100, errors: { summary: "API unavailable", history: "API unavailable" } });
    expect((await readPaperEconomics(store, at + 100)).onchain?.stale).toBe(false);
    await store.put("collector-heartbeat", { at: at + 100, errors: { "onchain-paper": "RPC unavailable" } });
    expect((await readPaperEconomics(store, at + 100)).onchain?.stale).toBe(true);
    await store.put("collector-heartbeat", { at: at + 90001, errors: {} });
    expect((await readPaperEconomics(store, at + 90001)).onchain?.stale).toBe(true);
    expect((await readPaperEconomics(store, at + 90001)).supplyRaw).toBe(snapshot().paper.supplyRaw);
  });

  it("does not renew a repeated head and rejects regressions or conflicting state", async () => {
    const store = await memory();
    await capture(store);
    const original = await store.get(ONCHAIN_PAPER_KEY);
    await refreshOnchainPaper(store, async () => ({ ...snapshot(), receivedAt: at + 30000 }), () => at + 30000);
    expect(await store.get(ONCHAIN_PAPER_KEY)).toEqual(original);
    await expect(refreshOnchainPaper(store, async () => snapshot(at, "49999999"), () => at + 100)).rejects.toThrow("backward");
    await expect(refreshOnchainPaper(store, async () => snapshot(at, "50000000", 2n * 10n ** 27n), () => at + 100)).rejects.toThrow("conflicts");
    expect(await store.get(ONCHAIN_PAPER_KEY)).toEqual(original);
  });

  it("preserves chain rate endpoints over restart without borrowing an API baseline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paper-chain-"));
    directories.push(directory);
    let store = await createStore({ dataDir: directory, databaseUrl: "" });
    await capture(store);
    await store.close();
    store = await createStore({ dataDir: directory, databaseUrl: "" });
    stores.push(store);
    const data = await capture(store, snapshot(at + HOUR, "50003600", 2n * 10n ** 27n));
    expect(data.stakingYield).toMatchObject({ fromMs: at, toMs: at + HOUR, elapsedMs: HOUR, usdPerPaperPerYearRaw: "8760000000000000000000" });
    expect(await store.get("staking-yield-window")).toBeNull();
  });

  it("retains earlier API days but never combines API and chain endpoints within a day", async () => {
    const store = await memory();
    const summary = (time: number, acc: bigint): ProtocolSummary => ({
      ok: true, source: { at: time, block: "10", genesis: VERIFIED_PROTOCOL_GENESIS },
      balances: { tvl: "0", margin: "0", lp: "0", reserve: "0", queue: "0" },
      activity: { volume: "0", open: 0 }, fees: { pending: "0", lifetime: "99" },
      paper: { supply: "100", staked: "10", accumulator: acc.toString() },
    });
    for (const [time, acc] of [[at - 86400000, 1n], [at - 86400000 + HOUR, 2n], [at, 3n]] as const)
      await refreshStakerYield(store, summary(time, acc * 10n ** 27n), time);
    await store.put("summary", summary(at, 3n * 10n ** 27n), at);
    const data = await capture(store);
    expect(data.allocatedRewardsRaw).toBe("99");
    expect(data.stakingYield?.fromMs).toBe(at);
    const days = data.stakingRewardHistory!.days;
    expect(days[0].source).toBe("papertrade-api");
    expect(days.at(-1)).toMatchObject({ source: "hyperevm-rpc", fromMs: at, earnedUsdPer1kPaperRaw: null, partial: true });
  });

  it("keeps the last complete publication after a failed write and retries idempotently", async () => {
    const store = await memory();
    await capture(store);
    const put = store.put.bind(store);
    const spy = vi.spyOn(store, "put").mockImplementation(async (key, ...args) => {
      if (key === ONCHAIN_PAPER_KEY) throw new Error("publication unavailable");
      return put(key, ...args);
    });
    const next = snapshot(at + HOUR, "50003600", 2n * 10n ** 27n);
    await expect(refreshOnchainPaper(store, async () => next, () => next.receivedAt)).rejects.toThrow("publication unavailable");
    expect((await store.get<OnchainPaperPublication>(ONCHAIN_PAPER_KEY))?.value.snapshot.block.number).toBe("50000000");
    spy.mockRestore();
    const recovered = await capture(store, next);
    expect(recovered.stakingYield?.fromMs).toBe(at);
    expect(recovered.stakingYield?.earnedUsdPerPaperRaw).toBe("1000000000000000000");
  });

  it("does not count an API midnight endpoint that overlaps the first chain interval", async () => {
    const store = await memory();
    const midnight = Math.floor(at / 86400000) * 86400000;
    const first = snapshot(midnight + 5000);
    const data = await capture(store, first);
    const prior = {
      ...data, stakingRewardHistory: {
        basis: "observed-accumulator" as const, timeZone: "UTC" as const,
        observedFromMs: midnight - HOUR, availableFromMs: midnight - 86400000, truncated: false,
        days: [{ dayMs: midnight - 86400000, fromMs: midnight - HOUR, toMs: midnight + 20000,
          earnedUsdPer1kPaperRaw: "100", partial: true, missing: false }],
      },
    };
    const merged = applyOnchainPaper(prior, await store.get<OnchainPaperPublication>(ONCHAIN_PAPER_KEY), first.receivedAt);
    expect(merged.stakingRewardHistory?.days[0]).toMatchObject({
      source: "papertrade-api", earnedUsdPer1kPaperRaw: null, missing: true, partial: true,
    });
    expect(merged.stakingRewardHistory?.days[1]).toMatchObject({ source: "hyperevm-rpc", fromMs: midnight + 5000 });
    expect(prior.stakingRewardHistory.days[0].earnedUsdPer1kPaperRaw).toBe("100");
  });
});
