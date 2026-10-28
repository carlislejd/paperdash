import { useId, useMemo } from "react";
import type { HouseResponse } from "../../../../packages/shared/src/types";
import { useAnalytics } from "../lib/use-analytics";
import { formatRawUsd, rawToNumber } from "../lib/format";
import { ChartCard } from "./ChartCard";
import { PaperEconomics, PaperRewardHistory, type PaperEconomicsResource } from "./PaperEconomics";
import {
  formatChartTime,
  validChartTime,
  type ChartRange,
} from "../lib/chart-data";
import "./protocol-stats.css";

const components = [
  { id: "house-lp", title: "LP balance", field: "lpRaw" },
  { id: "house-open-pnl", title: "Open house PnL", field: "openPnlRaw" },
  { id: "house-queue-debt", title: "Queued payouts", field: "queueDebtRaw" },
] as const;

function rawDelta(value: string | null | undefined): bigint | null {
  return typeof value === "string" &&
    value.length <= 79 &&
    /^-?\d+$/.test(value)
    ? BigInt(value)
    : null;
}

function signedUsd(value: bigint, compact = false) {
  return `${value > 0n ? "+" : ""}${formatRawUsd(value.toString(), compact)}`;
}

function HouseChange({ change }: { change: HouseResponse["change"] }) {
  const net = rawDelta(change?.fundsRaw);
  const lp = rawDelta(change?.lpRaw);
  const pnl = rawDelta(change?.openPnlRaw);
  const debt = rawDelta(change?.queueDebtRaw);
  if (
    !change ||
    net === null ||
    lp === null ||
    pnl === null ||
    debt === null ||
    !validChartTime(change.fromMs) ||
    !validChartTime(change.toMs) ||
    change.fromMs >= change.toMs ||
    !Number.isSafeInteger(change.sampleCount) ||
    change.sampleCount < 2
  )
    return (
      <div className="house-change house-change--unavailable">
        <h3>House funds change</h3>
        <p>Change unavailable for the available history.</p>
      </div>
    );
  const contributions = [
    { label: "LP balance", value: lp },
    { label: "Open house PnL", value: pnl },
    { label: "Queued payout effect", value: -debt },
  ];
  const maximum = contributions.reduce((max, { value }) => {
    const magnitude = value < 0n ? -value : value;
    return magnitude > max ? magnitude : max;
  }, 0n);
  return (
    <section className="house-change" aria-label="House funds change">
      <div className="house-change-heading">
        <h3>House funds change</h3>
        <strong
          className={net === 0n ? "muted" : net < 0n ? "negative" : "positive"}
          title={signedUsd(net)}
        >
          {signedUsd(net, true)}
        </strong>
      </div>
      <p className="house-change-period">
        Change since{" "}
        <time dateTime={new Date(change.fromMs).toISOString()}>
          {formatChartTime(change.fromMs)}
        </time>
        <span title={`${change.sampleCount.toLocaleString()} observations`}>
          {" "}
          · through {formatChartTime(change.toMs, false)}
        </span>
      </p>
      <dl className="house-contributions">
        {contributions.map(({ label, value }) => {
          const magnitude = value < 0n ? -value : value;
          const width =
            maximum === 0n ? 0 : Number((magnitude * 10000n) / maximum) / 200;
          const direction =
            value < 0n ? "negative" : value > 0n ? "positive" : "muted";
          return (
            <div key={label}>
              <dt>{label}</dt>
              <dd
                className={direction}
                title={`${signedUsd(value)} contribution to house funds`}
              >
                <span className="house-contribution-track" aria-hidden="true">
                  <i
                    style={{
                      width: `${width}%`,
                      left: value < 0n ? `${50 - width}%` : "50%",
                    }}
                  />
                </span>
                <span>{signedUsd(value, true)}</span>
              </dd>
            </div>
          );
        })}
      </dl>
      <p className="protocol-method">
        More queued payouts reduce funds; fewer queued payouts increase funds.
      </p>
    </section>
  );
}

export function HouseStats({
  chartRange,
  paper,
}: {
  chartRange?: ChartRange;
  paper: PaperEconomicsResource;
}) {
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
  const stale = Boolean(error || (data?.houseStale ?? data?.stale));
  const houseError =
    error || (data?.houseStale === false ? undefined : data?.error);
  const sourceAt = validChartTime(data?.sourceAt) ? data.sourceAt : null;
  const houseTo = sourceAt ?? Date.now();
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
      <section className="house-funds" aria-label="House health">
        <div className="section-heading house-health-heading">
          <h2>House health</h2>
          <span
            className={`house-health-status${stale ? " house-health-status--stale" : ""}`}
            title={sourceAt === null ? undefined : formatChartTime(sourceAt)}
          >
            {sourceAt === null ? (
              loading ? "Loading snapshot" : "Awaiting snapshot"
            ) : (
              <>
                {stale ? "Last available" : "Updated"} ·{" "}
                <time dateTime={new Date(sourceAt).toISOString()}>
                  {formatChartTime(sourceAt, false)}
                </time>
              </>
            )}
          </span>
        </div>
        <ChartCard
          id="house-funds"
          title="House funds"
          unit="USDC"
          kind="line"
          points={points}
          range={houseRange}
          sourceAt={sourceAt}
          valueLabel={formatRawUsd(data?.house?.fundsRaw, true)}
          valueTitle={formatRawUsd(data?.house?.fundsRaw)}
          valueCaption="After open PnL & queued payouts"
          coverage="Estimated · available observations · gaps unknown"
          stale={stale}
          loading={loading}
          error={houseError}
          onRetry={refresh}
        />
        <div className="house-components" aria-describedby={id}>
          {components.map(({ id, title, field }) => (
            <ChartCard
              key={id}
              id={id}
              title={title}
              unit="USDC"
              kind="line"
              compact
              points={(data?.history ?? []).map((point) => ({
                time: point.time,
                value: rawToNumber(point[field]),
                gapBefore: point.gapBefore,
              }))}
              range={houseRange}
              sourceAt={sourceAt}
              valueLabel={formatRawUsd(data?.house?.[field], true)}
              valueTitle={formatRawUsd(data?.house?.[field])}
              coverage="Estimated · available observations · gaps unknown"
              stale={stale}
              loading={loading}
            />
          ))}
        </div>
        <p id={id} className="protocol-method">
          House funds = LP balance + open house PnL − queued payouts. Includes
          unrealized trading PnL; snapshot estimate.
        </p>
        <HouseChange change={data?.change} />
        {error && (
          <button className="text-button" onClick={refresh}>
            Retry house data
          </button>
        )}
      </section>
      <PaperEconomics chartRange={chartRange} resource={paper} />
      <PaperRewardHistory resource={paper} />
    </section>
  );
}
