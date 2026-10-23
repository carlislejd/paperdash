import type { ProtocolSummary, StakingRewardDay, StakingRewardHistory } from "../../../packages/shared/src/types.js";
import {
  annualizedStakerYield,
  validYieldObservation,
  type StakingYieldObservation,
} from "../../../packages/shared/src/staking-yield.js";
import type { Store } from "./store.js";

/** Retained separately from the seven-day chart cache so every measured hour
 * remains in the denominator across collector restarts and chart eviction. */
interface YieldWindow {
  first: RewardObservation;
  last: RewardObservation;
}
const KEY = "staking-yield-window";

/** Optional for compatibility with retained accumulator-only observations. */
export interface RewardObservation extends StakingYieldObservation {
  participation?: { supplyRaw: string; stakedRaw: string } | null;
}
function validParticipation(value: RewardObservation["participation"]): value is NonNullable<RewardObservation["participation"]> {
  return Boolean(value &&
    typeof value.supplyRaw === "string" && typeof value.stakedRaw === "string" &&
    /^(0|[1-9]\d{0,77})$/.test(value.supplyRaw) &&
    /^(0|[1-9]\d{0,77})$/.test(value.stakedRaw) &&
    BigInt(value.stakedRaw) <= BigInt(value.supplyRaw));
}
function observation(summary: ProtocolSummary | null): RewardObservation | null {
  const participation = summary && {
    supplyRaw: summary.paper.supply,
    stakedRaw: summary.paper.staked,
  };
  return summary?.ok === true ? {
    at: summary.source.at,
    genesis: summary.source.genesis ?? NaN,
    accumulatorRaw: summary.paper.accumulator,
    participation: validParticipation(participation) ? participation : null,
  } : null;
}

/** Called for every accepted summary in the collector's serialized lane. */
export async function refreshStakerYield(
  store: Pick<Store, "get" | "put">,
  summary: ProtocolSummary | null,
  now = Date.now(),
) {
  return refreshStakerYieldObservation(store, observation(summary), now);
}

/** Source adapters use separate storage namespaces; an API baseline must not
 * silently become the start of an independently measured chain interval. */
export async function refreshStakerYieldObservation(
  store: Pick<Store, "get" | "put">,
  current: RewardObservation | null,
  now = Date.now(),
) {
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
  await refreshStakingRewardHistory(store, current, saved?.last, now);
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
  return readStakerYieldObservation(store, observation(summary), now);
}

