import type { PaperEconomicsResponse, StakingRewardHistory } from "../../../packages/shared/src/types.js";
import { VERIFIED_PROTOCOL_GENESIS } from "../../../packages/shared/src/staking-yield.js";
import type { Saved, Store } from "./store.js";
import {
  readHyperEvmPaperSnapshot,
  validHyperEvmPaperSnapshot,
  HYPEREVM_PAPER_MAX_AGE_MS,
  type HyperEvmPaperSnapshot,
} from "./hyperevm.js";
import {
  refreshStakerYieldObservation,
  readStakingRewardHistory,
  type RewardObservation,
} from "./staking-yield.js";

export const ONCHAIN_PAPER_KEY = "onchain-paper";
export const ONCHAIN_PAPER_MAX_AGE_MS = HYPEREVM_PAPER_MAX_AGE_MS;
type Context = Pick<Store, "get" | "put">;
export interface OnchainPaperPublication {
  snapshot: HyperEvmPaperSnapshot;
  stakingYield: NonNullable<PaperEconomicsResponse["stakingYield"]>;
  stakingRewardHistory: StakingRewardHistory;
}

/** These windows start at our first chain observation. Existing API windows
 * remain retained and can never seed a chain-derived annualized rate. */
function rewardStore(store: Context, snapshot: HyperEvmPaperSnapshot): Context {
  const prefix = `hyperevm:${snapshot.deployment.paperImplementation}:${snapshot.deployment.stakingImplementation}:`;
  return {
    get: <T>(key: string) => store.get<T>(`${prefix}${key}`),
    put: (key, value, receivedAt) => store.put(`${prefix}${key}`, value, receivedAt),
  };
}

export async function refreshOnchainPaper(
  store: Context,
  read: () => Promise<HyperEvmPaperSnapshot> = readHyperEvmPaperSnapshot,
  clock: () => number = Date.now,
): Promise<void> {
  const snapshot = await read();
  const now = clock();
  if (!validHyperEvmPaperSnapshot(snapshot) ||
    snapshot.receivedAt > now + 30000 || snapshot.callTimestampMs > now + 30000 ||
    now - snapshot.receivedAt > ONCHAIN_PAPER_MAX_AGE_MS ||
    now - snapshot.callTimestampMs > ONCHAIN_PAPER_MAX_AGE_MS)
    throw new Error("HyperEVM PAPER snapshot is invalid or delayed.");
  const previous = (await store.get<OnchainPaperPublication>(ONCHAIN_PAPER_KEY))?.value.snapshot;
  if (previous && validHyperEvmPaperSnapshot(previous)) {
    if (BigInt(snapshot.block.number) < BigInt(previous.block.number) ||
      snapshot.callTimestampMs < previous.callTimestampMs)
      throw new Error("HyperEVM PAPER observation moved backward; retaining saved state.");
    if (snapshot.block.number === previous.block.number) {
      if (snapshot.block.hash !== previous.block.hash || snapshot.callTimestampMs !== previous.callTimestampMs ||
        snapshot.paper.supplyRaw !== previous.paper.supplyRaw ||
        snapshot.paper.stakedRaw !== previous.paper.stakedRaw ||
        snapshot.staking.accumulatorRaw !== previous.staking.accumulatorRaw)
        throw new Error("HyperEVM PAPER observation conflicts at the same block.");
      // An unchanged chain head never acquires a newer freshness timestamp.
      return;
    }
  }
  const current: RewardObservation = {
    at: snapshot.callTimestampMs,
    genesis: VERIFIED_PROTOCOL_GENESIS,
    accumulatorRaw: snapshot.staking.accumulatorRaw,
    participation: { supplyRaw: snapshot.paper.supplyRaw, stakedRaw: snapshot.paper.stakedRaw },
  };
  const rewards = rewardStore(store, snapshot);
  const stakingYield = await refreshStakerYieldObservation(rewards, current, now);
  const stakingRewardHistory = await readStakingRewardHistory(rewards, now);
  stakingRewardHistory.days = stakingRewardHistory.days.map(day => ({ ...day, source: "hyperevm-rpc" }));
  // Publish only once all inputs and their matching reward endpoints committed.
  await store.put(ONCHAIN_PAPER_KEY, { snapshot, stakingYield, stakingRewardHistory } satisfies OnchainPaperPublication, snapshot.receivedAt);
}

