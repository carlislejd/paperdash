import { useId, useMemo, useState } from "react";
import type { HouseResponse } from "../../../../packages/shared/src/types";
import { useAnalytics } from "../lib/use-analytics";
import { formatRawUsd, rawToNumber, relativeTime } from "../lib/format";
import "./protocol-stats.css";

export function HouseStats() {
  const { data, error, loading, refresh } =
    useAnalytics<HouseResponse>("/api/house");
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const points = useMemo(
    () =>
      (data?.history ?? []).flatMap((point) => {
        const value = rawToNumber(point.fundsRaw);
        return value === null ? [] : [{ ...point, value }];
      }),
    [data?.history],
  );
  const first = points[0]?.time ?? 0,
    last = points.at(-1)?.time ?? 1;
  const low = Math.min(...points.map((p) => p.value), 0);
  const high = Math.max(...points.map((p) => p.value), 1);
  const x = (time: number) =>
    first === last ? 350 : 8 + ((time - first) / (last - first)) * 684;
  const y = (value: number) =>
    136 - ((value - low) / Math.max(high - low, 1)) * 118;
  const path = points
    .map(
      (p, i) =>
        `${i === 0 || p.gapBefore ? "M" : "L"}${x(p.time).toFixed(2)},${y(p.value).toFixed(2)}`,
    )
    .join(" ");
  const active =
    points[
      hover === null ? points.length - 1 : Math.min(hover, points.length - 1)
    ];
  const stale = Boolean(error || data?.stale);
  const paper = (raw: string | null | undefined) => {
    const value = rawToNumber(raw);
    return value === null
      ? "—"
      : new Intl.NumberFormat("en-US", {
          notation: "compact",
          maximumFractionDigits: 2,
        }).format(value);
  };
  return (
    <section className="house-panel" aria-label="House and PAPER statistics">
      <div className="house-funds">
        <div className="section-heading">
          <h2>House funds</h2>
          <span className={stale ? "tiny-caption negative" : "tiny-caption"}>
            {!data
              ? loading
                ? "Loading"
                : "Unavailable"
              : stale
                ? "Last available"
                : "Updating"}
          </span>
        </div>
        <div className="house-value">
          <strong title={formatRawUsd(data?.house?.fundsRaw)}>
            {formatRawUsd(
              hover === null ? data?.house?.fundsRaw : active?.fundsRaw,
              true,
            )}
          </strong>
          <span>
            {hover === null
              ? relativeTime(data?.sourceAt)
              : active && new Date(active.time).toLocaleTimeString()}
          </span>
        </div>
        <div className="house-chart" onMouseLeave={() => setHover(null)}>
          {points.length ? (
            <svg
              viewBox="0 0 700 150"
              preserveAspectRatio="none"
              role="img"
              aria-label={`House funds, ${points.length} retained observations over the available last 24 hours`}
              onMouseMove={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                const target =
                  first +
                  Math.max(
                    0,
                    Math.min(1, (event.clientX - box.left) / box.width),
                  ) *
                    (last - first);
                let nearest = 0;
                points.forEach((p, i) => {
                  if (
                    Math.abs(p.time - target) <
                    Math.abs(points[nearest].time - target)
                  )
                    nearest = i;
                });
                setHover(nearest);
              }}
            >
              <line
                x1="0"
                x2="700"
                y1={y(0)}
                y2={y(0)}
                stroke="currentColor"
                opacity=".2"
                strokeDasharray="3 6"
              />
              <path
                d={path}
                fill="none"
                stroke="#9576b2"
                strokeWidth="2.4"
                vectorEffect="non-scaling-stroke"
              />
              {active && (
                <circle
                  cx={x(active.time)}
                  cy={y(active.value)}
                  r="4"
                  fill="#9576b2"
                  stroke="var(--paper)"
                  strokeWidth="2"
                />
              )}
            </svg>
          ) : (
            <p className="house-chart-empty">Waiting for house observations</p>
          )}
        </div>
        <div className="house-chart-caption">
          <span>24h · available observations</span>
          <span>USDC</span>
        </div>
        <p id={id} className="protocol-method">
          LP balance + open house PnL − queue debt
        </p>
        {error && (
          <button className="text-button" onClick={refresh}>
            Retry house data
          </button>
        )}
      </div>
      <div className="house-breakdown" aria-describedby={id}>
        <dl className="house-details">
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
        <h3>PAPER</h3>
        <dl className="paper-details">
          <div>
            <dt>Supply</dt>
            <dd>{paper(data?.paper.supplyRaw)}</dd>
          </div>
          <div>
            <dt>Staked</dt>
            <dd>{paper(data?.paper.stakedRaw)}</dd>
          </div>
          <div>
            <dt>
              Staker rewards <small>lifetime</small>
            </dt>
            <dd title={formatRawUsd(data?.paper.stakerRewardsRaw)}>
              {formatRawUsd(data?.paper.stakerRewardsRaw, true)}
            </dd>
          </div>
        </dl>
        <p className="protocol-method">
          House values are estimates. PAPER updated{" "}
          {relativeTime(data?.summarySourceAt).toLowerCase()}.
        </p>
      </div>
    </section>
  );
}
