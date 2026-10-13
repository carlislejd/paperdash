export interface ChartAxisOptions {
  /** Approximate number of intervals; round steps may produce one more or fewer. */
  tickCount?: number;
  padding?: number;
  flatPadding?: number;
  minPadding?: number;
  includeZero?: boolean;
  nonnegative?: boolean;
  integer?: boolean;
}

/** One scale for ticks, grid lines and data. Normalize before arithmetic so
 * signed billion-scale series and even finite ±1e308 values remain drawable. */
export function niceChartAxis(
  minimum: number,
  maximum: number,
  options: ChartAxisOptions = {},
) {
  let min = Number.isFinite(minimum) ? minimum : 0;
  let max = Number.isFinite(maximum) ? maximum : 1;
  if (max < min) [min, max] = [max, min];
  if (options.includeZero) {
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  const magnitude =
    Math.max(Math.abs(min), Math.abs(max), options.minPadding ?? 0) || 1;
  const ceiling = Number.MAX_VALUE / magnitude;
  let low = min / magnitude,
    high = max / magnitude;
  const padding = Math.max(
    high === low
      ? Math.max(Math.abs(high), 1) * (options.flatPadding ?? 0.06)
      : (high - low) * (options.padding ?? 0.08),
    (options.minPadding ?? 0) / magnitude,
  );
  const zeroFloor = (options.includeZero && min >= 0) || options.nonnegative;
  if (options.includeZero && min === 0 && max === 0) {
    low = 0;
    high = 1;
  } else {
    low = Math.max(-ceiling, low - padding);
    high = Math.min(ceiling, high + padding);
    if (zeroFloor) low = Math.max(0, low);
  }
  // Adjacent floating-point values need enough representable room for outward
  // tick rounding; otherwise a large offset can collapse both domain endpoints.
  const minimumSpan = Number.EPSILON * 16;
  if (high - low < minimumSpan) {
    low = Math.max(-ceiling, low - minimumSpan / 2);
    high = Math.min(ceiling, high + minimumSpan / 2);
    if (zeroFloor) low = Math.max(0, low);
  }
  const count = Math.max(2, Math.min(8, options.tickCount ?? 4));
  const logStep = Math.log10((high - low) / count) + Math.log10(magnitude);
  const exponent = Math.max(-323, Math.min(308, Math.floor(logStep)));
  const fraction = 10 ** (logStep - exponent);
  const factors =
    options.integer && exponent <= 0 ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10];
  const factor = factors.reduce((best, candidate) =>
    Math.abs(Math.log(fraction / candidate)) <
    Math.abs(Math.log(fraction / best))
      ? candidate
      : best,
  );
  const step = Math.max(
    options.integer ? 1 : Number.MIN_VALUE,
    Math.min(Number.MAX_VALUE, factor * 10 ** exponent),
  );
  const normalizedStep = step / magnitude;
  low = Math.max(-ceiling, Math.floor(low / normalizedStep) * normalizedStep);
  high = Math.min(ceiling, Math.ceil(high / normalizedStep) * normalizedStep);
  const position = (value: number) =>
    Number.isNaN(value)
      ? 0.5
      : Math.max(0, Math.min(1, (value / magnitude - low) / (high - low)));
  const first = Math.ceil(low / normalizedStep - 1e-10);
  const last = Math.floor(high / normalizedStep + 1e-10);
  const ticks: number[] = [];
  // Integer multiples avoid accumulated step error; bound work independently of data.
  for (let i = 0; i < 16 && first + i <= last; i++) {
    const value = Number(((first + i) * step).toPrecision(16));
    if (Number.isFinite(value) && (!ticks.length || value > ticks.at(-1)!))
      ticks.push(Object.is(value, -0) ? 0 : value);
  }
  return { ticks, position };
}

const formatters = new Map<string, Intl.NumberFormat>();
/** Axis precision is independent of tooltip precision. Narrow ranges must not
 * collapse distinct ticks into identical compact labels such as 5M / 5M. */
export function formatAxisTick(
  value: number,
  ticks: readonly number[],
  options: { compact?: boolean; currency?: boolean } = {},
): string {
  const magnitude = Math.max(...ticks.map(Math.abs), Math.abs(value));
  const notation =
    magnitude >= 1e15 || (magnitude > 0 && magnitude < 0.001)
      ? "scientific"
      : options.compact === false
        ? "standard"
        : "compact";
  // Uniqueness alone is insufficient: 2.5 and 7.5 must not become 3 and 8.
  // Preserve each tick's fractional step in the units the formatter displays.
  let requiredDigits = 0;
  for (const tick of ticks) {
    if (!tick) continue;
    const exponent = Math.floor(Math.log10(Math.abs(tick)));
    const divisor =
      notation === "scientific"
        ? 10 ** Math.max(-323, exponent)
        : notation === "compact"
          ? 10 ** Math.max(0, Math.min(12, Math.floor(exponent / 3) * 3))
          : 1;
    const scaled = tick / divisor;
    let digits = 0;
    while (
      digits < 16 &&
      Math.abs(scaled - Number(scaled.toFixed(digits))) >
        Math.abs(scaled) * Number.EPSILON
    )
      digits++;
    requiredDigits = Math.max(requiredDigits, digits);
  }
  for (let digits = requiredDigits; digits <= 16; digits++) {
    const key = `${notation}:${Boolean(options.currency)}:${digits}`;
    let formatter = formatters.get(key);
    if (!formatter) {
      formatter = new Intl.NumberFormat("en-US", {
        notation,
        ...(options.currency ? { style: "currency", currency: "USD" } : {}),
        minimumFractionDigits: 0,
        maximumFractionDigits: digits,
      });
      formatters.set(key, formatter);
    }
    if (
      new Set(ticks.map((tick) => formatter.format(tick))).size === ticks.length
    )
      return formatter.format(value);
  }
  return `${options.currency ? "$" : ""}${value}`;
}
