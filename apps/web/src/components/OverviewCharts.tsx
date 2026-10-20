import { useEffect, useState } from "react";
import type {
  PaperEconomicsResponse,
  ProtocolChartsResponse,
} from "../../../../packages/shared/src/types";
import { useAnalytics } from "../lib/use-analytics";
import { ChartCard } from "./ChartCard";
import { HouseStats } from "./HouseStats";
import { PaperDailyCharts } from "./PaperDailyCharts";
import { DepositDailyCharts } from "./DepositDailyCharts";
import { hourlyChartRangeLabel } from "../lib/chart-summary";

export function OverviewCharts() {
  const readHours = () =>
    new URLSearchParams(location.search).get("range") === "7d" ? 168 : 24;
  const [hours, setHours] = useState(readHours);
  const readLegacyTvl = () =>
    new URLSearchParams(location.search).get("chart") === "tvl";
  const [legacyTvl, setLegacyTvl] = useState(readLegacyTvl);
  useEffect(() => {
    const changed = () => {
      setHours(readHours());
      setLegacyTvl(readLegacyTvl());
    };
    window.addEventListener("popstate", changed);
    return () => window.removeEventListener("popstate", changed);
  }, []);
  const chooseHours = (value: number) => {
    setHours(value);
    const url = new URL(location.href);
    if (value === 168) url.searchParams.set("range", "7d");
    else url.searchParams.delete("range");
    history.replaceState(history.state, "", url);
  };
  const { data, error, loading, refresh } =
    useAnalytics<ProtocolChartsResponse>("/api/protocol/charts");
  const paper = useAnalytics<PaperEconomicsResponse>("/api/paper/economics");
  const to = data?.sourceAt ?? Date.now();
  const range = {
    from: Math.max(
      0,
      Math.floor(to / 3600000) * 3600000 - (hours - 1) * 3600000,
    ),
    to,
    label: hourlyChartRangeLabel(hours),
  };
  const common = {
    range,
    sourceAt: data?.sourceAt ?? null,
    stale: Boolean(error || data?.stale),
    loading,
    error,
    onRetry: refresh,
  };
  return (
    <>
      <HouseStats chartRange={range} paper={paper} />
      <section className="overview-chart-section" aria-label="Protocol charts">
        <div className="overview-chart-toolbar">
          <p>
            Daily PAPER, rewards & deposits · hourly trading · expand or save
            any chart
          </p>
          <div className="range-control" aria-label="Trading history range">
            {[24, 168].map((value) => (
              <button
                key={value}
                aria-pressed={hours === value}
                onClick={() => chooseHours(value)}
              >
                {value === 24 ? "24h" : "7d"}
              </button>
            ))}
          </div>
        </div>
        <div className="overview-chart-grid">
          <PaperDailyCharts resource={paper} />
          <DepositDailyCharts
            data={data?.deposits}
            error={error}
            loading={loading}
            stale={data?.stale}
            refresh={refresh}
          />
          <ChartCard
            {...common}
            id="volume"
            title="Volume / hour"
            unit="USDC"
            kind="bar"
            aggregate="sum"
            points={data?.series.volume.points ?? []}
            coverage="Traded notional in the selected buckets · partial hours marked; gaps unknown"
          />
          <ChartCard
            {...common}
            id="open-positions"
            title="Open positions"
            unit="positions"
            kind="bar"
            points={data?.series.openPositions.points ?? []}
            coverage="Latest count each hour · partial history; gaps unknown"
          />
        </div>
      </section>
      {/* Keep previously shared TVL links working without a duplicate overview card. */}
      {legacyTvl && (
        <div hidden>
          <ChartCard
            {...common}
            id="tvl"
            title="TVL"
            unit="USDC"
            kind="line"
            color="green"
            points={data?.series.tvl.points ?? []}
            coverage="Hourly snapshots · available history"
          />
        </div>
      )}
    </>
  );
}
