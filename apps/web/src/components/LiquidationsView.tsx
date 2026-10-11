import { useEffect, useState } from "react";
import type { LiquidationsResponse } from "../../../../packages/shared/src/types";
import { useAnalytics } from "../lib/use-analytics";
import { formatUsd, shortAddress, relativeTime } from "../lib/format";
import { Avatar } from "./Avatar";
import { LiquidationChart } from "./LiquidationChart";
import "./protocol-stats.css";

type Summary = Omit<LiquidationsResponse, "items" | "nextCursor" | "hourly">;
export function LiquidationSummary({ onOpen }: { onOpen: () => void }) {
  const { data, error } = useAnalytics<Summary>("/api/liquidations/stats", {
    liveLiquidations: true,
  });
  return (
    <button
      className="liquidation-summary"
      onClick={onOpen}
      aria-label="View liquidations"
    >
      <span>Liquidations · 24h</span>
      <strong>
        {data?.receivedAt ? data.stats.day.count.toLocaleString() : "—"}
      </strong>
      <span>
        {formatUsd(data?.receivedAt ? data.stats.day.notionalUsd : null, true)}{" "}
        notional
        {data?.stale || error ? " · last available" : " · observed"}
      </span>
      <span aria-hidden="true">↗</span>
    </button>
  );
}

