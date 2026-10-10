import { useState } from "react";
import type { LeaderboardResponse } from "../../../../packages/shared/src/types";
import { formatRawUsd, formatUsd, rawToNumber } from "../lib/format";
import { useAnalytics } from "../lib/use-analytics";
import {
  AnalyticsNotice,
  AnalyticsStatus,
  AnalyticsWallet,
} from "./AnalyticsShared";

export function LeaderboardView({
  onWallet,
}: {
  onWallet: (address: string) => void;
}) {
  const [metric, setMetric] = useState<LeaderboardResponse["metric"]>("pnl");
  const [page, setPage] = useState(0);
  const { data, error, loading, refresh } = useAnalytics<LeaderboardResponse>(
    `/api/leaderboard?metric=${metric}&page=${page}`,
  );
  const message = error || data?.error;
  const columns = [
    metric,
    ...(["pnl", "volume", "trades"] as const).filter(
      (value) => value !== metric,
    ),
  ];
  const columnLabels = {
    pnl: "24H PNL",
    volume: "OBS. VOLUME",
    trades: "OBS. TRADES",
  };
  return (
    <section
      className="analytics-view leaderboard-view"
      aria-labelledby="leaderboard-heading"
    >
      <div className="analytics-heading">
        <div>
          <span className="analytics-eyebrow">Rolling 24 hours</span>
          <h2 id="leaderboard-heading">Leaderboard</h2>
        </div>
        <div className="analytics-segments" aria-label="Leaderboard ranking">
          <button
            aria-pressed={metric === "pnl"}
            onClick={() => {
              setMetric("pnl");
              setPage(0);
            }}
          >
            24h PnL
          </button>
          <button
            aria-pressed={metric === "volume"}
            onClick={() => {
              setMetric("volume");
              setPage(0);
            }}
          >
            Observed volume
          </button>
          <button
            aria-pressed={metric === "trades"}
            onClick={() => {
              setMetric("trades");
              setPage(0);
            }}
          >
            Observed trades
          </button>
        </div>
      </div>
      <div className="analytics-meta-row">
        <p className="analytics-description">
          {metric === "pnl"
            ? "Protocol-reported PnL over the past 24 hours."
            : `Ranked by observed ${metric === "volume" ? "traded notional" : "executions"} over the past 24 hours.`}
        </p>
        <AnalyticsStatus
          receivedAt={data?.receivedAt}
          stale={data?.stale ?? false}
          error={message}
          loading={loading}
          onRefresh={refresh}
        />
      </div>
      {metric !== "pnl" && (
        <p className="analytics-coverage-note">
          Partial activity coverage · opens, closes and liquidations · possible
          duplicate observations.
          {data?.coverage.observedFrom
            ? ` Records available since ${new Date(data.coverage.observedFrom).toLocaleString()}.`
            : ""}
          {data && !data.coverage.projectionBackfillComplete
            ? " Retained activity is still being indexed."
            : ""}
        </p>
      )}
      <AnalyticsNotice error={message} hasData={Boolean(data)} />
      <div
        className={`table-scroll ${loading ? "table-loading" : ""}`}
        aria-busy={loading}
      >
        <table className="wallet-table leaderboard-table">
          <caption className="sr-only">
            Rolling 24-hour public wallet leaderboard
          </caption>
          <thead>
            <tr>
              <th className="rank-cell">RANK</th>
              <th>WALLET</th>
              {columns.map((column) => (
                <th
                  key={column}
                  className="numeric"
                  aria-sort={metric === column ? "descending" : undefined}
                >
                  {columnLabels[column]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && !data
              ? Array.from({ length: 5 }, (_, i) => (
                  <tr key={i} className="skeleton-row">
                    <td colSpan={2}>
                      <span className="skeleton-line" />
                    </td>
                    <td colSpan={3}>
                      <span className="skeleton-line short" />
                    </td>
                  </tr>
                ))
              : data?.rows.map((row) => {
                  const pnl = rawToNumber(row.pnlRaw);
                  return (
                    <tr key={row.address}>
                      <td className="rank-cell">
                        {String(row.rank).padStart(2, "0")}
                      </td>
                      <td>
                        <AnalyticsWallet
                          address={row.address}
                          name={row.leaderboardName}
                          onWallet={onWallet}
                        />
                      </td>
                      {columns.map((column) => (
                        <td
                          key={column}
                          className={`numeric ${column === "pnl" ? (pnl !== null && pnl > 0 ? "positive" : pnl !== null && pnl < 0 ? "negative" : "muted") : column === metric ? "table-balance" : "muted"}`}
                        >
                          {column === "pnl" ? (
                            <>
                              {pnl !== null && pnl > 0 ? "+" : ""}
                              {formatRawUsd(row.pnlRaw)}
                            </>
                          ) : column === "volume" ? (
                            formatUsd(row.volumeUsd)
                          ) : (
                            (row.tradeCount?.toLocaleString() ?? "—")
                          )}
                        </td>
                      ))}
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>
      {!loading && !data?.rows.length && (
        <div className="table-empty">
          <h3>
            {message && !data ? "Leaderboard unavailable" : "No ranked wallets"}
          </h3>
          <p>
            {message && !data
              ? "Try refreshing this snapshot."
              : "No public wallet results were returned for this window."}
          </p>
        </div>
      )}
      <div className="table-footer analytics-table-footer">
        <span>
          {data?.count.toLocaleString() ?? "—"} ranked wallets ·{" "}
          {metric === "pnl"
            ? "protocol-reported"
            : "retained public observations"}
        </span>
        <div className="pagination">
          <button
            aria-label="Previous leaderboard page"
            disabled={page === 0 || loading}
            onClick={() => setPage((value) => value - 1)}
          >
            ←
          </button>
          <span>
            {page + 1}{" "}
            <span className="muted">/ {data?.pageInfo.totalPages ?? "—"}</span>
          </span>
          <button
            aria-label="Next leaderboard page"
            disabled={!data || page + 1 >= data.pageInfo.totalPages || loading}
            onClick={() => setPage((value) => value + 1)}
          >
            →
          </button>
        </div>
      </div>
    </section>
  );
}
