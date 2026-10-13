import { ChartCard } from "./ChartCard";
import type { PaperEconomicsResource } from "./PaperEconomics";
import {
  DAY_MS,
  formatChartNumber,
  formatChartTime,
  validChartTime,
} from "../lib/chart-data";

export function PaperDailyCharts({
  resource,
}: {
  resource: PaperEconomicsResource;
}) {
  const { data, error, loading, refresh } = resource;
  // Anchor “today” to the calendar, not an old successful response. A stale
  // previous day's bar must never become today's headline after midnight.
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const range = {
    from: today - 6 * DAY_MS,
    to: today + DAY_MS,
    label: "7 UTC days · today in progress",
  };
  const definitions = [
    {
      id: "paper-reward-allocation",
      title: "Staking rewards / day",
      unit: "USDC",
      series: data?.daily?.rewardAllocation,
      coverage:
        "USDC allocated to stakers, not distributions or claims · approximate history",
      color: "green",
    },
    {
      id: "paper-supply-change",
      title: "PAPER supply growth / day",
      unit: "PAPER",
      series: data?.daily?.supplyChange,
      coverage:
        "Net supply change, not verified mint totals · approximate history",
      color: "lavender",
    },
  ] as const;
  return definitions.map(({ series, ...definition }) => {
    const current = series?.points.find((point) => point.time === today);
    const observedTo =
      current?.value != null && validChartTime(current.observedToMs)
        ? current.observedToMs
        : null;
    return (
      <ChartCard
        key={definition.id}
        {...definition}
        kind="bar"
        bucketMs={DAY_MS}
        points={series?.points ?? []}
        range={range}
        sourceAt={observedTo ?? data?.sourceAt ?? null}
        stale={Boolean(error || data?.error || data?.stale)}
        loading={loading}
        error={error || data?.error}
        onRetry={refresh}
        valueLabel={formatChartNumber(current?.value)}
        valueCaption="Today so far"
        valueTitle={
          current?.value == null
            ? "Today's change is unavailable without a complete observation interval."
            : `${formatChartNumber(current.value, false)} ${definition.unit}${observedTo === null ? "" : ` through ${formatChartTime(observedTo)}`}`
        }
      />
    );
  });
}