export function LiquidationsView({
  onWallet,
  connected,
}: {
  onWallet: (address: string) => void;
  connected: boolean;
}) {
  const [instrument, setInstrument] = useState(() => {
    const requested = new URLSearchParams(window.location.search).get(
      "instrument",
    );
    return requested === "0" || requested === "1" ? requested : "all";
  });
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [page, setPage] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const params = new URLSearchParams();
  if (instrument !== "all") params.set("instrument", instrument);
  if (cursors[page]) params.set("cursor", cursors[page]!);
  const path = `/api/liquidations${params.size ? `?${params}` : ""}`;
  const { data, error, loading, refresh } = useAnalytics<LiquidationsResponse>(
    path,
    {
      liveLiquidations: page === 0,
      instrument: instrument === "all" ? undefined : Number(instrument),
    },
  );
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);
  const stale = Boolean(
    error ||
      data?.stale ||
      (data?.receivedAt && clock - data.receivedAt > 30000),
  );
  const totals = data?.receivedAt ? data.stats.day : undefined;
  const hour = data?.receivedAt ? data.stats.hour : undefined;
  return (
    <section className="liquidations-view" aria-label="Liquidations">
      <div className="liquidations-heading">
        <div>
          <h2>Liquidations</h2>
          <p>Liquidated positions · rolling 24 hours</p>
        </div>
        <span className={`freshness ${!connected || stale ? "stale" : ""}`}>
          <i />
          {!data
            ? "Connecting"
            : stale
              ? "Last available"
              : !connected
                ? "Updating"
                : "Live observations"}
        </span>
      </div>
      <dl className="liquidation-metrics">
        <div>
          <dt>Liquidated notional · 24h</dt>
          <dd title={formatUsd(totals?.notionalUsd)}>
            {formatUsd(totals?.notionalUsd, true)}
          </dd>
        </div>
        <div>
          <dt>
            Liquidated margin · 24h{" "}
            <span
              className="liquidation-estimate"
              title="Initial margin estimated from notional ÷ entry leverage."
            >
              Est.
            </span>
          </dt>
          <dd title={formatUsd(totals?.estimatedMarginUsd)}>
            {formatUsd(totals?.estimatedMarginUsd, true)}
          </dd>
        </div>
        <div>
          <dt>Liquidations · 24h</dt>
          <dd>{totals?.count.toLocaleString() ?? "—"}</dd>
        </div>
        <div>
          <dt>Long / short · 24h</dt>
          <dd>
            <span className="positive">
              {totals?.longCount.toLocaleString() ?? "—"}
            </span>
            <span className="muted"> / </span>
            <span className="negative">
              {totals?.shortCount.toLocaleString() ?? "—"}
            </span>
          </dd>
        </div>
        <div>
          <dt>Liquidated notional · 1h</dt>
          <dd title={formatUsd(hour?.notionalUsd)}>
            {formatUsd(hour?.notionalUsd, true)}
          </dd>
        </div>
      </dl>
      <LiquidationChart
        data={data}
        instrument={instrument}
        stale={stale}
        loading={loading}
      />
      <div className="liquidation-toolbar">
        <div className="feed-filters">
          {[
            ["all", "All markets"],
            ["0", "BTC"],
            ["1", "ETH"],
          ].map(([value, label]) => (
            <button
              key={value}
              aria-pressed={instrument === value}
              onClick={() => {
                setInstrument(value);
                setPage(0);
                setCursors([null]);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          className="text-button"
          onClick={() => {
            setPage(0);
            setCursors([null]);
            refresh();
          }}
          disabled={loading}
        >
          {page > 0 ? "Back to latest" : "Refresh"}
        </button>
      </div>
      {error && (
        <p className="inline-notice" role="status">
          {data ? "Showing retained observations. " : ""}
          {error}
        </p>
      )}
      <div className="table-scroll" aria-busy={loading}>
        <table className="liquidation-table">
          <thead>
            <tr>
              <th>WALLET</th>
              <th>ASSET / SIDE</th>
              <th className="numeric">NOTIONAL</th>
              <th className="numeric">LEVERAGE</th>
              <th className="numeric">EXECUTION PRICE</th>
              <th className="numeric">TIME</th>
            </tr>
          </thead>
          <tbody>
            {(data?.items ?? []).map((trade) => (
              <tr key={trade.id}>
                <td>
                  <button
                    className="liquidation-wallet"
                    onClick={() => onWallet(trade.wallet)}
                  >
                    <Avatar address={trade.wallet} />
                    {shortAddress(trade.wallet)}
                  </button>
                </td>
                <td>
                  {trade.instrument === 0
                    ? "BTC"
                    : trade.instrument === 1
                      ? "ETH"
                      : `Asset ${trade.instrument}`}{" "}
                  <span
                    className={trade.side === "long" ? "positive" : "negative"}
                  >
                    {trade.side}
                  </span>
                </td>
                <td className="numeric" title={formatUsd(trade.notionalUsd)}>
                  {formatUsd(trade.notionalUsd, true)}
                </td>
                <td className="numeric">{trade.leverage.toLocaleString()}×</td>
                <td className="numeric">{formatUsd(trade.priceUsd)}</td>
                <td className="numeric">
                  <time
                    dateTime={new Date(trade.ts).toISOString()}
                    title={new Date(trade.ts).toLocaleString()}
                  >
                    {relativeTime(trade.ts)}
                  </time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!data?.items.length && (
        <div className="table-empty">
          <h3>
            {!data?.receivedAt
              ? "Waiting for liquidation data"
              : "No liquidations observed"}
          </h3>
          <p>
            {loading
              ? "Loading retained activity."
              : "New liquidations will appear here as they are observed."}
          </p>
        </div>
      )}
      <div className="table-footer">
        <span>
          {data?.coverage.projectionBackfillComplete === false
            ? "Syncing retained history"
            : "Retained observations"}
          {page === 0 ? " · latest 50" : ""}
        </span>
        <div className="pagination">
          <button
            aria-label="Previous liquidation page"
            disabled={page === 0 || loading}
            onClick={() => setPage((p) => p - 1)}
          >
            ←
          </button>
          <span>{page + 1}</span>
          <button
            aria-label="Next liquidation page"
            disabled={!data?.nextCursor || loading}
            onClick={() => {
              if (!data?.nextCursor) return;
              setCursors((old) => [...old.slice(0, page + 1), data.nextCursor]);
              setPage((p) => p + 1);
            }}
          >
            →
          </button>
        </div>
      </div>
      <p className="protocol-method">
        Observed activity; coverage may be incomplete. Notional is position
        size, not lost collateral. Initial margin estimated from notional ÷
        entry leverage. Totals through{" "}
        {data ? new Date(data.windowTo).toLocaleTimeString() : "—"}.
      </p>
    </section>
  );
}