/** Preserve older API-observed days. The first chain day is explicitly partial;
 * never stitch different sources together inside a day's reward interval. */
function mergeRewardHistory(prior: StakingRewardHistory | undefined, chain: StakingRewardHistory): StakingRewardHistory {
  if (chain.observedFromMs === null) return chain;
  const firstChainDay = Math.floor(chain.observedFromMs / 86400000) * 86400000;
  const earlier = (prior?.days ?? []).filter(day => day.dayMs < firstChainDay)
    .map(day => ({
      ...day, source: day.source ?? "papertrade-api" as const,
      // A near-midnight API endpoint may extend into the first chain day.
      // Its reward cannot be trimmed without inventing an intermediate value.
      ...(day.toMs !== null && day.toMs > chain.observedFromMs!
        ? { earnedUsdPer1kPaperRaw: null, participation: null, missing: true, partial: true } : {}),
    }));
  const days = [...earlier, ...chain.days].slice(-365);
  return {
    ...chain,
    days,
    observedFromMs: earlier.length && prior?.observedFromMs != null
      ? Math.min(prior.observedFromMs, chain.observedFromMs) : chain.observedFromMs,
    availableFromMs: days[0]?.dayMs ?? null,
    truncated: Boolean(prior?.truncated || chain.truncated || earlier.length + chain.days.length > 365),
  };
}

export function applyOnchainPaper(
  economics: PaperEconomicsResponse,
  saved: Saved<OnchainPaperPublication> | null,
  now: number,
): PaperEconomicsResponse {
  const publication = saved?.value;
  const snapshot = publication?.snapshot;
  if (!snapshot || !validHyperEvmPaperSnapshot(snapshot) || !publication) return economics;
  const supply = BigInt(snapshot.paper.supplyRaw);
  const staked = BigInt(snapshot.paper.stakedRaw);
  return {
    ...economics,
    supplyRaw: snapshot.paper.supplyRaw,
    stakedRaw: snapshot.paper.stakedRaw,
    stakeRatioBps: supply > 0n ? Number(staked * 10000n / supply) : null,
    stakingYield: publication.stakingYield,
    stakingRewardHistory: mergeRewardHistory(economics.stakingRewardHistory, publication.stakingRewardHistory),
    onchain: {
      source: "hyperevm-rpc", chainId: 999,
      blockNumber: snapshot.block.number,
      blockHash: snapshot.block.hash,
      consistency: "atomic-multicall",
      sourceAt: snapshot.callTimestampMs,
      blockTimestampMs: snapshot.block.timestampMs,
      receivedAt: snapshot.receivedAt,
      stale: now - snapshot.receivedAt > ONCHAIN_PAPER_MAX_AGE_MS ||
        now - snapshot.callTimestampMs > ONCHAIN_PAPER_MAX_AGE_MS ||
        snapshot.receivedAt > now + 30000 || snapshot.callTimestampMs > now + 30000,
      accumulatorRaw: snapshot.staking.accumulatorRaw,
    },
  };
}

/** Onchain freshness is independent of upstream summary/history availability. */
export function ageOnchainPaper(
  data: PaperEconomicsResponse,
  heartbeat: { at: number; errors?: Record<string, string> } | undefined,
  now: number,
): PaperEconomicsResponse {
  if (!data.onchain) return data;
  return {
    ...data,
    onchain: {
      ...data.onchain,
      stale: data.onchain.stale || !heartbeat ||
        now - heartbeat.at > 30000 || heartbeat.at > now + 30000 ||
        Boolean(heartbeat.errors?.["onchain-paper"]) ||
        now - data.onchain.sourceAt > ONCHAIN_PAPER_MAX_AGE_MS ||
        now - data.onchain.receivedAt > ONCHAIN_PAPER_MAX_AGE_MS ||
        data.onchain.sourceAt > now + 30000 || data.onchain.receivedAt > now + 30000,
    },
  };
}
