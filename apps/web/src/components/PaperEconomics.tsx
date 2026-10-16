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
import { StakerYield } from "./StakerYield";
import { stakerYieldDelayed } from "../lib/staker-yield";
import "./paper-economics.css";
import { hourlyChartRangeLabel } from "../lib/chart-summary";

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
  const annualized = data?.annualized;
  const dailyAverageRaw =
    annualized?.usdPerYearRaw != null &&
    /^\d+$/.test(annualized.usdPerYearRaw) &&
    Number.isSafeInteger(annualized.yearDays) &&
    annualized.yearDays > 0
      ? (
          BigInt(annualized.usdPerYearRaw) / BigInt(annualized.yearDays)
        ).toString()
      : null;
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
            {stale
              ? "LAST AVAILABLE"
              : sourceAt === null
                ? "AWAITING DATA"
                : "PROTOCOL SUMMARY"}
          </span>
        </div>
        <StakerYield
          data={data?.stakingYield}
          stale={Boolean(data && (stale || stakerYieldDelayed(data)))}
        />
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
            coverage="Total supply · approximate hourly snapshots · available history"
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
            valueCaption={stakeRatio}
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
        <div className="annualized-revenue">
          <dl>
            <div>
              <dt>Annualized allocation rate</dt>
              <dd>
                <strong title={formatRawUsd(annualized?.usdPerYearRaw)}>
                  {formatRawUsd(annualized?.usdPerYearRaw, true)}
                </strong>
                <small>USDC / year</small>
              </dd>
            </div>
            <div>
              <dt>Average daily staking revenue</dt>
              <dd>
                <strong title={formatRawUsd(dailyAverageRaw)}>
                  {formatRawUsd(dailyAverageRaw, true)}
                </strong>
                <small>USDC / day</small>
              </dd>
            </div>
          </dl>
          <p>
            {annualized?.usdPerYearRaw != null &&
            validChartTime(annualized.fromMs)
              ? `Daily average = lifetime allocations since ${new Date(annualized.fromMs).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })} ÷ protocol age. Annualized = daily average × 365. Historical run rate, not APY or a forecast.`
              : "Waiting for protocol lifetime and allocation totals. This is not APY."}
          </p>
        </div>
        {(error || data?.error) && (
          <p className="paper-read-error" role="status">
            {data
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
