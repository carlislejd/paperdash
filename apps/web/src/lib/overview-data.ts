import type { Overview } from "../../../../packages/shared/src/types";
import { readLiveTvl } from "../../../../packages/shared/src/live-tvl";

type OverviewUpdate =
  | Overview
  | Pick<Overview, "summary" | "accountCount" | "status">
  | Pick<Overview, "history" | "historyCoverage">;

/** The summary owns its active minute; every earlier historical revision is retained. */
export function withLiveTvl(overview: Overview): Overview {
  const live = readLiveTvl(overview.summary);
  if (!live || !Array.isArray(overview.history)) return overview;
  const tail = overview.history.at(-1);
  if (
    tail &&
    (!Number.isSafeInteger(tail.time) ||
      tail.time < 0 ||
      !Number.isFinite(tail.value) ||
      tail.time > live.point.time)
  )
    return overview;
  if (tail?.time === live.point.time && tail.value === live.point.value)
    return overview;
  const history =
    tail?.time === live.point.time
      ? [...overview.history.slice(0, -1), live.point]
      : [...overview.history, live.point];
  // A full history frame normally follows a minute rollover. If it is delayed,
  // retain the chart's starting anchor as well as the most recent observations.
  return {
    ...overview,
    history:
      history.length > 301 ? [history[0], ...history.slice(-300)] : history,
  };
}

export function mergeOverviewUpdate(
  current: Overview | null,
  update: OverviewUpdate,
): Overview | null {
  if ("trades" in update) {
    if (
      current &&
      (current.status.sourceAt ?? 0) > (update.status.sourceAt ?? 0)
    )
      return current;
    return withLiveTvl(update);
  }
  if (!current) return null;
  if ("summary" in update) {
    const previous = readLiveTvl(current.summary);
    const next = readLiveTvl(update.summary);
    if (previous && next && previous.sourceAt > next.sourceAt) return current;
  }
  // Reapply the latest real summary after a history frame, so a buffered chart
  // revision cannot roll back the active minute already shown from metrics.
  return withLiveTvl({ ...current, ...update });
}
