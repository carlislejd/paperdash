import { useId, useState } from "react";
import type { PositionMetricsResponse } from "../../../../packages/shared/src/position-metrics";
import type { WalletResponse } from "../../../../packages/shared/src/types";
import { relativeTime } from "../lib/format";
import {
  formatHoldingTime,
  formatLeverage,
  openPositionRows,
} from "../lib/position-format";
import { useAnalytics } from "../lib/use-analytics";
import "./position-metrics.css";

function OpenPositions({ wallet }: { wallet: WalletResponse }) {
  const [visibleCount, setVisibleCount] = useState(5);
  const snapshot = wallet.snapshot;
  const saved = wallet.stale || wallet.errors.length > 0;
  // A delayed snapshot cannot establish that a position is still open now.
  const sourceTime = snapshot?.indexedThroughTimestamp;
  const snapshotAt =
    sourceTime != null && Number.isFinite(sourceTime) && sourceTime >= 0
      ? sourceTime * 1000
      : wallet.receivedAt;
  const asOf = saved ? Math.min(snapshotAt, Date.now()) : Date.now();
  const positions = openPositionRows(snapshot?.openPositions ?? [], asOf);
  return (
    <section
      className="open-position-panel"
      aria-label="Current open positions"
    >
      <div className="open-position-heading">
        <h3>
          Open positions{" "}
          <span>{snapshot ? positions.length.toLocaleString() : "—"}</span>
        </h3>
        {saved && <span className="position-delayed">At saved snapshot</span>}
      </div>
      {!snapshot ? (
        <p className="position-empty">Position snapshot unavailable.</p>
      ) : !positions.length ? (
        <p className="position-empty">
          No open positions{saved ? " in this snapshot" : ""}.
        </p>
      ) : (
        <>
          <div className="open-position-labels" aria-hidden="true">
            <span>Market / side</span>
            <span>Leverage</span>
            <span>Held</span>
          </div>
          <ul className="open-position-list">
            {positions.slice(0, visibleCount).map((position) => (
              <li key={position.key}>
                <span>
                  <strong>{position.symbol}</strong>{" "}
                  <span
                    className={
                      position.side === "Long"
                        ? "positive"
                        : position.side === "Short"
                          ? "negative"
                          : "muted"
                    }
                  >
                    {position.side}
                  </span>
                </span>
                <span
                  aria-label={`Leverage ${formatLeverage(position.leverage)}`}
                >
                  {formatLeverage(position.leverage)}
                </span>
                <span
                  aria-label={`Held ${formatHoldingTime(position.heldMs)}${saved ? " at saved snapshot" : ""}`}
                >
                  {formatHoldingTime(position.heldMs)}
                </span>
              </li>
            ))}
          </ul>
          {positions.length > 5 && (
            <button
              type="button"
              className="position-more"
              onClick={() =>
                setVisibleCount(
                  visibleCount >= positions.length
                    ? 5
                    : Math.min(visibleCount + 20, positions.length),
                )
              }
            >
              {visibleCount >= positions.length
                ? "Show fewer positions"
                : `Show ${Math.min(positions.length - visibleCount, 20)} more positions`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

export function PositionMetrics({ wallet }: { wallet?: WalletResponse }) {
  const id = useId();
  const { data, error, loading, refresh } =
    useAnalytics<PositionMetricsResponse>(
      wallet
        ? `/api/wallets/${wallet.address}/position-metrics`
        : "/api/position-metrics",
    );
  const syncing =
    data &&
    (data.coverage.pending ||
      !data.coverage.projectionBackfillComplete ||
      data.coverage.historyBackfillComplete === false);
  const stale = Boolean(error) || Boolean(data?.stale);
  const count = data?.positionCount ?? 0;
  const Heading = wallet ? "h3" : "h2";
  return (
    <>
      <section
        className={`position-metrics ${wallet ? "position-metrics-wallet" : "position-metrics-global"}`}
        aria-label={
          wallet ? "Wallet position averages" : "Global position averages"
        }
      >
        <div className="position-metrics-heading">
          <Heading>
            Closed positions{" "}
            <span>{data ? count.toLocaleString("en-US") : "—"}</span>
          </Heading>
          <div className="position-metrics-status">
            <span className={stale ? "position-delayed" : ""}>
              {stale
                ? "Last available"
                : !data
                  ? loading
                    ? "Loading"
                    : "Unavailable"
                  : syncing
                    ? "Syncing history"
                    : wallet
                      ? "Indexed history"
                      : "Partial indexed history"}
              {data?.updatedAt && (
                <time
                  dateTime={new Date(data.updatedAt).toISOString()}
                  title={new Date(data.updatedAt).toLocaleString()}
                >
                  {" "}
                  · {relativeTime(data.updatedAt)}
                </time>
              )}
            </span>
            <button
              type="button"
              onClick={refresh}
              disabled={loading}
              aria-label={`Refresh ${wallet ? "wallet" : "global"} position averages`}
            >
              {error ? "Retry" : "↻"}
            </button>
          </div>
        </div>
        <dl className="position-averages" aria-describedby={`${id}-method`}>
          <div>
            <dt>Avg hold</dt>
            <dd>{count > 0 ? formatHoldingTime(data?.avgHoldMs) : "—"}</dd>
          </div>
          <div>
            <dt>Avg leverage</dt>
            <dd>{count > 0 ? formatLeverage(data?.avgLeverage) : "—"}</dd>
          </div>
        </dl>
        <p className="position-method" id={`${id}-method`}>
          Equal-weight · includes liquidations ·{" "}
          {wallet ? "indexed history" : "partial indexed history"}
          {data && data.excludedCount > 0
            ? ` · ${data.excludedCount.toLocaleString("en-US")} excluded`
            : ""}
        </p>
        {error ? (
          <p className="position-empty position-delayed" role="status">
            Could not refresh these averages.
            {data ? " Saved values shown." : ""}
          </p>
        ) : data && count === 0 ? (
          <p className="position-empty">No closed positions indexed yet.</p>
        ) : null}
      </section>
      {wallet && <OpenPositions key={wallet.address} wallet={wallet} />}
    </>
  );
}
