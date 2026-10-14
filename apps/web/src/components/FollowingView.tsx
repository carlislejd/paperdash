import { useEffect, useState } from "react";
import type { FollowedWallet } from "../lib/following-storage";
import { useFollowingData } from "../lib/use-following-data";
import {
  formatRawUsd,
  formatUsd,
  rawToNumber,
  relativeTime,
  shortAddress,
} from "../lib/format";
import { Avatar } from "./Avatar";
import "./following.css";

export function FollowingView({
  following,
  query,
  onUnfollow,
  onWallet,
  onBrowse,
  onClearSearch,
}: {
  following: readonly FollowedWallet[];
  query: string;
  onUnfollow: (address: string) => void;
  onWallet: (address: string) => void;
  onBrowse: () => void;
  onClearSearch: () => void;
}) {
  const search = query.trim().toLowerCase();
  const [paging, setPaging] = useState({ search, page: 0 });
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);
  const matching = following.filter((item) =>
    `${item.address} ${item.nameHint ?? ""}`.toLowerCase().includes(search),
  );
  const pages = Math.max(1, Math.ceil(matching.length / 10));
  const page = Math.min(paging.search === search ? paging.page : 0, pages - 1);
  const visible = matching.slice(page * 10, page * 10 + 10);
  const { data, error, loading, refresh } = useFollowingData(
    visible.map((item) => item.address),
  );
  const rows = new Map(
    data?.rows.map((row) => [row.address.toLowerCase(), row]) ?? [],
  );
  const identities = new Map(visible.map((item) => [item.address, item]));
  const activity = data?.activity;
  const activityOld = Boolean(
    error ||
      data?.error ||
      activity?.stale ||
      (activity?.receivedAt && clock - activity.receivedAt > 30000),
  );
  const trades = (activity?.items ?? [])
    .filter((trade) => identities.has(trade.wallet.toLowerCase()))
    .slice(0, 50);

  return (
    <section
      className="following-view community-section"
      aria-labelledby="following-heading"
    >
      <div className="community-heading">
        <div>
          <h2 id="following-heading">
            Following <span className="heading-count">{following.length}</span>
          </h2>
          <p>Saved on this browser · up to 100 wallets</p>
        </div>
        {following.length > 0 && (
          <button
            className="text-button"
            onClick={refresh}
            disabled={loading || !visible.length}
          >
            Refresh
          </button>
        )}
      </div>
      {query && (
        <div className="search-summary">
          <span>
            Results for <strong>{query}</strong>
          </span>
          <button className="text-button" onClick={onClearSearch}>
            Clear
          </button>
        </div>
      )}
      {!following.length ? (
        <div className="table-empty">
          <h3>No followed wallets</h3>
          <p>Tap the star beside a wallet to keep it here.</p>
          <button className="outline-button" onClick={onBrowse}>
            Browse wallets →
          </button>
        </div>
      ) : !matching.length ? (
        <div className="table-empty">
          <h3>No matching followed wallets</h3>
          <p>Search a saved name or address.</p>
          <button className="outline-button" onClick={onClearSearch}>
            Clear search
          </button>
        </div>
      ) : (
        <>
          {(error || data?.error) && (
            <p className="inline-notice" role="status">
              {data ? "Showing last available observations. " : ""}
              {error || data?.error}
            </p>
          )}
          <p className="following-update-note">
            Balances and activity update independently. Observation times are
            shown below.
          </p>
          <div className="table-scroll" aria-busy={loading}>
            <table className="following-table">
              <thead>
                <tr>
                  <th>WALLET</th>
                  <th className="numeric">BALANCE</th>
                  <th className="numeric">OPEN PNL</th>
                  <th className="numeric">OPEN POSITIONS</th>
                  <th>OBSERVED</th>
                  <th>
                    <span className="sr-only">Unfollow wallet</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((identity) => {
                  const row = rows.get(identity.address);
                  const account = row?.account;
                  const name =
                    account?.leaderboardName ||
                    identity.nameHint ||
                    shortAddress(identity.address);
                  const old = Boolean(
                    error ||
                      data?.error ||
                      row?.stale ||
                      !row?.receivedAt ||
                      clock - row.receivedAt > 60000 ||
                      row.receivedAt > clock + 30000,
                  );
                  const pnl = rawToNumber(account?.currentUnrealizedPnl);
                  return (
                    <tr key={identity.address}>
                      <td>
                        <button
                          className="wallet-identity"
                          onClick={() => onWallet(identity.address)}
                        >
                          <Avatar address={identity.address} />
                          <span>
                            <strong>{name}</strong>
                            <span>
                              {name === shortAddress(identity.address)
                                ? "Papertrade wallet"
                                : shortAddress(identity.address)}
                            </span>
                            <span className="following-wallet-status">
                              {!account
                                ? "Awaiting snapshot"
                                : `${old ? "Last available" : "Observed"}${row?.receivedAt ? ` · ${relativeTime(row.receivedAt)}` : ""}`}
                            </span>
                          </span>
                        </button>
                      </td>
                      <td className="numeric following-balance">
                        {formatRawUsd(account?.currentBalance)}
                      </td>
                      <td
                        className={`numeric ${pnl != null && pnl > 0 ? "positive" : pnl != null && pnl < 0 ? "negative" : "muted"}`}
                      >
                        {pnl != null && pnl > 0 ? "+" : ""}
                        {formatRawUsd(account?.currentUnrealizedPnl)}
                      </td>
                      <td className="numeric">
                        {account &&
                        account.currentOpenPositionCount != null &&
                        Number.isSafeInteger(account.currentOpenPositionCount)
                          ? account.currentOpenPositionCount.toLocaleString()
                          : "—"}
                      </td>
                      <td className="following-observed">
                        <span className={old ? "muted" : ""}>
                          {!account
                            ? "Awaiting snapshot"
                            : old
                              ? "Last available"
                              : "Observed"}
                        </span>
                        {row?.receivedAt && account ? (
                          <time
                            dateTime={new Date(row.receivedAt).toISOString()}
                            title={new Date(row.receivedAt).toLocaleString()}
                          >
                            {relativeTime(row.receivedAt)}
                          </time>
                        ) : null}
                        {row?.refreshQueued && (old || !account) && (
                          <small>Refresh queued</small>
                        )}
                      </td>
                      <td>
                        <button
                          className="star-button saved"
                          aria-label={`Unfollow ${name}`}
                          aria-pressed="true"
                          onClick={() => onUnfollow(identity.address)}
                        >
                          ★
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="table-footer">
            <span>
              Wallets {page * 10 + 1}–{page * 10 + visible.length} of{" "}
              {matching.length}
            </span>
            <div className="pagination">
              <button
                aria-label="Previous following page"
                disabled={page === 0}
                onClick={() => setPaging({ search, page: page - 1 })}
              >
                ←
              </button>
              <span>
                {page + 1} / {pages}
              </span>
              <button
                aria-label="Next following page"
                disabled={page + 1 >= pages}
                onClick={() => setPaging({ search, page: page + 1 })}
              >
                →
              </button>
            </div>
          </div>
          <section
            className="following-activity"
            aria-label="Followed wallet activity"
          >
            <div className="following-activity-heading">
              <div>
                <h3>Recent activity</h3>
                <p>
                  Wallets on this page · observed executions in the past 24
                  hours
                </p>
              </div>
              <span
                className={`freshness ${activityOld || !activity ? "stale" : ""}`}
              >
                <i />
                {!activity
                  ? "Waiting for activity"
                  : activityOld
                    ? "Last available"
                    : "Updating"}
              </span>
            </div>
            {trades.length ? (
              <div className="following-trades">
                {trades.map((trade) => (
                  <button
                    key={trade.id}
                    className="trade-row"
                    onClick={() => onWallet(trade.wallet)}
                  >
                    <Avatar address={trade.wallet} />
                    <span className="trade-description">
                      <strong>
                        {rows.get(trade.wallet.toLowerCase())?.account
                          ?.leaderboardName ||
                          identities.get(trade.wallet.toLowerCase())
                            ?.nameHint ||
                          shortAddress(trade.wallet)}
                      </strong>
                      <span>
                        {trade.kind === "liq"
                          ? "Liquidated"
                          : trade.kind === "close"
                            ? "Closed"
                            : "Opened"}{" "}
                        {trade.instrument === 0
                          ? "BTC"
                          : trade.instrument === 1
                            ? "ETH"
                            : `Asset ${trade.instrument}`}{" "}
                        <span
                          className={
                            trade.side === "long" ? "positive" : "negative"
                          }
                        >
                          {trade.side}
                        </span>{" "}
                        · {trade.leverage.toLocaleString()}×
                      </span>
                    </span>
                    <span className="trade-amount">
                      {formatUsd(trade.notionalUsd, true)}
                      <small>{relativeTime(trade.ts)}</small>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="following-empty">
                <h4>
                  {!activity
                    ? "Waiting for retained activity"
                    : "No recent activity observed"}
                </h4>
                <p>
                  Opens, closes and liquidations for these wallets appear here
                  when retained.
                </p>
              </div>
            )}
            <p className="panel-footnote">
              {activity?.coverage.truncated
                ? "Latest 50 retained observations"
                : "Retained observations"}{" "}
              · coverage may be incomplete
              {activity?.coverage.projectionBackfillComplete === false
                ? " · syncing history"
                : ""}
              {activity
                ? ` · through ${new Date(activity.windowTo).toLocaleTimeString()}`
                : ""}
            </p>
          </section>
        </>
      )}
    </section>
  );
}
