import type { ProtocolSummary } from "../../../packages/shared/src/types.js";
import {
  annualizedStakerYield,
  validYieldObservation,
  type StakingYieldObservation,
} from "../../../packages/shared/src/staking-yield.js";
import type { Store } from "./store.js";

/** Retained separately from the seven-day chart cache so every measured hour
 * remains in the denominator across collector restarts and chart eviction. */
interface YieldWindow {
  first: StakingYieldObservation;
  last: StakingYieldObservation;
}
const KEY = "staking-yield-window";

function observation(summary: ProtocolSummary | null): StakingYieldObservation | null {
  return summary?.ok === true ? {
    at: summary.source.at,
    genesis: summary.source.genesis ?? NaN,
    accumulatorRaw: summary.paper.accumulator,
  } : null;
}

/** Called for every accepted summary in the collector's serialized lane. */
export async function refreshStakerYield(
  store: Pick<Store, "get" | "put">,
  summary: ProtocolSummary | null,
  now = Date.now(),
) {
  const current = observation(summary);
  if (!validYieldObservation(current, now))
    return annualizedStakerYield(null, null, now);
  const saved = (await store.get<YieldWindow>(KEY))?.value;
  const compatible = saved &&
    validYieldObservation(saved.first, now) && validYieldObservation(saved.last, now) &&
    saved.first.at <= saved.last.at && saved.last.at <= current.at &&
    BigInt(saved.first.accumulatorRaw) <= BigInt(saved.last.accumulatorRaw) &&
    BigInt(saved.last.accumulatorRaw) <= BigInt(current.accumulatorRaw) &&
    (saved.last.at !== current.at || saved.last.accumulatorRaw === current.accumulatorRaw);
  // A rollback or reset starts a new measured interval. Never bridge a known
  // accumulator regression, even if a later value recovers above the baseline.
  const first = compatible ? saved.first : current;
  if (!compatible || saved.last.at !== current.at)
    await store.put(KEY, { first, last: current } satisfies YieldWindow, now);
  return annualizedStakerYield(first, current, now);
}

/** Chart publication is read-only: it must not replay an older summary into
 * the window while faster summary collection is recording a new endpoint.
 * A concurrent publication may briefly lack a pair; the next refresh recovers. */
export async function readStakerYield(
  store: Pick<Store, "get">,
  summary: ProtocolSummary | null,
  now = Date.now(),
) {
  const current = observation(summary);
  if (!validYieldObservation(current, now))
    return annualizedStakerYield(null, null, now);
  const saved = (await store.get<YieldWindow>(KEY))?.value;
  if (
    !saved ||
    !validYieldObservation(saved.first, now) ||
    !validYieldObservation(saved.last, now) ||
    saved.last.at !== current.at ||
    saved.last.accumulatorRaw !== current.accumulatorRaw
  )
    return annualizedStakerYield(null, null, now);
  return annualizedStakerYield(saved.first, current, now);
}
