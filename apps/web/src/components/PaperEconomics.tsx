import type { PaperEconomicsResponse } from "../../../../packages/shared/src/types";
import { formatRawUsd, rawToNumber } from "../lib/format";
import {
  formatChartNumber,
  formatChartTime,
  HOUR_MS,
  validChartTime,
  type ChartRange,
} from "../lib/chart-data";
import { ChartCard } from "./ChartCard";
import { StakingRewardHistory } from "./StakingRewardHistory";
import { StakerRevenue } from "./StakerRevenue";
import "./paper-economics.css";
import { hourlyChartRangeLabel } from "../lib/chart-summary";
import { stakerYieldDelayed } from "../lib/staker-yield";

function paperTitle(raw: string | null | undefined): string {
  if (raw == null || !/^\d+$/.test(raw)) return "Unavailable";
  const value = BigInt(raw),
    whole = value / 10n ** 18n,
    fraction = (value % 10n ** 18n)
      .toString()
      .padStart(18, "0")
      .replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""} PAPER`;
}

export interface PaperEconomicsResource {
  data: PaperEconomicsResponse | null;
  error: string;
  loading: boolean;
  refresh: () => void;
}

export function PaperRewardHistory({ resource }: { resource: PaperEconomicsResource }) {
  const { data, error, loading } = resource;
  const sourceAt = validChartTime(data?.sourceAt) ? data.sourceAt : null;
  const stale = Boolean(error || data?.error || data?.stale);
  return (
    <StakingRewardHistory
      history={data?.stakingRewardHistory}
      sourceAt={data?.onchain?.sourceAt ?? sourceAt}
      stale={data?.onchain ? Boolean(error || stakerYieldDelayed(data)) : stale}
      maxAgeMs={data?.onchain ? 90000 : 60000}
      loading={loading}
    />
  );
}

export function PaperEconomics({
  chartRange,
  resource,
}: {
  chartRange?: ChartRange;
  resource: PaperEconomicsResource;
}) {
  const { data, error, loading, refresh } = resource;
  const sourceAt = validChartTime(data?.sourceAt) ? data.sourceAt : null;
  const to = sourceAt ?? Date.now();
  const hours =
    chartRange && chartRange.to - chartRange.from > 24 * HOUR_MS ? 168 : 24;
  const range = {
    from: Math.max(
      0,
      Math.floor(to / HOUR_MS) * HOUR_MS - (hours - 1) * HOUR_MS,
    ),
    to,
    label: hourlyChartRangeLabel(hours),
  };
  const stale = Boolean(error || data?.error || data?.stale);
  const common = { range, sourceAt, stale, loading };
  const chainStale = Boolean(error || stakerYieldDelayed(data));
  const stakeRatio =
    data?.stakeRatioBps != null &&
    Number.isSafeInteger(data.stakeRatioBps) &&
    data.stakeRatioBps >= 0 &&
    data.stakeRatioBps <= 10000
      ? `${(data.stakeRatioBps / 100).toFixed(2)}% of supply`
      : "Share unavailable";
  return (
    <>
      <div
        className="paper-panel paper-economics"
        role="region"
        aria-label="PAPER economics"
      >
        <div className="section-heading">
          <h2>PAPER</h2>
          <span className="tiny-caption" title={formatChartTime(sourceAt)}>
            {data?.onchain ? "CHAIN + PROTOCOL" : stale
              ? "LAST AVAILABLE"
              : sourceAt === null
                ? "AWAITING DATA"
                : "PROTOCOL SUMMARY"}
          </span>
        </div>
        <StakerRevenue data={data} stale={stale} loading={loading} />
        <div className="paper-details">
          <ChartCard
            {...common}
            compact
            id="paper-supply"
            title="PAPER supply"
            unit="PAPER"
            kind="line"
            points={data?.series?.supply?.points ?? []}
            valueLabel={formatChartNumber(rawToNumber(data?.supplyRaw))}
            valueTitle={paperTitle(data?.supplyRaw)}
            valueCaption={data?.onchain ? `Onchain${chainStale ? " · last available" : ""}` : undefined}
            timestampLabel={data?.onchain ? "Protocol history" : undefined}
            coverage="Total supply · approximate protocol hourly snapshots · available history"
          />
          <ChartCard
            {...common}
            compact
            id="paper-staked"
            title="PAPER staked"
            unit="PAPER"
            kind="line"
            points={data?.series?.staked?.points ?? []}
            valueLabel={formatChartNumber(rawToNumber(data?.stakedRaw))}
            valueTitle={paperTitle(data?.stakedRaw)}
            valueCaption={`${stakeRatio}${data?.onchain ? ` · Onchain${chainStale ? " · last available" : ""}` : ""}`}
            timestampLabel={data?.onchain ? "Protocol history" : undefined}
            coverage="Currently staked · approximate hourly snapshots · available history"
          />
          <ChartCard
            {...common}
            compact
            id="staking-revenue"
            title="Rewards allocated"
            unit="USDC"
            kind="line"
            points={data?.series?.allocated?.points ?? []}
            valueLabel={formatRawUsd(data?.allocatedRewardsRaw, true)}
            valueTitle={formatRawUsd(data?.allocatedRewardsRaw)}
            valueCaption="Lifetime"
            coverage="Lifetime USDC allocated to stakers, including unclaimed rewards · approximate hourly history"
          />
          <p className="paper-allocation-note">
            Allocated to stakers, including unclaimed rewards.
          </p>
          <dl className="paper-pending">
            <div>
              <dt>
                Pending rewards <span>source-reported</span>
              </dt>
              <dd title={formatRawUsd(data?.pendingRewardsRaw)}>
                {formatRawUsd(data?.pendingRewardsRaw, true)}{" "}
                <small>USDC</small>
              </dd>
            </div>
          </dl>
          <p className="paper-pending-note">
            Protocol total, not wallet claimable rewards.
          </p>
        </div>
        {(error || data?.error) && (
          <p className="paper-read-error" role="status">
            {data?.onchain && !error
              ? "Protocol allocations and history are delayed. Onchain balances and staking rewards update separately."
              : data
              ? "PAPER data could not be refreshed. Saved values shown."
              : "PAPER economics data is not available yet."}{" "}
            <button type="button" onClick={refresh} disabled={loading}>
              Retry
            </button>
          </p>
        )}
      </div>
    </>
  );
}
