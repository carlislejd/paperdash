import { niceChartAxis } from "./chart-axis";

export interface ChartPoint {
  /** Source observation time, or the start of a UTC bucket. */
  time: number;
  value: number | null;
  gapBefore?: boolean;
  partial?: boolean;
}

export interface ChartRange {
  from: number;
  to: number;
  label: string;
}

export type ChartKind = "line" | "bar";
export type ChartColor = "lavender" | "green";
export interface ChartSegment {
  id: string;
  label: string;
  color: ChartColor;
  points: readonly ChartPoint[];
}

export function chartColorValue(color?: ChartColor): string {
  return color === "green" ? "#506746" : "#9078ad";
}

/** Capture series before an asynchronous export can observe later source mutations. */
export function cloneChartSegments(
  segments: readonly ChartSegment[] | undefined,
): ChartSegment[] | undefined {
  return segments?.map((segment) => ({
    ...segment,
    points: segment.points.map((point) => ({ ...point })),
  }));
}
export const CHART_POINT_LIMIT = 2048;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** Match the effective geometry interval in both the interactive chart and PNG. */
export function chartBucketCaption(bucketMs = HOUR_MS): string {
  const interval =
    Number.isFinite(bucketMs) && bucketMs > 0 ? bucketMs : HOUR_MS;
  const period =
    interval === DAY_MS ? "Daily " : interval === HOUR_MS ? "Hourly " : "";
  return `${period}UTC buckets · hatched bars are partial`;
}

export function validChartTime(
  time: number | null | undefined,
): time is number {
  return (
    typeof time === "number" &&
    Number.isSafeInteger(time) &&
    time >= 0 &&
    time <= 8.64e15
  );
}

export function chartRange(range: ChartRange): ChartRange {
  const from = validChartTime(range.from)
    ? Math.min(range.from, 8.64e15 - HOUR_MS)
    : 0;
  const to =
    validChartTime(range.to) && range.to > from ? range.to : from + HOUR_MS;
  return { from, to, label: range.label };
}

/** Null samples stay in the sequence: removing them would draw across unknown data. */
export function chartPoints(input: readonly ChartPoint[], range: ChartRange) {
  const { from, to } = chartRange(range);
  const byTime = new Map<number, ChartPoint>();
  for (const point of input) {
    if (!validChartTime(point.time) || point.time < from || point.time > to)
      continue;
    const previous = byTime.get(point.time);
    byTime.set(point.time, {
      time: point.time,
      value:
        typeof point.value === "number" && Number.isFinite(point.value)
          ? point.value
          : null,
      ...(point.gapBefore || previous?.gapBefore ? { gapBefore: true } : {}),
      ...(point.partial || previous?.partial ? { partial: true } : {}),
    });
  }
  const sorted = [...byTime.values()].sort((a, b) => a.time - b.time);
  return {
    points: sorted.slice(-CHART_POINT_LIMIT),
    truncated: sorted.length > CHART_POINT_LIMIT,
  };
}

export function formatChartNumber(
  value: number | null | undefined,
  compact = true,
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const magnitude = Math.abs(value);
  return new Intl.NumberFormat("en-US", {
    notation:
      magnitude >= 1e15 || (magnitude > 0 && magnitude < 0.001)
        ? "scientific"
        : compact
          ? "compact"
          : "standard",
    maximumFractionDigits: compact ? 2 : 4,
  }).format(value);
}

export function formatChartTime(
  time: number | null | undefined,
  date = true,
): string {
  if (!validChartTime(time)) return "Unavailable";
  return (
    new Intl.DateTimeFormat("en-GB", {
      ...(date
        ? ({ day: "2-digit", month: "short", year: "numeric" } as const)
        : {}),
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: "UTC",
    }).format(time) + " UTC"
  );
}

export interface ChartGeometry {
  points: ChartPoint[];
  truncated: boolean;
  path: string;
  markers: Array<{ x: number; y: number; partial: boolean }>;
  bars: Array<{
    time: number;
    x: number;
    y: number;
    width: number;
    height: number;
    partial: boolean;
  }>;
  ticks: Array<{ y: number; value: number }>;
  x: (time: number) => number;
  y: (value: number) => number;
  baseline: number;
  from: number;
  to: number;
}

