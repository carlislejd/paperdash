import { useId, useMemo } from "react";
import type { HouseResponse } from "../../../../packages/shared/src/types";
import { useAnalytics } from "../lib/use-analytics";
import { formatRawUsd, rawToNumber } from "../lib/format";
import { ChartCard } from "./ChartCard";
import { PaperEconomics } from "./PaperEconomics";
import { validChartTime, type ChartRange } from "../lib/chart-data";
import "./protocol-stats.css";

export function HouseStats({
  chartRange,
}: {
  chartRange?: ChartRange;
} = {}) {
  const { data, error, loading, refresh } =
    useAnalytics<HouseResponse>("/api/house");
  const id = useId();
  const points = useMemo(
    () =>
      (data?.history ?? []).map((point) => ({
        ...point,
        value: rawToNumber(point.fundsRaw),
      })),
    [data?.history],
  );
  const stale = Boolean(error || data?.stale);
  const houseTo = validChartTime(data?.sourceAt) ? data.sourceAt : Date.now();
  const dayStart = Math.max(0, houseTo - 86400000);
  const availableTimes = points
    .filter(
      (point) =>
        validChartTime(point.time) &&
        point.time >= dayStart &&
        point.time <= houseTo,
    )
    .map((point) => point.time);
  const houseRange = {
    // The endpoint retains at most a day. Fit shorter history without inventing
    // earlier points, while keeping a meaningful interval for a single sample.
    from: availableTimes.length
      ? Math.max(dayStart, Math.min(...availableTimes, houseTo - 60000))
      : dayStart,
    to: houseTo,
    label: availableTimes.length
      ? "Available history · up to 24h"
      : "24 hours · awaiting observations",
  };
  return (
    <section className="house-panel" aria-label="House and PAPER statistics">
      <div className="house-funds">
        <ChartCard
          id="house-funds"
          title="House funds"
          unit="USDC"
          kind="line"
          points={points}
          range={houseRange}
          sourceAt={data?.sourceAt ?? null}
          valueLabel={formatRawUsd(data?.house?.fundsRaw, true)}
          valueTitle={formatRawUsd(data?.house?.fundsRaw)}
          coverage="Estimated · available observations · gaps unknown"
          stale={stale}
          loading={loading}
          error={error}
          onRetry={refresh}
        />
        <dl className="house-details" aria-describedby={id}>
          <div>
            <dt>LP balance</dt>
            <dd title={formatRawUsd(data?.house?.lpRaw)}>
              {formatRawUsd(data?.house?.lpRaw, true)}
            </dd>
          </div>
          <div>
            <dt>Open house PnL</dt>
            <dd
              className={
                (rawToNumber(data?.house?.openPnlRaw) ?? 0) < 0
                  ? "negative"
                  : "positive"
              }
              title={formatRawUsd(data?.house?.openPnlRaw)}
            >
              {formatRawUsd(data?.house?.openPnlRaw, true)}
            </dd>
          </div>
          <div>
            <dt>Queue debt</dt>
            <dd title={formatRawUsd(data?.house?.queueDebtRaw)}>
              {formatRawUsd(data?.house?.queueDebtRaw, true)}
            </dd>
          </div>
        </dl>
        <p id={id} className="protocol-method">
          LP balance + open house PnL − queue debt · estimated
        </p>
        {error && (
          <button className="text-button" onClick={refresh}>
            Retry house data
          </button>
        )}
      </div>
      <PaperEconomics chartRange={chartRange} />
    </section>
  );
}
