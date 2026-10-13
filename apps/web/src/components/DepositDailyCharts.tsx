import type { DepositDailyResponse } from "../../../../packages/shared/src/types";
import { ChartCard } from "./ChartCard";
import { DAY_MS, formatChartNumber } from "../lib/chart-data";
import { depositDailyPoints } from "../lib/deposit-daily";
import { formatRawUsd } from "../lib/format";

export function DepositDailyCharts({
  data,
  error,
  loading,
  refresh,
  stale = false,
}: {
  data?: DepositDailyResponse;
  error?: string | null;
  loading: boolean;
  stale?: boolean;
  refresh: () => void;
}) {
  const { counts, volume, range, today } = depositDailyPoints(
    data,
    Date.now(),
    Boolean(error || stale),
  );
  const coverage = !data
    ? "Awaiting retained deposit history"
    : `Partial history · earlier deposits can revise totals${
        data.coverage.pending || !data.coverage.projectionBackfillComplete
          ? " · stored history catching up"
          : ""
      }${data.coverage.excludedRecords ? " · some records unavailable" : ""}`;
  const current = data?.days.find((day) => day.time === today);
  return [
    {
      id: "first-time-depositors",
      title: "First-time depositors",
      unit: "wallets",
      points: counts,
      color: "lavender" as const,
      meaning: "Earliest recorded deposit per wallet; wallets are not people",
      valueTitle: `${formatChartNumber(counts.at(-1)?.value, false)} wallets with their earliest recorded deposit today`,
    },
    {
      id: "daily-deposit-volume",
      title: "Deposit volume / day",
      unit: "USDC",
      points: volume,
      color: "green" as const,
      meaning: "Credited deposits, including repeat deposits",
      valueTitle: current
        ? `${formatRawUsd(current.depositVolumeRaw)} USDC credited today`
        : volume.at(-1)?.value === 0
          ? "0.00 USDC recorded today"
          : "Today's recorded deposits are unavailable",
    },
  ].map(({ meaning, ...definition }) => (
    <ChartCard
      key={definition.id}
      {...definition}
      kind="bar"
      bucketMs={DAY_MS}
      range={range}
      sourceAt={data?.updatedAt ?? null}
      timestampLabel="Stored totals updated"
      coverage={`${meaning} · ${coverage}`}
      stale={Boolean(stale || error || data?.error || data?.stale)}
      loading={loading}
      error={error || data?.error}
      onRetry={refresh}
      valueLabel={formatChartNumber(definition.points.at(-1)?.value)}
      valueCaption="Today so far"
    />
  ));
}
