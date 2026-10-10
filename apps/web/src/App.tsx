import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Account,
  AccountsResponse,
  ChartPoint,
  Overview,
  StreamMessage,
  TradeEvent,
} from "../../../packages/shared/src/types";
import { API_BASE, fetchJson } from "./lib/api";
import {
  formatRawUsd,
  formatUsd,
  rawToNumber,
  relativeTime,
  shortAddress,
} from "./lib/format";
import { WalletDrawer, prefetchWallet } from "./components/WalletDrawer";
import { DataInfoDialog } from "./components/DataInfoDialog";
import { Avatar } from "./components/Avatar";
import { AssetsView } from "./components/AssetsView";
import { LeaderboardView } from "./components/LeaderboardView";
import { readDashboardRoute, type DashboardView } from "./lib/navigation";

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    northeast: <path d="M6 18 18 6M6 6h12v12" />,
    star: (
      <path d="m12 3 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3L12 17.4l-5.6 3 1.1-6.3L3 9.6l6.2-.9z" />
    ),
    circle: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6m0-10v1" />
      </>
    ),
    left: <path d="m14 6-6 6 6 6" />,
    right: <path d="m10 6 6 6-6 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.arrow}
    </svg>
  );
}
function PaperMark({ size = 30 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <path d="m3 14 33-9-13 29-5-14z" fill="currentColor" />
      <path d="M18 20 36 5" stroke="var(--paper)" strokeWidth="1.5" />
    </svg>
  );
}
function readFollowing(): Account[] {
  try {
    const list: unknown = JSON.parse(
      localStorage.getItem("paperdash:following") || "[]",
    );
    if (!Array.isArray(list)) return [];
    const rawFields = [
      "currentBalance",
      "currentQueued",
      "currentOpenNotional",
      "currentUnrealizedPnl",
      "realizedPnl",
      "totalVolume",
      "totalWindowedPnl",
      "paperTotal",
    ];
    const seen = new Set<string>();
    return list
      .filter((entry): entry is Account => {
        if (!entry || typeof entry !== "object") return false;
        if (
          typeof entry.address !== "string" ||
          !/^0x[a-fA-F0-9]{40}$/.test(entry.address)
        )
          return false;
        if (
          entry.leaderboardName !== null &&
          typeof entry.leaderboardName !== "string"
        )
          return false;
        if (
          !rawFields.every(
            (key) =>
              typeof entry[key] === "string" &&
              /^-?\d{1,100}$/.test(entry[key]),
          )
        )
          return false;
        if (
          !Number.isSafeInteger(entry.currentOpenPositionCount) ||
          entry.currentOpenPositionCount < 0 ||
          !Number.isFinite(entry.lastActiveTs) ||
          entry.lastActiveTs < 0
        )
          return false;
        const key = entry.address.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 100);
  } catch {
    return [];
  }
}
function useOverview() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [transport, setTransport] = useState(false);
  useEffect(() => {
    let source: EventSource | null = null;
    const controller = new AbortController();
    let requestPending = false;
    const refresh = async () => {
      if (document.hidden || requestPending) return;
      requestPending = true;
      try {
        const next = await fetchJson<Overview>("/api/overview", {
          signal: controller.signal,
        });
        setData(next);
        setError("");
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      } finally {
        requestPending = false;
      }
    };
    const connect = () => {
      source?.close();
      if (document.hidden) {
        setTransport(false);
        return;
      }
      source = new EventSource(`${API_BASE}/api/events`);
      source.onopen = () => setTransport(true);
      source.onerror = () => setTransport(false);
      source.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as StreamMessage;
          if (message.type === "overview") {
            setData(message.data);
            setError("");
          }
          if (message.type === "metrics" || message.type === "history")
            setData((old) => (old ? { ...old, ...message.data } : old));
          if (message.type === "trade")
            setData((old) =>
              old
                ? {
                    ...old,
                    trades: [
                      message.data,
                      ...old.trades.filter((t) => t.id !== message.data.id),
                    ].slice(0, 50),
                  }
                : old,
            );
          if (message.type === "status")
            setData((old) => (old ? { ...old, status: message.data } : old));
        } catch {
          /* a malformed event cannot replace a good snapshot */
        }
      };
      void refresh();
    };
    connect();
    const interval = setInterval(refresh, 15000);
    document.addEventListener("visibilitychange", connect);
    return () => {
      controller.abort();
      source?.close();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", connect);
    };
  }, []);
  return { data, error, transport };
}

