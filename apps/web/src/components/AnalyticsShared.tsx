import { useEffect, useRef, useState } from "react";
import { relativeTime, shortAddress } from "../lib/format";
import { Avatar } from "./Avatar";
import { prefetchWallet } from "./WalletDrawer";

export function AnalyticsStatus({
  receivedAt,
  stale,
  error,
  loading,
  onRefresh,
}: {
  receivedAt: number | null | undefined;
  stale: boolean;
  error?: string;
  loading: boolean;
  onRefresh: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);
  const old =
    stale || Boolean(error) || Boolean(receivedAt && now - receivedAt > 60_000);
  return (
    <div className="analytics-status">
      <span className={`freshness ${old ? "stale" : ""}`}>
        <i />
        {!receivedAt
          ? loading
            ? "Loading snapshot"
            : "Awaiting snapshot"
          : old
            ? "Last available snapshot"
            : "Updated"}
        {receivedAt && (
          <time
            dateTime={new Date(receivedAt).toISOString()}
            title={new Date(receivedAt).toLocaleString()}
          >
            {" "}
            · {relativeTime(receivedAt)}
          </time>
        )}
      </span>
      <button
        type="button"
        className="text-button"
        onClick={onRefresh}
        disabled={loading}
      >
        Refresh
      </button>
    </div>
  );
}

export function AnalyticsNotice({
  error,
  hasData,
}: {
  error: string | undefined;
  hasData: boolean;
}) {
  if (!error) return null;
  return (
    <p className="analytics-notice" role="status">
      {hasData ? "Showing the last available snapshot. " : ""}
      {error}
    </p>
  );
}

export function AnalyticsWallet({
  address,
  name,
  onWallet,
}: {
  address: string;
  name?: string | null;
  onWallet: (address: string) => void;
}) {
  const cancel = useRef<(() => void) | undefined>(undefined);
  const warm = () => {
    cancel.current?.();
    cancel.current = prefetchWallet(address);
  };
  useEffect(() => () => cancel.current?.(), []);
  return (
    <button
      className="wallet-identity"
      type="button"
      onClick={() => onWallet(address)}
      onFocus={warm}
      onMouseEnter={warm}
      onBlur={() => cancel.current?.()}
      onMouseLeave={() => cancel.current?.()}
    >
      <Avatar address={address} />
      <span>
        <strong>{name || shortAddress(address)}</strong>
        <span>{name ? shortAddress(address) : "View wallet"}</span>
      </span>
    </button>
  );
}
