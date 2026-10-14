import type { JobState } from "./history-store.js";

const day = 86_400_000;
export interface PortfolioGap {
  afterMs: number;
  beforeMs: number;
}
const validTime = (time: unknown): time is number =>
  typeof time === "number" && Number.isSafeInteger(time) && time >= 0;

/** Bounds checkpoint size; merging on overflow only overstates missing coverage. */
export function boundedPortfolioGaps(
  gaps: readonly PortfolioGap[],
): PortfolioGap[] {
  const merged: PortfolioGap[] = [];
  for (const gap of gaps
    .filter(
      (g) =>
        validTime(g.afterMs) &&
        validTime(g.beforeMs) &&
        g.afterMs <= g.beforeMs,
    )
    .sort((a, b) => a.afterMs - b.afterMs || a.beforeMs - b.beforeMs)) {
    const prior = merged.at(-1);
    if (prior && gap.afterMs <= prior.beforeMs)
      prior.beforeMs = Math.max(prior.beforeMs, gap.beforeMs);
    else merged.push({ ...gap });
  }
  while (merged.length > 32) {
    const [first, second] = merged.splice(0, 2);
    merged.unshift({ afterMs: first.afterMs, beforeMs: second.beforeMs });
  }
  return merged;
}

/** New interval metadata is authoritative; the old single cut is a fallback. */
export function portfolioLocalGaps(
  portfolio?: JobState["portfolio"],
): PortfolioGap[] {
  if (portfolio?.localGaps !== undefined)
    return boundedPortfolioGaps(portfolio.localGaps);
  const afterMs = portfolio?.localGapAfterMs;
  if (!validTime(afterMs)) return [];
  return [
    {
      afterMs,
      beforeMs: Math.max(
        afterMs,
        validTime(portfolio?.availableToMs) ? portfolio.availableToMs : afterMs,
      ),
    },
  ];
}

export function crossesPortfolioGap(
  left: number,
  right: number,
  gaps: readonly PortfolioGap[],
): boolean {
  return gaps.some(
    ({ afterMs, beforeMs }) =>
      (afterMs === beforeMs ? left <= beforeMs : left < beforeMs) &&
      right > afterMs,
  );
}

/** Receipt time is not proof that the source has caught up through that time. */
export function portfolioHistoryRange(
  state: JobState,
  now: number,
): "1d" | "1w" | "all" {
  const portfolio = state.portfolio;
  const clock = (time: unknown): number | null =>
    typeof time === "number" &&
    Number.isSafeInteger(time) &&
    time >= 0 &&
    time <= now
      ? time
      : null;
  const fullFetchedAt = clock(portfolio?.fullFetchedAt) ?? 0;
  if (!state.complete || now - fullFetchedAt > 7 * day) return "all";

  const horizons = [
    state.lastSuccessAt,
    portfolio?.availableToMs,
    portfolioLocalGaps(portfolio)[0]?.afterMs,
  ]
    .map(clock)
    .filter((time): time is number => time !== null);
  const age = now - (horizons.length ? Math.min(...horizons) : 0);
  const range = age > 6 * day ? "all" : age > 20 * 3_600_000 ? "1w" : "1d";
  // A successful wider read may still expose only partial/old source history.
  // Keep ordinary recent checks running, but do not download that same broad
  // window every five minutes. The durable clock survives collector restarts.
  const repairedAt = clock(portfolio?.repairFetchedAt) ?? fullFetchedAt;
  if (range !== "1d" && repairedAt > 0 && now - repairedAt < day) return "1d";
  return range;
}