const TvlChart = memo(function TvlChart({
  points,
  coverage,
}: {
  points: ChartPoint[];
  coverage: Overview["historyCoverage"];
}) {
  const [range, setRange] = useState("All");
  const [hover, setHover] = useState<number | null>(null);
  const clean = useMemo(
    () =>
      points
        .filter((p) => Number.isFinite(p.value) && Number.isFinite(p.time))
        .sort((a, b) => a.time - b.time),
    [points],
  );
  const filtered = useMemo(() => {
    if (range === "All" || !clean.length) return clean;
    const cutoff = Date.now() - (range === "24h" ? 86_400_000 : 604_800_000);
    return clean.filter((p) => p.time >= cutoff);
  }, [clean, range]);
  const width = 800,
    height = 170,
    pad = 8;
  const values = filtered.map((x) => x.value);
  const lo = values.length ? Math.min(...values) : 0;
  const hi = values.length ? Math.max(...values) : 1;
  const spread = Math.max(hi - lo, hi * 0.01, 1);
  const first = filtered[0]?.time ?? 0,
    last = filtered.at(-1)?.time ?? 1;
  const x = (p: ChartPoint, i: number) =>
    first === last
      ? width / 2
      : pad + ((p.time - first) / (last - first)) * (width - pad * 2);
  const y = (p: ChartPoint) =>
    height -
    20 -
    ((p.value - lo + spread * 0.15) / (spread * 1.3)) * (height - 35);
  const d = filtered
    .map((p, i) => `${i ? "L" : "M"}${x(p, i).toFixed(1)},${y(p).toFixed(1)}`)
    .join(" ");
  const activeIndex =
    hover == null ? filtered.length - 1 : Math.min(hover, filtered.length - 1);
  const active = filtered[activeIndex];
  return (
    <section className="tvl-chart" aria-label="Protocol TVL history">
      <div className="chart-toolbar">
        <span className="caption">
          <span className="legend-line" />
          PROTOCOL-REPORTED TVL
        </span>
        <div className="range-control" aria-label="Chart range">
          {["24h", "7d", "All"].map((r) => (
            <button
              key={r}
              aria-pressed={range === r}
              onClick={() => {
                setRange(r);
                setHover(null);
              }}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      <div className="chart-surface" onMouseLeave={() => setHover(null)}>
        {filtered.length > 0 ? (
          <>
            <span className="chart-value">
              {formatUsd(active?.value, true)}{" "}
              <small>
                {active
                  ? new Date(active.time).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })
                  : ""}
              </small>
            </span>
            <svg
              role="img"
              aria-label={`TVL history with ${filtered.length} observations. Latest ${formatUsd(filtered.at(-1)?.value)}.`}
              viewBox={`0 0 ${width} ${height}`}
              preserveAspectRatio="none"
              onMouseMove={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                const fraction = Math.max(
                  0,
                  Math.min(1, (event.clientX - box.left) / box.width),
                );
                const target = first + fraction * (last - first);
                let best = 0;
                filtered.forEach((p, i) => {
                  if (
                    Math.abs(p.time - target) <
                    Math.abs(filtered[best].time - target)
                  )
                    best = i;
                });
                setHover(best);
              }}
            >
              <defs>
                <linearGradient id="tvl-area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#99ac80" stopOpacity=".25" />
                  <stop offset="100%" stopColor="#99ac80" stopOpacity="0" />
                </linearGradient>
              </defs>
              {[40, 90, 140].map((v) => (
                <line
                  key={v}
                  x1="0"
                  x2={width}
                  y1={v}
                  y2={v}
                  stroke="currentColor"
                  opacity=".1"
                  strokeDasharray="2 6"
                />
              ))}
              {filtered.length > 1 && (
                <path
                  d={`${d}L${x(filtered.at(-1)!, filtered.length - 1)},${height}L${x(filtered[0], 0)},${height}Z`}
                  fill="url(#tvl-area)"
                />
              )}
              <path
                d={d}
                fill="none"
                stroke="#526947"
                strokeWidth="2.4"
                vectorEffect="non-scaling-stroke"
              />
              {active && (
                <circle
                  cx={x(active, activeIndex)}
                  cy={y(active)}
                  r="4"
                  fill="#526947"
                  stroke="var(--paper)"
                  strokeWidth="2"
                />
              )}
            </svg>
            <div className="chart-axis">
              <span>
                {new Date(first).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </span>
              <span>
                {coverage === "observed"
                  ? "Recorded since this collector started"
                  : "Available source history"}
              </span>
              <span>
                {new Date(last).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            </div>
          </>
        ) : (
          <div className="chart-empty">
            <span className="ink-dot" />
            <p>No TVL history available</p>
          </div>
        )}
      </div>
    </section>
  );
});

function TradeFeed({
  trades,
  onWallet,
  connected,
}: {
  trades: TradeEvent[];
  onWallet: (address: string) => void;
  connected: boolean;
}) {
  const [market, setMarket] = useState("All");
  const [paused, setPaused] = useState(false);
  const frozen = useRef<TradeEvent[]>([]);
  const visible = (paused ? frozen.current : trades)
    .filter(
      (t) => market === "All" || t.instrument === (market === "BTC" ? 0 : 1),
    )
    .slice(0, 8);
  return (
    <section className="activity-panel" id="activity">
      <div className="section-heading">
        <h2>Live trades</h2>
        <button
          className="text-button pause-button"
          onClick={() => {
            if (!paused) frozen.current = trades;
            setPaused(!paused);
          }}
        >
          {paused ? "Resume" : "Pause"}
        </button>
      </div>
      <div className="feed-filters">
        {["All", "BTC", "ETH"].map((m) => (
          <button
            key={m}
            onClick={() => setMarket(m)}
            aria-pressed={market === m}
          >
            {m === "All" ? "All markets" : m}
          </button>
        ))}
        <span
          className={`connection-dot ${connected ? "" : "waiting"}`}
          title={
            connected ? "Public stream connected" : "Public stream reconnecting"
          }
        />
      </div>
      {visible.length ? (
        <div className="trade-list">
          {visible.map((trade) => (
            <button
              key={trade.id}
              className="trade-row"
              onClick={() => onWallet(trade.wallet)}
            >
              <Avatar address={trade.wallet} />
              <span className="trade-description">
                <strong>{shortAddress(trade.wallet)}</strong>
                <span>
                  {trade.kind === "liq"
                    ? "Liquidated"
                    : trade.kind === "close"
                      ? "Closed"
                      : "Opened"}{" "}
                  {trade.instrument === 0 ? "BTC" : "ETH"}{" "}
                  <span
                    className={trade.side === "long" ? "positive" : "negative"}
                  >
                    {trade.side}
                  </span>{" "}
                  · {trade.leverage}×
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
        <div className="activity-empty">
          <div className="empty-orbit">
            <PaperMark size={39} />
          </div>
          <h3>{paused ? "Feed paused" : "No recent trades"}</h3>
          <p>
            {paused
              ? "Resume to see new activity."
              : "Opens, closes, and liquidations appear here."}
          </p>
          <span className="waiting-label">
            <i />
            {connected ? "Stream connected" : "Connecting"}
          </span>
        </div>
      )}
      <div className="panel-footnote">
        Public executions · recent activity <Icon name="circle" size={13} />
      </div>
    </section>
  );
}

function App() {
  const { data, error, transport } = useOverview();
  const [section, setSection] = useState<DashboardView>(
    () => readDashboardRoute(location.search).view,
  );
  const [asset, setAsset] = useState(
    () => readDashboardRoute(location.search).asset,
  );
  const [accounts, setAccounts] = useState<AccountsResponse | null>(null);
  const [accountsError, setAccountsError] = useState("");
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sort, setSort] = useState("currentBalance");
  const [page, setPage] = useState(0);
  const [retry, setRetry] = useState(0);
  const [following, setFollowing] = useState<Account[]>(readFollowing);
  const [wallet, setWallet] = useState<string | null>(() => {
    const a = new URLSearchParams(location.search).get("wallet");
    return a && /^0x[a-fA-F0-9]{40}$/.test(a) ? a : null;
  });
  const [info, setInfo] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const search = useRef<HTMLInputElement>(null);
  const cancelPrefetch = useRef<(() => void) | undefined>(undefined);
  const summary = data?.summary;
  const tvl = rawToNumber(summary?.balances.tvl);
  const sourceOld =
    !data?.status.sourceAt ||
    clock - data.status.sourceAt > 60000 ||
    data.status.stale;
  const streamLive = transport && data?.status.stream === "connected";

  useEffect(() => {
    if (query.trim() === debouncedQuery) return;
    const timeout = setTimeout(() => {
      setDebouncedQuery(query.trim());
      setPage(0);
    }, 250);
    return () => clearTimeout(timeout);
  }, [query, debouncedQuery]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const params = new URLSearchParams({
      q: debouncedQuery,
      sort,
      page: String(page),
    });
    const refresh = async (foreground = false) => {
      if (
        pending ||
        document.hidden ||
        (section !== "overview" && section !== "wallets")
      )
        return;
      pending = true;
      if (foreground) {
        setLoadingAccounts(true);
        setAccountsError("");
      }
      try {
        const response = await fetchJson<AccountsResponse>(
          `/api/accounts?${params}`,
          { signal: controller.signal },
        );
        setAccounts(response);
        setAccountsError("");
      } catch (e) {
        if (!controller.signal.aborted && foreground)
          setAccountsError((e as Error).message);
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoadingAccounts(false);
      }
    };
    void refresh(true);
    const timer = setInterval(() => void refresh(), 30000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [debouncedQuery, sort, page, retry, section]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        search.current?.focus();
      }
      if (e.key === "Escape") setInfo(false);
    };
    const pop = () => {
      const route = readDashboardRoute(location.search);
      setSection(route.view);
      setAsset(route.asset);
      const a = new URLSearchParams(location.search).get("wallet");
      setWallet(a && /^0x[a-fA-F0-9]{40}$/.test(a) ? a : null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("popstate", pop);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("popstate", pop);
    };
  }, []);
  const openWallet = useCallback((address: string) => {
    setWallet(address);
    const url = new URL(location.href);
    url.searchParams.set("wallet", address);
    history.pushState(null, "", url);
  }, []);
  const closeWallet = useCallback(() => {
    setWallet(null);
    const url = new URL(location.href);
    url.searchParams.delete("wallet");
    history.replaceState(null, "", url);
  }, []);
  const navigate = (next: DashboardView, nextAsset = asset) => {
    setSection(next);
    setAsset(nextAsset);
    const url = new URL(location.href);
    if (next === "overview") url.searchParams.delete("view");
    else url.searchParams.set("view", next);
    if (next === "assets") url.searchParams.set("asset", String(nextAsset));
    else url.searchParams.delete("asset");
    if (url.href !== location.href) history.pushState(null, "", url);
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  const toggleFollow = (account: Account) =>
    setFollowing((old) => {
      const next = old.some(
        (a) => a.address.toLowerCase() === account.address.toLowerCase(),
      )
        ? old.filter(
            (a) => a.address.toLowerCase() !== account.address.toLowerCase(),
          )
        : [account, ...old].slice(0, 100);
      try {
        localStorage.setItem("paperdash:following", JSON.stringify(next));
      } catch {
        /* memory-only on unavailable storage */
      }
      return next;
    });
  const displayAccounts =
    section === "following"
      ? following.filter((a) =>
          `${a.address} ${a.leaderboardName ?? ""}`
            .toLowerCase()
            .includes(debouncedQuery.toLowerCase()),
        )
      : (accounts?.accounts ?? []);
  const selectedAccount = [...(accounts?.accounts ?? []), ...following].find(
    (a) => a.address.toLowerCase() === wallet?.toLowerCase(),
  );

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <div className="header-inner">
          <button
            className="wordmark"
            aria-label="Paperdash overview"
            onClick={() => navigate("overview")}
          >
            <PaperMark />
            <span>
              paperdash<span className="wordmark-dot">.</span>
            </span>
          </button>
          <nav aria-label="Main navigation">
            {(
              [
                "overview",
                "wallets",
                "assets",
                "leaderboard",
                "following",
              ] as const
            ).map((item) => (
              <button
                key={item}
                className={section === item ? "active" : ""}
                aria-current={section === item ? "page" : undefined}
                onClick={() => navigate(item)}
              >
                {item[0].toUpperCase() + item.slice(1)}
                {item === "following" && following.length > 0 && (
                  <span className="nav-count">{following.length}</span>
                )}
              </button>
            ))}
          </nav>
          <div className="header-search">
            <Icon name="search" size={16} />
            <input
              ref={search}
              aria-label="Search wallets"
              placeholder="Find a wallet or name"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (section !== "wallets" && section !== "following")
                  navigate("wallets");
              }}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  /^0x[a-fA-F0-9]{40}$/.test(query.trim())
                )
                  openWallet(query.trim());
              }}
            />
            <kbd>⌘ K</kbd>
          </div>
          <button
            className="header-about"
            onClick={() => setInfo(true)}
            aria-label="About this data"
          >
            <Icon name="circle" />
          </button>
        </div>
      </header>
      <main id="main" className="page-shell">
        <h1 className="sr-only">Papertrade analytics</h1>
        {section !== "assets" && section !== "leaderboard" && (
          <section className="overview-board" aria-label="Protocol overview">
            <div className="metrics-row">
              <div className="metric metric-primary">
                <span className="metric-label">
                  TVL{" "}
                  <button
                    aria-label="View data status"
                    onClick={() => setInfo(true)}
                  >
                    <Icon name="circle" size={13} />
                  </button>
                </span>
                <strong className={!summary ? "skeleton-text" : ""}>
                  {formatUsd(tvl, true)}
                </strong>
                <span className="metric-note">USDC · protocol-reported</span>
              </div>
              <div className="metric metric-primary">
                <span className="metric-label">Wallets</span>
                <strong>
                  {data?.accountCount?.toLocaleString("en-US") ?? "—"}
                </strong>
                <span className="metric-note">Public accounts</span>
              </div>
              <div className="metric">
                <span className="metric-label">Trading volume</span>
                <strong>{formatRawUsd(summary?.activity.volume, true)}</strong>
                <span className="metric-note">Lifetime notional</span>
              </div>
              <div className="metric">
                <span className="metric-label">Open positions</span>
                <strong>
                  {summary?.activity.open.toLocaleString("en-US") ?? "—"}
                </strong>
                <span className="metric-note">Across BTC & ETH</span>
              </div>
            </div>
            <div className="board-status">
              <span className={`freshness ${sourceOld ? "stale" : ""}`}>
                <i />
                {!data
                  ? "Connecting"
                  : sourceOld
                    ? "Last known snapshot"
                    : "Updating"}
                <span className="freshness-time">
                  {" "}
                  · {relativeTime(data?.status.sourceAt)}
                </span>
              </span>
            </div>
            {error && (
              <p className="inline-notice" role="status">
                {data ? "Showing the last available snapshot. " : ""}
                {error}
              </p>
            )}
          </section>
        )}

        {section === "overview" && (
          <div className="story-grid">
            <div className="history-panel">
              <div className="section-heading">
                <h2>TVL history</h2>
                <span className="tiny-caption">USDC</span>
              </div>
              <TvlChart
                points={data?.history ?? []}
                coverage={data?.historyCoverage ?? "unavailable"}
              />
              <div className="history-footer">
                <span>Protocol-reported USDC</span>
                <button className="text-button" onClick={() => setInfo(true)}>
                  Data source <Icon name="northeast" size={13} />
                </button>
              </div>
            </div>
            <TradeFeed
              trades={data?.trades ?? []}
              onWallet={openWallet}
              connected={Boolean(streamLive)}
            />
          </div>
        )}

        {section === "assets" && (
          <AssetsView
            instrument={asset}
            onSelect={(instrument) => navigate("assets", instrument)}
            onWallet={openWallet}
          />
        )}
        {section === "leaderboard" && <LeaderboardView onWallet={openWallet} />}

        {(section === "overview" ||
          section === "wallets" ||
          section === "following") && (
          <section className="community-section" id="wallets">
            <div className="community-heading">
              <div>
                <h2>
                  {section === "following" ? "Following" : "Wallets"}
                  <span className="heading-count">
                    {section === "following"
                      ? following.length
                      : (accounts?.summary.uniqueAccounts?.toLocaleString() ??
                        "—")}
                  </span>
                </h2>
                {section === "following" && (
                  <p>Saved on this device · balances at time of saving</p>
                )}
              </div>
              <div className="community-controls">
                <label htmlFor="sort-wallets">Sort by</label>
                <select
                  id="sort-wallets"
                  value={sort}
                  disabled={section === "following"}
                  onChange={(e) => {
                    setSort(e.target.value);
                    setPage(0);
                  }}
                >
                  <option value="currentBalance">Balance</option>
                  <option value="lastActiveTs">Recent activity</option>
                  <option value="totalVolume">Volume</option>
                  <option value="realizedPnl">Realized PnL</option>
                </select>
              </div>
            </div>
            {query && (
              <div className="search-summary">
                <span>
                  Results for <strong>{query}</strong>
                </span>
                <button className="text-button" onClick={() => setQuery("")}>
                  Clear <Icon name="close" size={13} />
                </button>
              </div>
            )}
            {accountsError && section !== "following" ? (
              <div className="table-empty">
                <h3>Unable to load wallets</h3>
                <p>{accountsError}</p>
                <button
                  className="outline-button"
                  onClick={() => setRetry((x) => x + 1)}
                >
                  Try again
                </button>
              </div>
            ) : (
              <>
                <div
                  className={`table-scroll ${loadingAccounts && section !== "following" ? "table-loading" : ""}`}
                  aria-busy={loadingAccounts && section !== "following"}
                >
                  <table className="wallet-table">
                    <thead>
                      <tr>
                        <th className="rank-cell">NO.</th>
                        <th>WALLET</th>
                        <th className="numeric">
                          {section === "following"
                            ? "SAVED BALANCE"
                            : "BALANCE"}
                        </th>
                        <th className="numeric">REALIZED PNL</th>
                        <th className="numeric volume-cell">VOLUME</th>
                        <th className="last-seen">LAST ACTIVE</th>
                        <th>
                          <span className="sr-only">Follow wallet</span>
                        </th>
                        <th>
                          <span className="sr-only">Open wallet</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {loadingAccounts && !accounts && section !== "following"
                        ? Array.from({ length: 5 }, (_, i) => (
                            <tr key={i} className="skeleton-row">
                              <td>{String(i + 1).padStart(2, "0")}</td>
                              <td>
                                <span className="skeleton-line" />
                              </td>
                              <td colSpan={6}>
                                <span className="skeleton-line short" />
                              </td>
                            </tr>
                          ))
                        : displayAccounts.map((account, i) => {
                            const pnl = rawToNumber(account.realizedPnl) ?? 0;
                            const saved = following.some(
                              (a) =>
                                a.address.toLowerCase() ===
                                account.address.toLowerCase(),
                            );
                            return (
                              <tr key={account.address}>
                                <td className="rank-cell">
                                  {String(
                                    (section === "following" ? 0 : page * 25) +
                                      i +
                                      1,
                                  ).padStart(2, "0")}
                                </td>
                                <td>
                                  <button
                                    className="wallet-identity"
                                    onMouseEnter={() => {
                                      cancelPrefetch.current?.();
                                      cancelPrefetch.current = prefetchWallet(
                                        account.address,
                                      );
                                    }}
                                    onMouseLeave={() =>
                                      cancelPrefetch.current?.()
                                    }
                                    onFocus={() => {
                                      cancelPrefetch.current?.();
                                      cancelPrefetch.current = prefetchWallet(
                                        account.address,
                                      );
                                    }}
                                    onBlur={() => cancelPrefetch.current?.()}
                                    onClick={() => openWallet(account.address)}
                                  >
                                    <Avatar address={account.address} />
                                    <span>
                                      <strong>
                                        {account.leaderboardName ||
                                          shortAddress(account.address)}
                                      </strong>
                                      <span>
                                        {account.leaderboardName
                                          ? shortAddress(account.address)
                                          : "Papertrade wallet"}
                                      </span>
                                    </span>
                                  </button>
                                </td>
                                <td className="numeric table-balance">
                                  {formatRawUsd(account.currentBalance)}
                                </td>
                                <td
                                  className={`numeric ${pnl > 0 ? "positive" : pnl < 0 ? "negative" : "muted"}`}
                                >
                                  {pnl > 0 ? "+" : ""}
                                  {formatRawUsd(account.realizedPnl)}
                                </td>
                                <td className="numeric volume-cell">
                                  {formatRawUsd(account.totalVolume, true)}
                                </td>
                                <td className="last-seen muted">
                                  {relativeTime(account.lastActiveTs)}
                                </td>
                                <td>
                                  <button
                                    className={`star-button ${saved ? "saved" : ""}`}
                                    aria-label={`${saved ? "Unfollow" : "Follow"} ${account.leaderboardName || shortAddress(account.address)}`}
                                    aria-pressed={saved}
                                    onClick={() => toggleFollow(account)}
                                  >
                                    <Icon name="star" size={17} />
                                  </button>
                                </td>
                                <td>
                                  <button
                                    className="row-arrow"
                                    onClick={() => openWallet(account.address)}
                                    aria-label={`Explore ${shortAddress(account.address)}`}
                                  >
                                    <Icon name="northeast" size={17} />
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                    </tbody>
                  </table>
                </div>
                {!loadingAccounts && !displayAccounts.length && (
                  <div className="table-empty">
                    <PaperMark size={30} />
                    <h3>
                      {section === "following"
                        ? "No followed wallets"
                        : "No wallets found"}
                    </h3>
                    <p>
                      {section === "following"
                        ? "Tap the star beside a wallet to keep it here."
                        : "Try a full wallet address or a different public name."}
                    </p>
                    {section === "following" && (
                      <button
                        className="outline-button"
                        onClick={() => navigate("wallets")}
                      >
                        Browse wallets <Icon name="arrow" size={15} />
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
            <div className="table-footer">
              <span>
                {section === "following"
                  ? "Following is private to this browser."
                  : `${accounts?.count?.toLocaleString() ?? "—"} public accounts${accounts?.stale ? " · cached directory" : ""}`}
              </span>
              {section !== "following" && (
                <div className="pagination">
                  <button
                    aria-label="Previous page"
                    disabled={page === 0 || loadingAccounts}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    <Icon name="left" size={15} />
                  </button>
                  <span>
                    {page + 1}{" "}
                    <span className="muted">
                      / {accounts?.pageInfo.totalPages ?? "—"}
                    </span>
                  </span>
                  <button
                    aria-label="Next page"
                    disabled={
                      !accounts ||
                      page + 1 >= accounts.pageInfo.totalPages ||
                      loadingAccounts
                    }
                    onClick={() => setPage((p) => p + 1)}
                  >
                    <Icon name="right" size={15} />
                  </button>
                </div>
              )}
            </div>
          </section>
        )}

        <footer className="site-footer">
          <span className="footer-brand">paperdash.</span>
          <span>Independent Papertrade analytics</span>
          <div>
            <button onClick={() => setInfo(true)}>Data & sources</button>
            <a
              href="https://exchange.papertrade.xyz/trade/btc"
              target="_blank"
              rel="noreferrer"
            >
              Open Papertrade <Icon name="northeast" size={12} />
            </a>
          </div>
        </footer>
      </main>
      <WalletDrawer
        address={wallet}
        onClose={closeWallet}
        displayName={selectedAccount?.leaderboardName}
      />
      <DataInfoDialog
        open={info}
        onClose={() => setInfo(false)}
        status={data?.status ?? null}
      />
    </>
  );
}
export default App;
