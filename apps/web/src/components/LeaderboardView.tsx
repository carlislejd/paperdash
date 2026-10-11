import { useState } from "react";
import type { LeaderboardResponse } from "../../../../packages/shared/src/types";
import {
  formatRawToken,
  formatRawUsd,
  formatUsd,
  rawToNumber,
} from "../lib/format";
import { useAnalytics } from "../lib/use-analytics";
import {
  AnalyticsNotice,
  AnalyticsStatus,
  AnalyticsWallet,
} from "./AnalyticsShared";

function TradedAssets({ instruments }: { instruments?: number[] | null }) {
  if (instruments == null)
    return (
      <span className="muted" title="Observed assets unavailable">
        —
      </span>
    );
  if (!instruments.length)
    return <span className="muted leaderboard-no-assets">None observed</span>;
  return (
    <div
      className="leaderboard-assets"
      aria-label="Assets traded in the past 24 hours"
    >
      {[...new Set(instruments)]
        .sort((a, b) => a - b)
        .map((instrument) => {
          const symbol =
            instrument === 0
              ? "BTC"
              : instrument === 1
                ? "ETH"
                : `Asset ${instrument}`;
          return (
            <span
              className="leaderboard-asset"
              key={instrument}
              title={`${symbol} · observed trades in the past 24 hours`}
            >
              <span
                className={`leaderboard-asset-mark ${instrument === 1 ? "eth" : ""}`}
                aria-hidden="true"
              >
                {instrument === 0 ? (
                  "₿"
                ) : instrument === 1 ? (
                  <svg
                    width="12"
                    height="19"
                    viewBox="0 0 24 38"
                    fill="currentColor"
                  >
                    <path d="M12 0 0 20l12 7 12-7L12 0Z" opacity=".85" />
                    <path d="M0 23 12 38 24 23l-12 7L0 23Z" />
                    <path d="M12 0v27l12-7L12 0Z" opacity=".4" />
                  </svg>
                ) : (
                  "·"
                )}
              </span>
              {symbol}
            </span>
          );
        })}
    </div>
  );
}

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
    ...(["pnl", "paper", "volume", "trades"] as const).filter(
      (value) => value !== metric,
    ),
  ];
  const columnLabels = {
    pnl: "24H PNL",
    paper: "PAPER OWNED",
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
          <span className="analytics-eyebrow">
            {metric === "paper" ? "Current holdings" : "Rolling 24 hours"}
          </span>
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
            aria-pressed={metric === "paper"}
            onClick={() => {
              setMetric("paper");
              setPage(0);
            }}
          >
            PAPER
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
            : metric === "paper"
              ? "Staked + unstaked PAPER · ranked by current holdings in tracked accounts."
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
      {metric === "paper" && (
        <dl
          className="leaderboard-paper-summary"
          aria-label="Tracked PAPER ownership"
        >
          <div>
            <dt>Tracked PAPER</dt>
            <dd
              title={`${formatRawToken(data?.paperOwnership?.trackedTotalRaw)} PAPER`}
            >
              {formatRawToken(data?.paperOwnership?.trackedTotalRaw, true)}
            </dd>
          </div>
          <div>
            <dt>This page</dt>
            <dd
              title={`${formatRawToken(data?.paperOwnership?.pageTotalRaw)} PAPER`}
            >
              {formatRawToken(data?.paperOwnership?.pageTotalRaw, true)}
            </dd>
          </div>
          <div>
            <dt>% of tracked PAPER</dt>
            <dd>
              {data?.paperOwnership?.pageShareBps != null &&
              Number.isSafeInteger(data.paperOwnership.pageShareBps) &&
              data.paperOwnership.pageShareBps >= 0 &&
              data.paperOwnership.pageShareBps <= 10000
                ? `${(data.paperOwnership.pageShareBps / 100).toFixed(2)}%`
                : "—"}
            </dd>
          </div>
        </dl>
      )}
      <p className="analytics-coverage-note">
        Partial activity coverage · trade counts, volume and assets cover
        observed opens, closes and liquidations in the past 24 hours. PAPER
        ownership and current uPnL are separate account snapshots.
        {data?.activityCoverage?.stale ? " Activity data is delayed." : ""}
        {data?.accountStale && data.accountReceivedAt != null
          ? " Account valuations are delayed."
          : ""}
      </p>
      <AnalyticsNotice error={message} hasData={Boolean(data)} />
      <div
        className={`table-scroll ${loading ? "table-loading" : ""}`}
        aria-busy={loading}
      >
        <table className="wallet-table leaderboard-table">
          <caption className="sr-only">
            {metric === "paper"
              ? "Current PAPER ownership with 24-hour wallet activity"
              : "Rolling 24-hour public wallet leaderboard with current PAPER ownership"}
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
                  title={
                    column === "paper"
                      ? "Current staked + unstaked PAPER; not a 24-hour change"
                      : undefined
                  }
                >
                  {columnLabels[column]}
                </th>
              ))}
              <th
                className="numeric"
                title="Current unrealized PnL on open positions; not a 24-hour change"
              >
                CURRENT UPNL
              </th>
              <th>ASSETS · 24H</th>
            </tr>
          </thead>
          <tbody>
            {loading && !data
              ? Array.from({ length: 5 }, (_, i) => (
                  <tr key={i} className="skeleton-row">
                    <td colSpan={2}>
                      <span className="skeleton-line" />
                    </td>
                    <td colSpan={6}>
                      <span className="skeleton-line short" />
                    </td>
                  </tr>
                ))
              : data?.rows.map((row) => {
                  const pnl = rawToNumber(row.pnlRaw);
                  const upnl = rawToNumber(row.currentUnrealizedPnlRaw);
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
                          className={`numeric leaderboard-value-${column} ${column === "pnl" ? (pnl !== null && pnl > 0 ? "positive" : pnl !== null && pnl < 0 ? "negative" : "muted") : column === metric ? "table-balance" : "muted"}`}
                          title={
                            column === "paper"
                              ? row.paperTotalRaw == null
                                ? "Current PAPER ownership unavailable for this ranking"
                                : `${formatRawToken(row.paperTotalRaw)} PAPER · staked + unstaked${data.accountStale ? " · last available" : ""}`
                              : undefined
                          }
                        >
                          {column === "pnl" ? (
                            <>
                              {pnl !== null && pnl > 0 ? "+" : ""}
                              {formatRawUsd(row.pnlRaw)}
                            </>
                          ) : column === "paper" ? (
                            formatRawToken(row.paperTotalRaw, true)
                          ) : column === "volume" ? (
                            formatUsd(row.volumeUsd)
                          ) : (
                            (row.tradeCount?.toLocaleString() ?? "—")
                          )}
                        </td>
                      ))}
                      <td
                        className={`numeric leaderboard-upnl ${upnl === null || upnl === 0 ? "muted" : upnl > 0 ? "positive" : "negative"}`}
                        title={
                          upnl === null
                            ? "Current account valuation unavailable for this ranking"
                            : `${data.accountStale ? "Last available" : "Current"} unrealized PnL${data.accountReceivedAt ? ` · ${new Date(data.accountReceivedAt).toLocaleString()}` : ""}`
                        }
                      >
                        {upnl !== null && upnl > 0 ? "+" : ""}
                        {formatRawUsd(row.currentUnrealizedPnlRaw)}
                      </td>
                      <td>
                        <TradedAssets instruments={row.assetsTraded} />
                      </td>
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
              : "No public wallet results were returned for this ranking."}
          </p>
        </div>
      )}
      <div className="table-footer analytics-table-footer">
        <span>
          {data?.count.toLocaleString() ?? "—"} ranked wallets ·{" "}
          {metric === "pnl" || metric === "paper"
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
