import {
  chartPoints,
  chartRange,
  HOUR_MS,
  DAY_MS,
  type ChartKind,
  type ChartPoint,
  type ChartRange,
} from "./chart-data";

export interface ChartSummary {
  /** Opt-in for flows only. Stocks and cumulative totals must never be summed. */
  total: { value: number | null; label: string } | null;
  coverage: string;
}

/** Describes the displayed observations, not completeness of the upstream ledger. */
export function summarizeChart(
  input: readonly ChartPoint[],
  rangeInput: ChartRange,
  kind: ChartKind,
  options: {
    bucketMs?: number;
    aggregate?: "sum";
    totalLabel?: "Selected-period total" | "Recorded total";
    now?: number;
  } = {},
): ChartSummary {
  const range = chartRange(rangeInput);
  const interval =
    Number.isFinite(options.bucketMs) && options.bucketMs! > 0
      ? options.bucketMs!
      : HOUR_MS;
  const prepared = chartPoints(input, range);
  // A point at the right boundary has no visible bar and belongs to the next bucket.
  const points = prepared.points.filter(
    (point) => kind !== "bar" || point.time < range.to,
  );
  const known = points.filter((point) => point.value !== null);
  if (kind !== "bar") {
    const gaps = points.filter(
      (point, index) =>
        point.value === null ||
        point.gapBefore ||
        (index > 0 && point.time - points[index - 1].time > interval * 1.5),
    ).length;
    return {
      total: null,
      coverage: `${known.length} observations${gaps ? ` · ${gaps} gaps / unknown observations` : ""}`,
    };
  }
  const expected = Math.max(
    points.length,
    Math.ceil(range.to / interval) - Math.ceil(range.from / interval),
  );
  const unknown = Math.max(0, expected - known.length);
  const now = options.now ?? Date.now();
  const inProgress = known.filter(
    (point) =>
      point.partial && point.time <= now && now < point.time + interval,
  ).length;
  const partial = known.filter((point) => point.partial).length - inProgress;
  const gapCount = known.filter((point) => point.gapBefore).length;
  const coverage = [
    `${known.length}/${expected} buckets available`,
    ...(unknown ? [`${unknown} unknown`] : []),
    ...(inProgress ? [`${inProgress} in progress`] : []),
    ...(partial ? [`${partial} other partial`] : []),
    ...(gapCount ? [`${gapCount} ${gapCount === 1 ? "gap" : "gaps"}`] : []),
  ].join(" · ");
  // Compensated addition keeps small daily amounts accurate beside very large bars.
  let sum = 0,
    correction = 0;
  for (const point of known) {
    const adjusted = point.value! - correction;
    const next = sum + adjusted;
    correction = next - sum - adjusted;
    sum = next;
  }
  return {
    total:
      options.aggregate === "sum"
        ? {
            value: known.length && Number.isFinite(sum) ? sum : null,
            label:
              unknown || gapCount || prepared.truncated
                ? "Available subtotal"
                : (options.totalLabel ?? "Selected-period total"),
          }
        : null,
    coverage,
  };
}

export function chartValueCaption(
  kind: ChartKind,
  aggregate: "sum" | undefined,
  latestTime: number | undefined,
  bucketMs = HOUR_MS,
  now = Date.now(),
): string {
  if (kind !== "bar") return "Latest snapshot";
  if (!aggregate) return "Latest hourly snapshot";
  const current =
    latestTime !== undefined &&
    latestTime <= now &&
    now < latestTime + bucketMs;
  return bucketMs === DAY_MS
    ? current
      ? "Today so far"
      : "Latest recorded day"
    : current
      ? "This hour so far"
      : "Latest recorded hour";
}

export function hourlyChartRangeLabel(hours: number): string {
  return hours === 168
    ? "7 days · 168 UTC hour buckets"
    : `${hours} UTC hour buckets`;
}
