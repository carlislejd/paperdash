import { useMemo } from "react";
import { niceChartAxis } from "../lib/chart-axis";
import type {
  AssetActivity,
  AssetOiSample,
  AssetsResponse,
  AssetSummary,
} from "../../../../packages/shared/src/types";
import {
  formatRawUsd,
  formatUsd,
  rawToNumber,
  relativeTime,
} from "../lib/format";
import { useAnalytics } from "../lib/use-analytics";
import { AssetLivePanel } from "./AssetLivePanel";
import {
  AnalyticsNotice,
  AnalyticsStatus,
  AnalyticsWallet,
} from "./AnalyticsShared";

function share(value: number | null | undefined) {
  return value !== null &&
    value !== undefined &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
    ? `${value.toFixed(1)}%`
    : "—";
}

function InterestHistory({
  history,
  symbol,
}: {
  history: AssetOiSample[];
  symbol: string;
}) {
  const points = useMemo(
    () =>
      history
        .map((point) => ({
          time: point.time,
          long: rawToNumber(point.longRaw),
          short: rawToNumber(point.shortRaw),
        }))
        .filter(
          (point): point is { time: number; long: number; short: number } =>
            Number.isFinite(point.time) &&
            point.long !== null &&
            point.short !== null &&
            point.long >= 0 &&
            point.short >= 0,
        )
        .sort((a, b) => a.time - b.time),
    [history],
  );
  if (!points.length)
    return (
      <div className="analytics-empty">
        <strong>No retained open-interest history</strong>
        <p>New snapshots will appear as they are recorded.</p>
      </div>
    );
  const width = 650,
    height = 160,
    pad = 8;
  const first = points[0].time,
    last = points.at(-1)!.time;
  const maximum = Math.max(
    ...points.flatMap((point) => [point.long, point.short]),
    1,
  );
  const axis = niceChartAxis(0, maximum, {
    includeZero: true,
    padding: 0,
    tickCount: 2,
  });
  const x = (time: number) =>
    pad + ((time - first) / (last - first || 1)) * (width - 2 * pad);
  const y = (value: number) =>
    height - pad - axis.position(value) * (height - 2 * pad);
  const path = (side: "long" | "short") =>
    points
      .map(
        (point, index) =>
          `${index === 0 || point.time - points[index - 1].time > 300_000 ? "M" : "L"}${x(point.time).toFixed(2)},${y(point[side]).toFixed(2)}`,
      )
      .join(" ");
  const date = (time: number) =>
    new Date(time).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  return (
    <>
      <div className="asset-chart-legend">
        <span>Longs</span>
        <span>Shorts</span>
        <small className="asset-chart-unit">USD entry notional</small>
      </div>
      <svg
        className="asset-chart"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${symbol} open-interest history, ${points.length} recorded snapshots. Latest long ${formatUsd(points.at(-1)!.long)}, short ${formatUsd(points.at(-1)!.short)}.`}
      >
        {axis.ticks.map((value) => (
          <line
            key={value}
            x1={pad}
            x2={width - pad}
            y1={y(value)}
            y2={y(value)}
            stroke="currentColor"
            strokeOpacity=".12"
            strokeDasharray="2 5"
          />
        ))}
        <path
          d={path("long")}
          stroke="#668354"
          strokeWidth="2"
          fill="none"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={path("short")}
          stroke="#a1809a"
          strokeWidth="2"
          fill="none"
          strokeDasharray="5 3"
          vectorEffect="non-scaling-stroke"
        />
        <circle cx={x(last)} cy={y(points.at(-1)!.long)} r="3" fill="#668354" />
        <circle
          cx={x(last)}
          cy={y(points.at(-1)!.short)}
          r="3"
          fill="#a1809a"
        />
      </svg>
      <div className="asset-chart-dates">
        <time dateTime={new Date(first).toISOString()}>{date(first)}</time>
        <time dateTime={new Date(last).toISOString()}>{date(last)}</time>
      </div>
      <p className="analytics-footnote">
        Retained snapshots · gaps over 5 minutes are left unconnected.
      </p>
    </>
  );
}

function ObservedActivity({
  activity,
  receivedAt,
}: {
  activity: AssetActivity | null;
  receivedAt: number | null;
}) {
  return (
    <section
      className="asset-activity-summary"
      aria-labelledby="observed-activity-heading"
    >
      <h4 className="analytics-subheading" id="observed-activity-heading">
        Observed · 24h
      </h4>
      <dl className="observed-stats">
        <div>
          <dt>Executions</dt>
          <dd>{activity?.counts.total.toLocaleString() ?? "—"}</dd>
        </div>
        <div>
          <dt>Traded notional</dt>
          <dd>{formatUsd(activity?.notionalUsd.total, true)}</dd>
        </div>
      </dl>
      <div className="observed-sides">
        <div>
          <span className="positive">Long</span>
          <strong>
            {activity
              ? `${activity.counts.long.toLocaleString()} executions`
              : "—"}
          </strong>
          <small>{formatUsd(activity?.notionalUsd.long, true)} notional</small>
        </div>
        <div>
          <span className="negative">Short</span>
          <strong>
            {activity
              ? `${activity.counts.short.toLocaleString()} executions`
              : "—"}
          </strong>
          <small>{formatUsd(activity?.notionalUsd.short, true)} notional</small>
        </div>
      </div>
      <p className="analytics-footnote">
        Partial public observations · opens, closes and liquidations. Possible
        duplicate observations.
      </p>
      <p className="analytics-footnote">
        {receivedAt
          ? `Activity snapshot ${relativeTime(receivedAt)}.`
          : "Activity snapshot pending."}
        {activity && !activity.coverage.projectionBackfillComplete
          ? " Retained activity is still being indexed."
          : ""}
        {activity?.coverage.observedFrom
          ? ` Records available since ${new Date(activity.coverage.observedFrom).toLocaleString()}.`
          : ""}
      </p>
    </section>
  );
}

function AssetDetail({
  asset,
  activityReceivedAt,
  onWallet,
}: {
  asset: AssetSummary;
  activityReceivedAt: number | null;
  onWallet: (address: string) => void;
}) {
  const oi = asset.openInterest;
  const noInterest = /^0+$/.test(oi.totalRaw);
  const validSplit =
    !noInterest &&
    oi.longSharePct !== null &&
    oi.shortSharePct !== null &&
    Number.isFinite(oi.longSharePct) &&
    Number.isFinite(oi.shortSharePct) &&
    oi.longSharePct >= 0 &&
    oi.shortSharePct >= 0 &&
    oi.longSharePct <= 100 &&
    oi.shortSharePct <= 100;
  return (
    <section aria-label={`${asset.symbol} analytics`}>
      <div className="asset-detail-heading">
        <h3>{asset.symbol} open interest</h3>
        <span>Entry notional · USD</span>
      </div>
      <dl className="asset-metrics">
        <div className="asset-metric">
          <dt>Total open interest</dt>
          <dd>{formatRawUsd(oi.totalRaw, true)}</dd>
          <small>{formatRawUsd(oi.totalRaw)}</small>
        </div>
        <div className="asset-metric">
          <dt>Long open interest</dt>
          <dd className="positive">{formatRawUsd(oi.longRaw, true)}</dd>
          <small>{formatRawUsd(oi.longRaw)}</small>
        </div>
        <div className="asset-metric">
          <dt>Short open interest</dt>
          <dd className="negative">{formatRawUsd(oi.shortRaw, true)}</dd>
          <small>{formatRawUsd(oi.shortRaw)}</small>
        </div>
      </dl>
      <div className="interest-split">
        <div className="interest-split-labels">
          <span>
            Long <strong>{noInterest ? "—" : share(oi.longSharePct)}</strong>
          </span>
          <span>
            Short <strong>{noInterest ? "—" : share(oi.shortSharePct)}</strong>
          </span>
        </div>
        <div
          className="interest-bar"
          role="img"
          aria-label={
            noInterest
              ? "No open interest; long and short shares are undefined"
              : validSplit
                ? `${share(oi.longSharePct)} long, ${share(oi.shortSharePct)} short, by entry notional`
                : "Long and short shares unavailable"
          }
        >
          {validSplit && (
            <>
              <span
                className="interest-bar-long"
                style={{ width: `${oi.longSharePct}%` }}
              />
              <span
                className="interest-bar-short"
                style={{ width: `${oi.shortSharePct}%` }}
              />
            </>
          )}
        </div>
        <p className="analytics-footnote">
          {noInterest ? "No open interest. " : ""}Share of total entry notional:
          long + short. This is not a count of wallets or positions.
        </p>
      </div>
      <div className="asset-detail-grid">
        <section
          className="asset-chart-panel"
          aria-labelledby="oi-history-heading"
        >
          <h4 id="oi-history-heading" className="analytics-subheading">
            Open-interest history
          </h4>
          <InterestHistory history={asset.history} symbol={asset.symbol} />
        </section>
        <ObservedActivity
          activity={asset.activity}
          receivedAt={activityReceivedAt}
        />
      </div>
      <section className="asset-recent" aria-labelledby="asset-recent-heading">
        <div className="asset-recent-header">
          <h4 className="analytics-subheading" id="asset-recent-heading">
            Recent activity
          </h4>
          <span>All traders · retained observations · rolling 24h</span>
        </div>
        {asset.activity?.recent.length ? (
          <div className="table-scroll">
            <table className="wallet-table asset-recent-table">
              <thead>
                <tr>
                  <th>WALLET</th>
                  <th>EXECUTION</th>
                  <th className="numeric">NOTIONAL</th>
                  <th className="numeric">WHEN</th>
                </tr>
              </thead>
              <tbody>
                {asset.activity.recent.map((trade) => (
                  <tr key={trade.id}>
                    <td>
                      <AnalyticsWallet
                        address={trade.wallet}
                        onWallet={onWallet}
                      />
                    </td>
                    <td className="asset-trade-type">
                      {trade.kind === "liq"
                        ? "Liquidated"
                        : trade.kind === "close"
                          ? "Closed"
                          : "Opened"}{" "}
                      <span
                        className={
                          trade.side === "long" ? "positive" : "negative"
                        }
                      >
                        {trade.side}
                      </span>
                    </td>
                    <td className="numeric">{formatUsd(trade.notionalUsd)}</td>
                    <td className="asset-trade-time">
                      {relativeTime(trade.ts)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="analytics-empty">
            <strong>
              {asset.activity
                ? "No retained trades in this window"
                : "Activity snapshot unavailable"}
            </strong>
            <p>
              {asset.activity
                ? "Only trades captured by the collector appear here."
                : "Trade counts remain unknown until an activity snapshot is available."}
            </p>
          </div>
        )}
      </section>
    </section>
  );
}

export function AssetsView({
  instrument,
  connected,
  onSelect,
  onWallet,
}: {
  instrument: number;
  connected: boolean;
  onSelect: (instrument: number) => void;
  onWallet: (address: string) => void;
}) {
  const { data, error, loading, refresh } =
    useAnalytics<AssetsResponse>("/api/assets", { liveAsset: instrument });
  const selected = data?.assets.find(
    (asset) => asset.instrument === instrument,
  );
  const message = error || data?.error;
  return (
    <section
      className="analytics-view assets-view"
      aria-labelledby="assets-heading"
    >
      <div className="analytics-heading">
        <div>
          <span className="analytics-eyebrow">BTC & ETH</span>
          <h2 id="assets-heading">Assets</h2>
        </div>
        <AnalyticsStatus
          receivedAt={data?.receivedAt}
          stale={data?.freshness?.delayed ?? data?.stale ?? false}
          error={message}
          loading={loading}
          onRefresh={refresh}
        />
      </div>
      <p className="analytics-description">
        Follow the price, spot meaningful entries, and see how traders are positioned.
      </p>
      <AnalyticsNotice error={message} hasData={Boolean(data?.assets.length)} />
      {data?.freshness?.historyGap && (
        <p className="analytics-footnote" role="status">
          Historical trade coverage has a known gap; some earlier executions may be missing.
        </p>
      )}
      <div className="asset-selectors" aria-label="Select an asset">
        {[
          { instrument: 0, symbol: "BTC", name: "Bitcoin", mark: "₿" },
          { instrument: 1, symbol: "ETH", name: "Ethereum", mark: "Ξ" },
        ].map((market) => {
          const asset = data?.assets.find(
            (item) => item.instrument === market.instrument,
          );
          return (
            <button
              key={market.instrument}
              className="asset-selector"
              aria-pressed={instrument === market.instrument}
              aria-label={`${market.symbol} ${market.name}`}
              onClick={() => onSelect(market.instrument)}
            >
              <span
                className={`asset-symbol ${market.instrument === 1 ? "eth" : ""}`}
                aria-hidden="true"
              >
                {market.mark}
              </span>
              <span className="asset-selector-copy">
                <strong>{market.symbol}</strong>
                <small>{market.name}</small>
              </span>
              <span className="asset-selector-value">
                {formatRawUsd(asset?.openInterest.totalRaw, true)}
              </span>
            </button>
          );
        })}
      </div>
      <AssetLivePanel
        instrument={instrument}
        connected={connected}
        onWallet={onWallet}
      />
      {selected ? (
        <AssetDetail
          asset={selected}
          activityReceivedAt={data?.activityReceivedAt ?? null}
          onWallet={onWallet}
        />
      ) : (
        <div className="analytics-empty" aria-busy={loading}>
          <strong>
            {loading ? "Loading asset snapshot" : "Asset snapshot unavailable"}
          </strong>
          <p>
            Open-interest amounts remain unknown until a source snapshot is
            available.
          </p>
        </div>
      )}
    </section>
  );
}
