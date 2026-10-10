import { useId, useMemo } from "react";
import type {
  HouseResponse,
  ProtocolChartsResponse,
} from "../../../../packages/shared/src/types";
import { useAnalytics } from "../lib/use-analytics";
import { formatRawUsd, rawToNumber, relativeTime } from "../lib/format";
import { ChartCard } from "./ChartCard";
import type { ChartRange } from "../lib/chart-data";
import "./protocol-stats.css";

export function HouseStats({
  charts,
  chartRange,
  chartsDelayed = false,
}: {
  charts?: ProtocolChartsResponse | null;
  chartRange?: ChartRange;
  chartsDelayed?: boolean;
} = {}) {
  const { data, error, loading, refresh } =
    useAnalytics<HouseResponse>("/api/house");
  const id = useId();
  const points = useMemo(
    () =>
      (data?.history ?? []).flatMap((point) => {
        const value = rawToNumber(point.fundsRaw);
        return value === null ? [] : [{ ...point, value }];
      }),
    [data?.history],
  );
  const stale = Boolean(error || data?.stale);
  const paper = (raw: string | null | undefined, compact = true) => {
    const value = rawToNumber(raw);
    return value === null
      ? "—"
      : new Intl.NumberFormat("en-US", {
          notation: compact ? "compact" : "standard",
          maximumFractionDigits: 2,
        }).format(value);
  };
  const houseTo = data?.sourceAt ?? Date.now();
  const houseRange = {
    from: Math.max(0, houseTo - 86400000),
    to: houseTo,
    label: "24 hours",
  };
  const paperRange = chartRange ?? houseRange;
  const annualized = data?.annualizedStakingRevenue;
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
      <div className="paper-panel">
        <div className="section-heading">
          <h2>PAPER</h2>
          <span className="tiny-caption">
            {relativeTime(data?.summarySourceAt)}
          </span>
        </div>
        <div className="paper-details">
          <ChartCard
            compact
            id="paper-supply"
            title="PAPER supply"
            unit="PAPER"
            kind="line"
            points={charts?.series.paperSupply.points ?? []}
            range={paperRange}
            sourceAt={charts?.sourceAt ?? null}
            valueLabel={paper(data?.paper.supplyRaw)}
            valueTitle={`${paper(data?.paper.supplyRaw, false)} PAPER`}
            coverage="Total supply · hourly snapshots · available history"
            stale={stale || chartsDelayed}
            loading={loading}
          />
          <ChartCard
            compact
            id="paper-staked"
            title="PAPER staked"
            unit="PAPER"
            kind="line"
            points={charts?.series.paperStaked.points ?? []}
            range={paperRange}
            sourceAt={charts?.sourceAt ?? null}
            valueLabel={paper(data?.paper.stakedRaw)}
            valueTitle={`${paper(data?.paper.stakedRaw, false)} PAPER`}
            coverage="Currently staked · hourly snapshots · available history"
            stale={stale || chartsDelayed}
            loading={loading}
          />
          <ChartCard
            compact
            id="staking-revenue"
            title="Staking revenue"
            unit="USDC"
            kind="line"
            points={charts?.series.stakingRewards.points ?? []}
            range={paperRange}
            sourceAt={charts?.sourceAt ?? null}
            valueLabel={formatRawUsd(data?.paper.stakerRewardsRaw, true)}
            valueTitle={formatRawUsd(data?.paper.stakerRewardsRaw)}
            coverage="Lifetime allocated, including unclaimed rewards · available history"
            stale={stale || chartsDelayed}
            loading={loading}
          />
        </div>
        <div className="annualized-revenue">
          <span>Annualized staking revenue</span>
          <strong title={formatRawUsd(annualized?.usdPerYearRaw)}>
            {formatRawUsd(annualized?.usdPerYearRaw, true)}
            <small> USDC / year</small>
          </strong>
          <p>
            {annualized?.usdPerYearRaw != null && annualized.fromMs != null
              ? `Lifetime rewards since ${new Date(annualized.fromMs).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })} ÷ elapsed time × 365 days. Historical rate, not a forecast.`
              : "Waiting for verified protocol lifetime and reward totals."}
          </p>
        </div>
      </div>
    </section>
  );
}
