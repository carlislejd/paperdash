import { useState } from "react";
import type { LeaderboardResponse } from "../../../../packages/shared/src/types";
import {
  formatRawToken,
  formatRawUsd,
  formatUsd,
  rawToNumber,
} from "../lib/format";
import { useAnalytics } from "../lib/use-analytics";
import { ParagonEstimate, ParagonToggle } from "./ParagonValuation";
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
  const [paperWindow, setPaperWindow] = useState<"all" | "24h">("all");
  const [page, setPage] = useState(0);
  const { data, error, loading, refresh } = useAnalytics<LeaderboardResponse>(
    `/api/leaderboard?metric=${metric}&page=${page}${metric === "paper" ? `&window=${paperWindow}` : ""}`,
  );
  // Older servers return 24h activity even for PAPER. Never relabel that data.
  const lifetime = metric === "paper" && data?.statsWindow === "all";
  const lifetimeUnavailable =
    metric === "paper" && paperWindow === "all" && data && !lifetime;
  const message = error || data?.error;
  const holdingsDelayed = Boolean(message || data?.accountStale);
  const columns = [
    metric,
    ...(["pnl", "paper", "volume", "trades"] as const).filter(
      (value) => value !== metric,
    ),
  ];
  const columnLabels = {
    pnl: lifetime ? "Realized P&L · lifetime" : "24H PNL",
    paper: "PAPER OWNED",
    volume: lifetime ? "Volume · lifetime" : "OBS. VOLUME",
    trades: lifetime ? "Recorded closes" : "OBS. TRADES",
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
      <div className="leaderboard-valuation-controls">
        <ParagonToggle />
      </div>
      {metric === "paper" && (
        <div
          className="leaderboard-window-controls"
          role="group"
          aria-label="PAPER leaderboard activity period"
        >
          <span>Activity period</span>
          <div className="analytics-segments">
            <button
              aria-pressed={paperWindow === "all"}
              onClick={() => {
                setPaperWindow("all");
                setPage(0);
              }}
            >
              Lifetime
            </button>
            <button
              aria-pressed={paperWindow === "24h"}
              onClick={() => {
                setPaperWindow("24h");
                setPage(0);
              }}
            >
              24 hours
            </button>
          </div>
        </div>
      )}
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
              <ParagonEstimate
                paperRaw={data?.paperOwnership?.trackedTotalRaw}
                holdingsDelayed={holdingsDelayed}
                receivedAt={data?.accountReceivedAt ?? null}
                compact
              />
            </dd>
          </div>
          <div>
            <dt>This page</dt>
            <dd
              title={`${formatRawToken(data?.paperOwnership?.pageTotalRaw)} PAPER`}
            >
              {formatRawToken(data?.paperOwnership?.pageTotalRaw, true)}
              <ParagonEstimate
                paperRaw={data?.paperOwnership?.pageTotalRaw}
                holdingsDelayed={holdingsDelayed}
                receivedAt={data?.accountReceivedAt ?? null}
                compact
              />
            </dd>
          </div>
          <div>
            <dt
              title="PAPER held by the wallets shown as a share of PAPER across all tracked accounts. This does not measure history indexing progress."
            >
              This page’s share
            </dt>
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
        {lifetime
          ? "Realized P&L and traded volume are lifetime account totals. Recorded closes include closed and liquidated positions in retained history; they are not a count of all executions. Counts may be incomplete while history updates."
          : "Partial activity coverage · trade counts, volume and assets cover observed opens, closes and liquidations in the past 24 hours."}{" "}
        PAPER ownership and current uPnL are separate account snapshots.
        {lifetimeUnavailable
          ? " Lifetime details are unavailable in this snapshot; showing 24-hour activity."
          : ""}
        {!lifetime && data?.activityCoverage?.stale
          ? " Activity data is delayed."
          : ""}
        {data?.accountStale && data.accountReceivedAt != null
          ? " Account valuations are delayed."
          : ""}
      </p>
      <AnalyticsNotice error={message} hasData={Boolean(data)} />
      <div
        className={`table-scroll ${loading ? "table-loading" : ""}`}
        aria-busy={loading}
      >
        <table
          className={`wallet-table leaderboard-table ${lifetime ? "leaderboard-lifetime-table" : ""}`}
        >
          <caption className="sr-only">
            {metric === "paper"
              ? `Current PAPER ownership with ${lifetime ? "lifetime account totals and recorded closed positions" : "24-hour wallet activity"}`
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
              {!lifetime && <th>ASSETS · 24H</th>}
            </tr>
          </thead>
          <tbody>
            {loading && !data
              ? Array.from({ length: 25 }, (_, i) => (
                  <tr key={i} className="skeleton-row">
                    <td colSpan={2}>
                      <span className="skeleton-line" />
                    </td>
                    <td colSpan={lifetime ? 5 : 6}>
                      <span className="skeleton-line short" />
                    </td>
                  </tr>
                ))
              : data?.rows.map((row) => {
                  const pnl = rawToNumber(row.pnlRaw);
                  const upnl = rawToNumber(row.currentUnrealizedPnlRaw);
                  const history = row.historyCoverage;
                  const historyState = lifetime
                    ? !history ||
                      history.indexedAt == null ||
                      history.projectionPending
                      ? "Updating"
                      : !history.backfillComplete
                        ? `Partial history${history.stale ? " · delayed" : ""}`
                        : history.stale
                          ? "Last available"
                          : null
                    : null;
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
                              : lifetime &&
                                  column === "volume" &&
                                  row.volumeRaw != null
                                ? `${formatRawToken(row.volumeRaw)} USDC · lifetime traded volume`
                                : lifetime && column === "trades"
                                  ? `Retained closed and liquidated positions${history?.indexedAt && Number.isFinite(new Date(history.indexedAt).getTime()) ? ` · indexed ${new Date(history.indexedAt).toLocaleString()}` : ""}${history?.excludedCount ? ` · ${history.excludedCount.toLocaleString()} excluded from hold/leverage averages` : ""}`
                                  : undefined
                          }
                        >
                          {column === "pnl" ? (
                            <>
                              {pnl !== null && pnl > 0 ? "+" : ""}
                              {formatRawUsd(row.pnlRaw)}
                            </>
                          ) : column === "paper" ? (
                            <>
                              {formatRawToken(row.paperTotalRaw, true)}
                              <ParagonEstimate
                                paperRaw={row.paperTotalRaw}
                                holdingsDelayed={holdingsDelayed}
                                receivedAt={data.accountReceivedAt ?? null}
                                compact
                              />
                            </>
                          ) : column === "volume" ? (
                            lifetime ? (
                              formatRawUsd(row.volumeRaw)
                            ) : (
                              formatUsd(row.volumeUsd)
                            )
                          ) : (
                            <>
                              {row.tradeCount?.toLocaleString() ?? "—"}
                              {historyState && (
                                <small className="leaderboard-history-state">
                                  {historyState}
                                </small>
                              )}
                            </>
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
                      {!lifetime && (
                        <td>
                          <TradedAssets instruments={row.assetsTraded} />
                        </td>
                      )}
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
