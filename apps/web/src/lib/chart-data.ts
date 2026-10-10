export interface ChartPoint {
  /** Source observation time, or the start of an hourly UTC bucket. */
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
export const CHART_POINT_LIMIT = 2048;
export const HOUR_MS = 3_600_000;

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
): ChartGeometry {
  const range = chartRange(rangeInput);
  const prepared = chartPoints(input, range);
  const { points } = prepared;
  const values = points.flatMap((p) => (p.value === null ? [] : [p.value]));
  const magnitude = Math.max(...values.map(Math.abs), 0) || 1;
  let low = values.length ? Math.min(...values) / magnitude : 0;
  let high = values.length ? Math.max(...values) / magnitude : 1;
  if (kind === "bar") {
    low = Math.min(low, 0);
    high = Math.max(high, 0);
  }
  const pad =
    high === low ? Math.max(Math.abs(high) * 0.06, 0.06) : (high - low) * 0.08;
  low -= pad;
  high += pad;
  const x = (time: number) =>
    Math.max(
      0,
      Math.min(width, ((time - range.from) / (range.to - range.from)) * width),
    );
  const y = (value: number) =>
    Math.max(
      0,
      Math.min(height, ((high - value / magnitude) / (high - low)) * height),
    );
  const ticks = [0.1, 0.5, 0.9].map((fraction) => ({
    y: fraction * height,
    value: Math.max(
      -Number.MAX_VALUE,
      Math.min(Number.MAX_VALUE, (high - (high - low) * fraction) * magnitude),
    ),
  }));
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
        x: start + Math.min(1.5, (end - start) * 0.12),
        y: Math.min(y(0), y(point.value)),
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
