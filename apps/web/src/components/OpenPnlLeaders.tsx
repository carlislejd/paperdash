import type { AccountsResponse } from "../../../../packages/shared/src/types";
import { useAnalytics } from "../lib/use-analytics";
import {
  formatRawUsd,
  rawToNumber,
  relativeTime,
  shortAddress,
} from "../lib/format";
import { Avatar } from "./Avatar";

export function OpenPnlLeaders({
  onWallet,
  onBrowse,
}: {
  onWallet: (address: string) => void;
  onBrowse: () => void;
}) {
  const { data, error, loading, refresh } = useAnalytics<AccountsResponse>(
    "/api/accounts?sort=currentUnrealizedPnl&page=0&pageSize=10",
  );
  const rows = (data?.accounts ?? []).filter(
    (account) =>
      (rawToNumber(account.currentUnrealizedPnl) ?? 0) > 0 &&
      (account.currentOpenPositionCount == null || account.currentOpenPositionCount > 0),
  );
  const maximum = Math.max(
    1,
    ...rows.map((account) => rawToNumber(account.currentUnrealizedPnl) ?? 0),
  );
  const delayed = Boolean(
    error || data?.stale || (data && Date.now() - data.receivedAt > 60000),
  );
  return (
    <section className="open-pnl-panel" aria-labelledby="open-pnl-title">
      <div className="section-heading">
        <div>
          <h2 id="open-pnl-title">Top open PnL</h2>
          <p className="open-pnl-caption">
            Largest current unrealized gains · USDC
          </p>
        </div>
        <span className="tiny-caption">
          {delayed ? "Last available" : relativeTime(data?.receivedAt)}
        </span>
      </div>
      <div className="open-pnl-stage">
        <ol className="open-pnl-list" aria-busy={loading}>
          {rows.map((account, index) => (
            <li key={account.address}>
              <button
                className="open-pnl-row"
                onClick={() => onWallet(account.address)}
              >
                <span className="open-pnl-rank">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <Avatar address={account.address} />
                <span className="open-pnl-wallet">
                  <strong>
                    {account.leaderboardName || shortAddress(account.address)}
                  </strong>
                  <small
                    title={`Total notional value of open positions: ${formatRawUsd(account.currentOpenNotional)} USDC`}
                  >
                    {formatRawUsd(account.currentOpenNotional, true)} open notional
                  </small>
                </span>
                <span className="open-pnl-value">
                  <span
                    className="open-pnl-bar"
                    aria-hidden="true"
                    style={{
                      width: `${Math.max(1, ((rawToNumber(account.currentUnrealizedPnl) ?? 0) / maximum) * 100)}%`,
                    }}
                  />
                  <strong
                    className="positive"
                    title={formatRawUsd(account.currentUnrealizedPnl)}
                  >
                    +{formatRawUsd(account.currentUnrealizedPnl, true)}
                  </strong>
                </span>
              </button>
            </li>
          ))}
        </ol>
        {!rows.length && (
          <p className="open-pnl-empty">
            {loading
              ? "Loading open PnL…"
              : !data
                ? "Open PnL is unavailable."
                : "No positive open PnL in the current ranking."}
          </p>
        )}
      </div>
      <div className="open-pnl-footer">
        <span>
          {delayed
            ? "Prices or account data may be delayed."
            : "Unrealized PnL changes with the market."}
        </span>
        <button className="text-button" onClick={error ? refresh : onBrowse}>
          {error ? "Retry" : "All wallets ↗"}
        </button>
      </div>
    </section>
  );
}