export async function readStakerYieldObservation(
  store: Pick<Store, "get">,
  current: RewardObservation | null,
  now = Date.now(),
) {
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

const DAY = 86_400_000;
const BOUNDARY_TOLERANCE = 60_000;
const HISTORY_DAYS = 365;
const HISTORY_KEY = "staking-reward-history";
const HISTORY_DAYS_KEY = "staking-reward-history-days";
interface RewardDay {
  dayMs: number;
  first: RewardObservation;
  last: RewardObservation;
  invalid: boolean;
  /** A contradictory same-time supply/stake observation does not erase rewards. */
  participationInvalid?: boolean;
}
interface RewardHistoryState {
  version: 1;
  observedFromMs: number;
  last: RewardObservation;
  day: RewardDay;
}
const dayOf = (at: number) => Math.floor(at / DAY) * DAY;
const newDay = (point: RewardObservation, invalid = false): RewardDay => ({
  dayMs: dayOf(point.at), first: point, last: point, invalid,
});

function validDay(day: RewardDay | undefined, now: number): day is RewardDay {
  return Boolean(day && Number.isSafeInteger(day.dayMs) && day.dayMs % DAY === 0 &&
    typeof day.invalid === "boolean" &&
    validYieldObservation(day.first, now) && validYieldObservation(day.last, now) &&
    day.first.at <= day.last.at &&
    day.first.at >= day.dayMs && day.first.at < day.dayMs + DAY &&
    day.last.at <= day.dayMs + DAY + BOUNDARY_TOLERANCE);
}
function validHistory(value: RewardHistoryState | undefined, now: number): value is RewardHistoryState {
  return Boolean(value && value.version === 1 &&
    Number.isSafeInteger(value.observedFromMs) && value.observedFromMs > 0 &&
    validYieldObservation(value.last, now) && validDay(value.day, now) &&
    value.day.dayMs === dayOf(value.last.at) && value.day.last.at === value.last.at &&
    value.day.last.accumulatorRaw === value.last.accumulatorRaw);
}
function archivedDays(value: RewardDay[] | undefined, now: number): RewardDay[] {
  return Array.isArray(value) ? value.filter(day => validDay(day, now)).slice(-HISTORY_DAYS) : [];
}

function publicDay(day: RewardDay): StakingRewardDay {
  const consistent = !day.invalid && day.last.at > day.first.at &&
    BigInt(day.last.accumulatorRaw) >= BigInt(day.first.accumulatorRaw);
  return {
    dayMs: day.dayMs,
    fromMs: day.first.at,
    toMs: day.last.at,
    // Preserve the accumulator's 27 decimals until after multiplication by
    // 1,000 PAPER. Dividing per-PAPER first would silently lose tiny rewards.
    earnedUsdPer1kPaperRaw: consistent
      ? ((BigInt(day.last.accumulatorRaw) - BigInt(day.first.accumulatorRaw)) / 1_000_000n).toString()
      : null,
    partial: !consistent || day.first.at !== day.dayMs || day.last.at !== day.dayMs + DAY,
    missing: !consistent,
    participation: consistent && !day.participationInvalid &&
      validParticipation(day.first.participation) && validParticipation(day.last.participation)
      ? {
        supplyFromRaw: day.first.participation.supplyRaw,
        supplyToRaw: day.last.participation.supplyRaw,
        stakedFromRaw: day.first.participation.stakedRaw,
        stakedToRaw: day.last.participation.stakedRaw,
      } : null,
  };
}

export function emptyStakingRewardHistory(): StakingRewardHistory {
  return {
    basis: "observed-accumulator", timeZone: "UTC", days: [],
    observedFromMs: null, availableFromMs: null, truncated: false,
  };
}

/** Each accepted collector observation extends just its UTC day. The old
 * lifetime pair can seed one endpoint, never fabricate earlier daily rows. */
async function refreshStakingRewardHistory(
  store: Pick<Store, "get" | "put">,
  current: RewardObservation,
  legacyLast: RewardObservation | undefined,
  now: number,
): Promise<void> {
  const saved = (await store.get<RewardHistoryState>(HISTORY_KEY))?.value;
  let state: RewardHistoryState;
  if (validHistory(saved, now)) {
    state = saved;
  } else {
    const seed = validYieldObservation(legacyLast, now) &&
      legacyLast.at <= current.at &&
      BigInt(legacyLast.accumulatorRaw) <= BigInt(current.accumulatorRaw)
      ? legacyLast : current;
    state = { version: 1, observedFromMs: seed.at, last: seed, day: newDay(seed) };
  }
  const previous = state.last;
  if (saved === state && previous.at === current.at && previous.accumulatorRaw === current.accumulatorRaw) {
    // Do not upgrade old endpoints with later metadata. Contradictory totals at
    // an already observed endpoint invalidate participation, not the reward
    // interval or its original baseline. A boundary endpoint can serve two rows.
    const before = previous.participation;
    const after = current.participation;
    if (validParticipation(before) && !state.day.participationInvalid &&
      (!validParticipation(after) || before.supplyRaw !== after.supplyRaw || before.stakedRaw !== after.stakedRaw)) {
      const archived = archivedDays((await store.get<RewardDay[]>(HISTORY_DAYS_KEY))?.value, now);
      const affected = archived.filter(day => day.last.at === current.at);
      if (affected.length) {
        for (const day of affected)
          await store.put(`staking-reward-day:${day.dayMs}`, publicDay({ ...day, participationInvalid: true }), now);
        await store.put(HISTORY_DAYS_KEY, archived.map(day => day.last.at === current.at
          ? { ...day, participationInvalid: true } : day), now);
      }
      await store.put(HISTORY_KEY, {
        ...state, day: { ...state.day, participationInvalid: true },
      } satisfies RewardHistoryState, now);
    }
    return;
  }
  const currentDay = dayOf(current.at);
  const previousDay = dayOf(previous.at);
  const reset = current.at < previous.at ||
    BigInt(current.accumulatorRaw) < BigInt(previous.accumulatorRaw) ||
    (current.at === previous.at && current.accumulatorRaw !== previous.accumulatorRaw);
  let day = state.day;
  if (reset) {
    // A clock rollback invalidates every affected retained date, including
    // archived rows. A same-day accumulator reset makes that day's total unknown.
    if (currentDay !== previousDay || current.at <= previous.at) {
      const archived = archivedDays((await store.get<RewardDay[]>(HISTORY_DAYS_KEY))?.value, now);
      // A near-midnight closing sample can belong to the previous UTC row.
      // Invalidate by actual endpoint, not just by the row's calendar date.
      for (const invalid of [...archived, day].filter(item => item.last.at >= current.at))
        await store.put(`staking-reward-day:${invalid.dayMs}`, publicDay({ ...invalid, invalid: true }), now);
      const retained = archived.filter(item => item.dayMs < currentDay)
        .map(item => item.last.at >= current.at ? { ...item, invalid: true } : item);
      if (previousDay < currentDay) {
        retained.push(day);
        await store.put(`staking-reward-day:${previousDay}`, publicDay(day), now);
      }
      await store.put(HISTORY_DAYS_KEY, retained.filter(item => item.dayMs >= currentDay - (HISTORY_DAYS - 1) * DAY), now);
    }
    day = newDay(current, true);
  } else if (currentDay === previousDay) {
    day = { ...day, last: current };
  } else {
    // One near-midnight endpoint closes the prior day and opens the next,
    // keeping intervals disjoint. Never spread a multi-day outage delta.
    const nearBoundary = currentDay === previousDay + DAY &&
      (current.at === currentDay ||
        (previous.at >= currentDay - BOUNDARY_TOLERANCE &&
          current.at <= currentDay + BOUNDARY_TOLERANCE));
    if (nearBoundary) day = { ...day, last: current };
    await store.put(`staking-reward-day:${previousDay}`, publicDay(day), now);
    const archived = archivedDays((await store.get<RewardDay[]>(HISTORY_DAYS_KEY))?.value, now);
    await store.put(HISTORY_DAYS_KEY, [...archived.filter(item => item.dayMs < previousDay), day]
      .filter(item => item.dayMs >= currentDay - (HISTORY_DAYS - 1) * DAY), now);
    day = newDay(current);
  }
  // The frequent 2-second write stays constant-size. Closed days are updated
  // only at a date transition, and archived individually before rolling expiry.
  await store.put(HISTORY_KEY, {
    version: 1,
    observedFromMs: Math.min(state.observedFromMs, current.at),
    last: current,
    day,
  } satisfies RewardHistoryState, now);
}

/** Read once during collector publication. Browser requests read its cached
 * result, independent of visitor count; no historical or upstream fan-out. */
export async function readStakingRewardHistory(
  store: Pick<Store, "get">,
  now = Date.now(),
): Promise<StakingRewardHistory> {
  const [snapshot, archive] = await Promise.all([
    store.get<RewardHistoryState>(HISTORY_KEY),
    store.get<RewardDay[]>(HISTORY_DAYS_KEY),
  ]);
  const saved = snapshot?.value;
  if (!validHistory(saved, now)) return emptyStakingRewardHistory();
  const lastDay = dayOf(saved.last.at);
  const firstDay = Math.max(dayOf(saved.observedFromMs), lastDay - (HISTORY_DAYS - 1) * DAY);
  const retained = new Map([...archivedDays(archive?.value, now), saved.day]
    .map(day => [day.dayMs, publicDay(day)]));
  const days: StakingRewardDay[] = [];
  for (let dayMs = firstDay; dayMs <= lastDay; dayMs += DAY)
    days.push(retained.get(dayMs) ?? {
      dayMs, fromMs: null, toMs: null, earnedUsdPer1kPaperRaw: null, partial: true, missing: true,
      participation: null,
    });
  return {
    ...emptyStakingRewardHistory(), days,
    observedFromMs: saved.observedFromMs, availableFromMs: firstDay,
    truncated: firstDay > dayOf(saved.observedFromMs),
  };
}