/** Normalize before subtracting so even finite ±1e308 samples cannot overflow the scale. */
export function chartGeometry(
  input: readonly ChartPoint[],
  rangeInput: ChartRange,
  kind: ChartKind,
  width: number,
  height: number,
  bucketMs = HOUR_MS,
  integerTicks = false,
): ChartGeometry {
  const range = chartRange(rangeInput);
  const prepared = chartPoints(input, range);
  const { points } = prepared;
  const values = points.flatMap((p) => (p.value === null ? [] : [p.value]));
  const low = values.length ? Math.min(...values) : 0;
  const high = values.length ? Math.max(...values) : 1;
  const nonnegativeBars = kind === "bar" && low >= 0;
  const axis = niceChartAxis(low, high, {
    includeZero: kind === "bar",
    padding: kind === "bar" ? 0 : 0.08,
    integer: integerTicks,
  });
  const x = (time: number) =>
    Math.max(
      0,
      Math.min(width, ((time - range.from) / (range.to - range.from)) * width),
    );
  const y = (value: number) => (1 - axis.position(value)) * height;
  const ticks = axis.ticks.map((value) => ({ y: y(value), value }));
  const interval =
    Number.isFinite(bucketMs) && bucketMs > 0 ? bucketMs : HOUR_MS;
  let path = "",
    previous: ChartPoint | undefined;
  const markers: ChartGeometry["markers"] = [];
  const bars: ChartGeometry["bars"] = [];
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    if (point.value === null) {
      previous = undefined;
      continue;
    }
    const breaks =
      !previous ||
      point.gapBefore ||
      point.time - previous.time > interval * 1.5;
    path += `${breaks ? "M" : "L"}${x(point.time).toFixed(2)},${y(point.value).toFixed(2)} `;
    const next = points[index + 1];
    if (
      breaks &&
      (!next ||
        next.value === null ||
        next.gapBefore ||
        next.time - point.time > interval * 1.5)
    )
      markers.push({
        x: x(point.time),
        y: y(point.value),
        partial: Boolean(point.partial),
      });
    const start = x(point.time),
      end = x(Math.min(point.time + interval, range.to));
    if (end > start)
      bars.push({
        time: point.time,
        x: start + Math.min(1.5, (end - start) * 0.12),
        y:
          point.value === 0 && nonnegativeBars
            ? Math.max(0, y(0) - 1)
            : Math.min(y(0), y(point.value)),
        width: Math.max(0.5, (end - start) * 0.82),
        height: Math.max(
          point.value === 0 ? 1 : 0.75,
          Math.abs(y(point.value) - y(0)),
        ),
        partial: Boolean(point.partial),
      });
    previous = point;
  }
  return {
    ...prepared,
    path: path.trim(),
    markers,
    bars,
    ticks,
    x,
    y,
    baseline: y(0),
    from: range.from,
    to: range.to,
  };
}

/** Stacks represent a nonnegative breakdown of the supplied total, never inferred totals. */
export function chartStackGeometry(
  geometry: ChartGeometry,
  input: readonly ChartSegment[],
) {
  const range = { from: geometry.from, to: geometry.to, label: "" };
  const segments = input.map((segment) => ({
    ...segment,
    points: chartPoints(segment.points, range).points,
  }));
  const byTime = segments.map(
    (segment) => new Map(segment.points.map((point) => [point.time, point])),
  );
  const totals = new Map(geometry.points.map((point) => [point.time, point]));
  const bars: Array<
    ChartGeometry["bars"][number] & { segmentId: string; color: ChartColor }
  > = [];
  const incompleteTimes: number[] = [];
  for (const bar of geometry.bars) {
    const total = totals.get(bar.time)?.value;
    const components = byTime.map((points) => points.get(bar.time));
    if (
      total == null ||
      total < 0 ||
      !segments.length ||
      components.some((point) => point?.value == null || point.value < 0)
    ) {
      incompleteTimes.push(bar.time);
      continue;
    }
    const values = components.map((point) => point!.value!);
    // Dividing before summing avoids overflowing otherwise finite large totals.
    const fractions = values.map((value) =>
      total === 0 ? value : value / total,
    );
    const sum = fractions.reduce((a, b) => a + b, 0);
    if (
      !Number.isFinite(sum) ||
      (total === 0
        ? values.some((value) => value !== 0)
        : Math.abs(sum - 1) > 1e-9)
    ) {
      incompleteTimes.push(bar.time);
      continue;
    }
    const partial = bar.partial || components.some((point) => point?.partial);
    if (total === 0) {
      bars.push({
        ...bar,
        partial,
        segmentId: segments[0].id,
        color: segments[0].color,
      });
      continue;
    }
    let previous = 0;
    for (let index = 0; index < segments.length; index++) {
      const next = Math.min(1, previous + fractions[index]);
      if (values[index] > 0) {
        const bottom = geometry.y(previous * total);
        const top = geometry.y(next * total);
        bars.push({
          ...bar,
          y: top,
          height: Math.max(0, bottom - top),
          partial,
          segmentId: segments[index].id,
          color: segments[index].color,
        });
      }
      previous = next;
    }
  }
  return { segments, bars, incompleteTimes };
}

export function nearestChartPoint(
  points: readonly ChartPoint[],
  time: number,
): number | null {
  if (!points.length) return null;
  let nearest = 0;
  for (let i = 1; i < points.length; i++)
    if (Math.abs(points[i].time - time) < Math.abs(points[nearest].time - time))
      nearest = i;
  return nearest;
}

export function chartShareUrl(current: string, id: string): string {
  const url = new URL(current);
  const range = url.searchParams.get("range");
  url.search = "";
  url.hash = "";
  url.searchParams.set("view", "overview");
  url.searchParams.set("chart", id);
  if (range === "7d" || range === "24h") url.searchParams.set("range", range);
  return url.toString();
}

export function chartFilename(id: string): string {
  const safe = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
  return `paperclub-${safe || "chart"}.png`;
}
