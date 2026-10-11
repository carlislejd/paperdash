import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import type {
  Cashflow,
  ClosedTrade,
  HistoryPage,
  PortfolioHistory,
  WalletResponse,
} from "../../../../packages/shared/src/types";
import { fetchJson } from "../lib/api";
import { useFollowing } from "../lib/use-following";
import { FOLLOWING_LIMIT } from "../lib/following-storage";
import { mergeHistory } from "../lib/wallet-history";
import { closedHoldingTimeMs, formatHoldingTime } from "../lib/position-format";
import { PositionMetrics } from "./PositionMetrics";
import { WalletMarginRisk } from "./WalletMarginRisk";
import { riskMatchesSnapshot } from "../lib/margin-risk-display";
import {
  normalizeClosedPosition,
  type PositionDetails,
} from "../../../../packages/shared/src/position-details";
import {
  freezePositionReceipt,
  type PositionReceiptSnapshot,
} from "../lib/position-receipt";
import { PositionReceiptDialog } from "./PositionReceiptDialog";
import {
  formatRawUsd,
  formatUsd,
  relativeTime,
  shortAddress,
} from "../lib/format";
import "./wallet.css";

interface WalletDrawerProps {
  address: string | null;
  onClose: () => void;
  displayName?: string | null;
}

type HistoryTab = "cashflows" | "trades";
const walletCache = new Map<string, WalletResponse>();
const FOCUSABLE =
  'button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]';
const REFRESH_INTERVAL = 15_000;
let prefetch: {
  address: string;
  timer: number;
  controller: AbortController;
} | null = null;

function cacheWallet(wallet: WalletResponse) {
  const key = wallet.address.toLowerCase();
  rememberTradePage(wallet.trades);
  walletCache.delete(key);
  walletCache.set(key, wallet);
  if (walletCache.size > 30)
    walletCache.delete(walletCache.keys().next().value!);
}

/** Call on wallet hover/focus; call the returned function on pointer leave/blur. */
export function prefetchWallet(address: string): () => void {
  const key = address.toLowerCase();
  const cached = walletCache.get(key);
  if (
    !/^0x[\da-f]{40}$/i.test(address) ||
    (cached && Date.now() - cached.receivedAt < REFRESH_INTERVAL)
  )
    return () => {};
  if (prefetch?.address === key) return () => {};
  if (prefetch) {
    window.clearTimeout(prefetch.timer);
    prefetch.controller.abort();
  }
  const controller = new AbortController();
  const timer = window.setTimeout(() => {
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    fetchJson<WalletResponse>(`/api/wallets/${address}`, {
      signal: controller.signal,
    })
      .then((wallet) => {
        if (!controller.signal.aborted && wallet.address.toLowerCase() === key)
          cacheWallet(wallet);
      })
      .catch(() => {
        /* Prefetch is optional; the drawer supplies visible error recovery. */
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (prefetch?.controller === controller) prefetch = null;
      });
  }, 70);
  prefetch = { address: key, timer, controller };
  return () => {
    window.clearTimeout(timer);
    controller.abort();
    if (prefetch?.controller === controller) prefetch = null;
  };
}

// Source clocks belong to the page that observed each row, even after pagination.
const tradeReceiptSources = new WeakMap<
  ClosedTrade,
  { receivedAt: number | null; stale: boolean; identityAmbiguous: boolean }
>();
function rememberTradePage(page: HistoryPage<ClosedTrade>) {
  const source = {
    receivedAt: page.receivedAt ?? page.coverage?.lastIndexedAt ?? null,
    stale: page.stale === true,
    identityAmbiguous: page.coverage?.identityAmbiguous === true,
  };
  for (const item of page.items) tradeReceiptSources.set(item, source);
}
function tradeReceiptSource(item: ClosedTrade, page: HistoryPage<ClosedTrade>) {
  return (
    tradeReceiptSources.get(item) ?? {
      receivedAt: page.receivedAt ?? page.coverage?.lastIndexedAt ?? null,
      stale: page.stale === true,
      identityAmbiguous: page.coverage?.identityAmbiguous === true,
    }
  );
}

function cashflowKey(item: Cashflow) {
  return (
    item.id ??
    `${item.kind}:${item.txHash}:${item.timestampMs}:${item.amountRaw}`
  );
}
function tradeKey(item: ClosedTrade) {
  return typeof item.id === "string"
    ? item.id
    : `${String(item.positionId)}:${String(item.txHash)}:${String(item.timestampMs)}`;
}

/** A display-only decimal expansion. Financial totals always remain raw integer strings. */
function exactAmount(raw: string | null | undefined, decimals = 18): string {
  if (!raw || !/^-?\d+$/.test(raw)) return "Unavailable";
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(decimals + 1, "0");
  const whole = digits
    .slice(0, -decimals)
    .replace(/^0+(?=\d)/, "")
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return `${negative ? "−" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function paperAmount(raw: string | null | undefined): string {
  const amount = exactAmount(raw);
  return amount === "Unavailable"
    ? "—"
    : amount.replace(/(\.\d{0,2})\d+$/, "$1").replace(/\.$/, "");
}

function dateLabel(time: number | null | undefined, withYear = false): string {
  if (
    time == null ||
    !Number.isFinite(time) ||
    !Number.isFinite(new Date(time).getTime())
  )
    return "Date unavailable";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  }).format(time);
}

function TransactionLink({ hash }: { hash: unknown }) {
  if (typeof hash !== "string" || !/^0x[\da-f]{64}$/i.test(hash)) return null;
  return (
    <a
      className="wd-tx"
      href={`https://hyperevmscan.io/tx/${hash}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`View transaction ${hash} on HyperEVMScan (opens in a new tab)`}
    >
      Onchain <span aria-hidden="true">↗</span>
    </a>
  );
}

function PortfolioChart({ history }: { history: PortfolioHistory | null }) {
  const [series, setSeries] = useState<"equity" | "pnl">("equity");
  const chart = useMemo(() => {
    if (!history) return null;
    const values = history.columns[series];
    const points = history.timeOffsetsMs
      .map((offset, index) => ({
        time: history.baseTimeMs + offset,
        value: values[index],
        index,
      }))
      .filter(
        (point) => Number.isFinite(point.time) && Number.isFinite(point.value),
      );
    if (!points.length) return null;
    let min = points[0].value,
      max = points[0].value;
    for (const point of points) {
      min = Math.min(min, point.value);
      max = Math.max(max, point.value);
    }
    const padding = (max - min) * 0.12 || Math.max(Math.abs(max) * 0.025, 1);
    const lower = min - padding,
      upper = max + padding;
    const start = points[0].time,
      end = points[points.length - 1].time;
    const x = (time: number) =>
      64 + (end === start ? 0.5 : (time - start) / (end - start)) * 516;
    const y = (value: number) =>
      150 - ((value - lower) / (upper - lower)) * 126;
    const gaps = new Set(history.gapIndices);
    const paths: string[] = [];
    let path = "",
      previousIndex = -2;
    for (const point of points) {
      const breakBefore =
        gaps.has(point.index) || point.index !== previousIndex + 1;
      if (breakBefore && path) {
        paths.push(path);
        path = "";
      }
      path += `${path ? " L" : "M"}${x(point.time).toFixed(2)},${y(point.value).toFixed(2)}`;
      previousIndex = point.index;
    }
    if (path) paths.push(path);
    const last = points[points.length - 1];
    return {
      paths,
      min,
      max,
      start,
      end,
      last,
      lastX: x(last.time),
      lastY: y(last.value),
      gaps: gaps.size,
    };
  }, [history, series]);

  return (
    <section className="wd-chart-section" aria-label="Recorded wallet history">
      <div className="wd-section-heading">
        <div>
          <h3>Portfolio history</h3>
        </div>
        <div
          className="wd-chart-toggle"
          role="group"
          aria-label="Chart measure"
        >
          <button
            type="button"
            aria-pressed={series === "equity"}
            onClick={() => setSeries("equity")}
          >
            Equity
          </button>
          <button
            type="button"
            aria-pressed={series === "pnl"}
            onClick={() => setSeries("pnl")}
          >
            P&amp;L
          </button>
        </div>
      </div>
      {chart ? (
        <figure className="wd-chart">
          <div className="wd-chart-value">
            <strong>{formatUsd(chart.last.value)}</strong>
            <span>last recorded {series === "equity" ? "equity" : "P&L"}</span>
          </div>
          <svg
            viewBox="0 0 604 180"
            role="img"
            aria-label={`Recorded ${series === "equity" ? "equity" : "P and L"} from ${dateLabel(chart.start, true)} to ${dateLabel(chart.end, true)}. Latest ${formatUsd(chart.last.value)}. ${history?.coverage.complete ? "Complete coverage for the returned period." : "History is incomplete."}`}
          >
            {[30, 88, 150].map((y) => (
              <line
                key={y}
                x1="64"
                x2="580"
                y1={y}
                y2={y}
                className="wd-chart-grid"
              />
            ))}
            <text x="0" y="33" className="wd-chart-label">
              {formatUsd(chart.max, true)}
            </text>
            <text x="0" y="153" className="wd-chart-label">
              {formatUsd(chart.min, true)}
            </text>
            {chart.paths.map((path, index) => (
              <path key={index} d={path} className="wd-chart-line" />
            ))}
            <circle
              cx={chart.lastX}
              cy={chart.lastY}
              r="4"
              className="wd-chart-dot"
            />
            <text x="64" y="176" className="wd-chart-label">
              {dateLabel(chart.start)}
            </text>
            <text x="580" y="176" textAnchor="end" className="wd-chart-label">
              {dateLabel(chart.end)}
            </text>
          </svg>
          <figcaption>
            <span
              className={`wd-coverage ${history?.coverage.complete ? "" : "wd-coverage-partial"}`}
            >
              {history?.coverage.complete
                ? "Available period"
                : "Partial history"}
            </span>
            <span>
              {chart.gaps ? "Known gaps are left unconnected. " : ""}
              {series === "equity"
                ? "Equity includes cashflows; it is not a return."
                : "P&L is reported by the source."}
            </span>
          </figcaption>
        </figure>
      ) : (
        <div className="wd-chart-empty">
          <span aria-hidden="true">⌁</span>
          <p>No portfolio history available.</p>
        </div>
      )}
    </section>
  );
}

function CashflowRow({ item }: { item: Cashflow }) {
  const deposit = item.kind === "Deposit";
  const settled = item.withdrawalStatus === "settled";
  const status = deposit
    ? "Credited deposit"
    : settled
      ? "Settled withdrawal"
      : `Withdrawal · ${(item.withdrawalStatus ?? "status unknown").replace(/_/g, " ")}`;
  return (
    <li className="wd-history-row">
      <div
        className={`wd-event-icon ${deposit ? "wd-event-deposit" : ""}`}
        aria-hidden="true"
      >
        {deposit ? "↙" : "↗"}
      </div>
      <div className="wd-event-main">
        <strong>{status}</strong>
        <div className="wd-event-meta">
          <time
            dateTime={new Date(item.timestampMs).toISOString()}
            title={new Date(item.timestampMs).toLocaleString()}
          >
            {dateLabel(item.timestampMs, true)}
          </time>
          <TransactionLink hash={item.txHash} />
        </div>
      </div>
      <div
        className={`wd-event-amount ${deposit ? "wd-positive" : ""}`}
        title={`${exactAmount(item.amountRaw)} USDC`}
      >
        <strong>
          {deposit ? "+" : settled ? "−" : ""}
          {formatRawUsd(item.amountRaw)}
        </strong>
        <small>
          {deposit ? "USDC" : settled ? "completed" : "not settled"}
        </small>
      </div>
    </li>
  );
}

function TradeRow({
  item,
  receivedAt,
  onSelect,
}: {
  item: ClosedTrade;
  receivedAt?: number | null;
  onSelect?: () => void;
}) {
  const timestamp =
    typeof item.timestampMs === "number" ? item.timestampMs : null;
  const pnl =
    typeof item.adjustedPnlRaw === "string" ? item.adjustedPnlRaw : null;
  const symbol = typeof item.symbol === "string" ? item.symbol : "Market";
  const side =
    typeof item.isLong === "boolean"
      ? item.isLong
        ? "Long"
        : "Short"
      : "Position";
  const liquidated = item.kind === "Liquidated";
  const negative = pnl?.startsWith("-");
  const heldMs = closedHoldingTimeMs(item, receivedAt ?? Date.now());
  return (
    <li className="wd-history-row">
      <div
        className={`wd-event-icon ${liquidated ? "wd-event-liquidation" : ""}`}
        aria-hidden="true"
      >
        {liquidated ? "!" : "↗"}
      </div>
      <div className="wd-event-main">
        <strong>
          {symbol}{" "}
          <span>
            {side}
            {typeof item.leverage === "number" ? ` · ${item.leverage}×` : ""}
          </span>
        </strong>
        <div className="wd-event-meta">
          <span>
            {liquidated ? "Liquidated" : "Closed"} · {dateLabel(timestamp)}
          </span>
          {heldMs !== null && <span>Held {formatHoldingTime(heldMs)}</span>}
          <TransactionLink hash={item.txHash} />
          {onSelect && (
            <button
              type="button"
              className="wd-position-view"
              onClick={onSelect}
            >
              View position {String(item.positionId)} ↗
            </button>
          )}
        </div>
      </div>
      <div
        className={`wd-event-amount ${pnl ? (negative ? "wd-negative" : "wd-positive") : ""}`}
        title={pnl ? `${exactAmount(pnl)} USDC adjusted P&L` : undefined}
      >
        <strong>{formatRawUsd(pnl)}</strong>
        <small>adjusted P&amp;L</small>
      </div>
    </li>
  );
}

export function WalletDrawer({
  address,
  onClose,
  displayName,
}: WalletDrawerProps) {
  const { following, toggle: toggleFollowing } = useFollowing();
  const titleId = useId();
  const contentId = useId();
  const [data, setData] = useState<WalletResponse | null>(null);
  const [receipt, setReceipt] = useState<PositionReceiptSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState<HistoryTab>("cashflows");
  const [paging, setPaging] = useState<HistoryTab | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [newActivity, setNewActivity] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const pageController = useRef<AbortController | null>(null);
  const paginationInFlight = useRef(false);
  const loadedPages = useRef({ cashflows: false, trades: false });
  const dataRef = useRef(data);
  dataRef.current = data;
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!address) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const background = Array.from(document.body.children).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element !== overlayRef.current,
    );
    const priorInert = background.map((element) => element.inert);
    background.forEach((element) => {
      element.inert = true;
    });
    closeRef.current?.focus();
    function handleKey(event: globalThis.KeyboardEvent) {
      if (dialogRef.current?.querySelector("dialog[open]")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0],
        last = focusable[focusable.length - 1];
      if (!first) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !dialogRef.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !dialogRef.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = previousOverflow;
      background.forEach((element, index) => {
        element.inert = priorInert[index];
      });
      previousFocus?.focus({ preventScroll: true });
    };
  }, [Boolean(address)]);

  useEffect(() => {
    setTab("cashflows");
    setReceipt(null);
    setCopied(false);
    setCopyError(false);
    setPageError(null);
    setNewActivity(false);
    loadedPages.current = { cashflows: false, trades: false };
    dialogRef.current?.scrollTo({ top: 0 });
  }, [address]);

  useEffect(() => {
    if (!address) {
      setData(null);
      return;
    }
    const cached = walletCache.get(address.toLowerCase());
    setData((current) =>
      current?.address.toLowerCase() === address.toLowerCase()
        ? current
        : (cached ?? null),
    );
    setError(null);
    setPaging(null);
    setPageError(null);
    if (!/^0x[\da-f]{40}$/i.test(address)) {
      setError("This wallet address is not valid.");
      setLoading(false);
      return;
    }
    let active = true;
    let controller: AbortController | null = null;
    let lastRequested = 0;
    let timeout: number | undefined;
    async function refresh(background = false) {
      if (
        !active ||
        controller ||
        (background &&
          (document.visibilityState === "hidden" || paginationInFlight.current))
      )
        return;
      const request = new AbortController();
      controller = request;
      lastRequested = Date.now();
      timeout = window.setTimeout(() => request.abort("timeout"), 20_000);
      setLoading(true);
      try {
        const response = await fetchJson<WalletResponse>(
          `/api/wallets/${address}`,
          { signal: request.signal },
        );
        if (!active || request.signal.aborted) return;
        if (response.address.toLowerCase() !== address!.toLowerCase())
          throw new Error(
            "Wallet response did not match the requested address.",
          );
        const current = dataRef.current;
        let next = response;
        if (
          current &&
          current.address.toLowerCase() === response.address.toLowerCase()
        ) {
          const cashflows = loadedPages.current.cashflows
            ? mergeHistory(current.cashflows, response.cashflows, cashflowKey)
            : { page: response.cashflows, newActivity: false };
          const trades = loadedPages.current.trades
            ? mergeHistory(current.trades, response.trades, tradeKey)
            : { page: response.trades, newActivity: false };
          next = {
            ...response,
            cashflows: cashflows.page,
            trades: trades.page,
          };
          if (cashflows.newActivity || trades.newActivity) setNewActivity(true);
          if (
            current.snapshot &&
            (!response.snapshot ||
              current.snapshot.accountRevision >
                response.snapshot.accountRevision ||
              current.snapshot.indexedThroughBlock >
                response.snapshot.indexedThroughBlock ||
              current.snapshot.indexedThroughTimestamp >
                response.snapshot.indexedThroughTimestamp)
          ) {
            next.snapshot = current.snapshot;
            // Derived bands must remain attached to the snapshot they describe.
            next.marginRisk = riskMatchesSnapshot(
              current.marginRisk,
              current.snapshot,
              current.address,
            )
              ? {
                  ...current.marginRisk!,
                  stale: true,
                  snapshot: { ...current.marginRisk!.snapshot!, stale: true },
                }
              : undefined;
          }
        }
        cacheWallet({
          ...response,
          snapshot: next.snapshot,
          marginRisk: next.marginRisk,
        });
        dataRef.current = next;
        setData(next);
        setError(null);
      } catch {
        if (
          active &&
          (!request.signal.aborted || request.signal.reason === "timeout")
        )
          setError("This wallet could not be refreshed. Please try again.");
      } finally {
        window.clearTimeout(timeout);
        if (active && controller === request) {
          controller = null;
          setLoading(false);
        }
      }
    }
    void refresh();
    const interval = window.setInterval(() => {
      void refresh(true);
    }, REFRESH_INTERVAL);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") controller?.abort();
      else if (Date.now() - lastRequested >= REFRESH_INTERVAL)
        void refresh(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      window.clearTimeout(timeout);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      controller?.abort();
      pageController.current?.abort();
      paginationInFlight.current = false;
    };
  }, [address, attempt]);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 2200);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  async function copyAddress() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }

  async function loadMore() {
    if (!address || !data || paging || loading) return;
    const currentTab = tab;
    const cursor = data[currentTab].nextCursor;
    if (!cursor) return;
    pageController.current?.abort();
    const controller = new AbortController();
    pageController.current = controller;
    paginationInFlight.current = true;
    const timeout = window.setTimeout(
      () => controller.abort("timeout"),
      20_000,
    );
    setPaging(currentTab);
    setPageError(null);
    try {
      const page = await fetchJson<HistoryPage<Cashflow | ClosedTrade>>(
        `/api/wallets/${address}/${currentTab}?cursor=${encodeURIComponent(cursor)}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (page.nextCursor === cursor)
        throw new Error("Repeated history cursor");
      if (currentTab === "trades")
        rememberTradePage(page as HistoryPage<ClosedTrade>);
      loadedPages.current[currentTab] = true;
      setData((current) => {
        if (!current || current.address.toLowerCase() !== address.toLowerCase())
          return current;
        if (currentTab === "cashflows")
          return {
            ...current,
            cashflows: {
              ...current.cashflows,
              items: [
                ...current.cashflows.items,
                ...(page.items as Cashflow[]),
              ],
              nextCursor: page.nextCursor,
            },
          };
        return {
          ...current,
          trades: {
            ...current.trades,
            items: [...current.trades.items, ...(page.items as ClosedTrade[])],
            nextCursor: page.nextCursor,
          },
        };
      });
    } catch {
      if (!controller.signal.aborted || controller.signal.reason === "timeout")
        setPageError("Older activity could not be loaded. Try again.");
    } finally {
      window.clearTimeout(timeout);
      if (pageController.current === controller) {
        setPaging(null);
        paginationInFlight.current = false;
      }
    }
  }

  function handleTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next: HistoryTab =
      event.key === "Home"
        ? "cashflows"
        : event.key === "End"
          ? "trades"
          : tab === "cashflows"
            ? "trades"
            : "cashflows";
    setTab(next);
    setPageError(null);
    dialogRef.current
      ?.querySelector<HTMLButtonElement>(`[data-wallet-tab="${next}"]`)
      ?.focus();
  }

  if (!address) return null;
  const wallet =
    data?.address.toLowerCase() === address.toLowerCase() ? data : null;
  const snapshot = wallet?.snapshot;
  const followed = following.some(
    (item) => item.address === address.toLowerCase(),
  );
  const followLimit = !followed && following.length >= FOLLOWING_LIMIT;
  const selectedHistory = wallet?.[tab];
  const partial = wallet && (wallet.stale || wallet.errors.length > 0);
  const selectPosition = (position: PositionDetails, sourceStale = false) => {
    const clock =
      position.status === "open"
        ? position.provenance.asOf
        : position.provenance.receivedAt;
    const stale =
      clock === null ||
      clock > Date.now() + 30_000 ||
      Date.now() - clock > (position.status === "open" ? 30_000 : 60_000) ||
      sourceStale;
    setReceipt(freezePositionReceipt(position, displayName ?? null, stale));
  };
  const closedPosition = (item: ClosedTrade) =>
    wallet
      ? normalizeClosedPosition(item, {
          walletAddress: wallet.address,
          ...tradeReceiptSource(item, wallet.trades),
          asOf: Date.now(),
        })
      : null;
  return createPortal(
    <div
      className="wd-overlay"
      ref={overlayRef}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        className="wd-drawer"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="wd-topbar">
          <span className="wd-kicker">PAPERTRADE / WALLET</span>
          <button
            ref={closeRef}
            type="button"
            className="wd-close"
            onClick={onClose}
            aria-label="Close wallet details"
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="wd-content">
          <section className="wd-identity">
            <div className="wd-portrait" aria-hidden="true">
              <svg viewBox="0 0 80 90">
                <path
                  d="M15 69C14 52 16 35 26 27L23 12 38 22 58 13 59 31C70 47 66 64 57 70L62 88H16Z"
                  fill="currentColor"
                />
                <path
                  d="M23 42 33 46 25 50M52 42 44 46 52 50M35 56 39 59 44 55"
                  fill="none"
                  stroke="#f8f5ec"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
                <path
                  d="m6 7 5 3m56 1 7-4M6 32l6 1"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                />
              </svg>
              <span>{address.slice(2, 4).toUpperCase()}</span>
            </div>
            <div className="wd-identity-copy">
              <span className="wd-kicker">PUBLIC WALLET</span>
              <h2 id={titleId}>
                {displayName?.trim() || shortAddress(address)}
              </h2>
              <button
                type="button"
                className="wd-address"
                onClick={copyAddress}
                title={address}
                aria-label={`Copy wallet address ${address}`}
              >
                <span>{shortAddress(address)}</span>
                <span aria-hidden="true">{copied ? "✓" : "⧉"}</span>
              </button>
              <span className="wd-copy-status" role="status">
                {copied
                  ? "Address copied"
                  : copyError
                    ? "Copy unavailable. Select the address below."
                    : ""}
              </span>
              {copyError && <code className="wd-full-address">{address}</code>}
              <button
                type="button"
                className="wd-follow"
                aria-pressed={followed}
                aria-label={`${followed ? "Unfollow" : "Follow"} ${displayName?.trim() || shortAddress(address)}`}
                disabled={followLimit}
                title={
                  followLimit
                    ? "Following limit reached (100 wallets). Unfollow one to add another."
                    : "Saved on this browser"
                }
                onClick={() => toggleFollowing(address, displayName ?? null)}
              >
                <span aria-hidden="true">{followed ? "★" : "☆"}</span>{" "}
                {followed
                  ? "Following"
                  : followLimit
                    ? "Following limit reached"
                    : "Follow wallet"}
              </button>
            </div>
          </section>
          {error && (
            <div className="wd-notice wd-error" role="alert">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => setAttempt((value) => value + 1)}
                disabled={loading}
              >
                Try again ↻
              </button>
            </div>
          )}
          {loading && !wallet ? (
            <div
              className="wd-loading"
              role="status"
              aria-label="Loading wallet details"
            >
              <div className="wd-skeleton wd-skeleton-hero" />
              <div className="wd-skeleton-grid">
                {[0, 1, 2, 3].map((value) => (
                  <div key={value} className="wd-skeleton" />
                ))}
              </div>
              <div className="wd-skeleton wd-skeleton-chart" />
              <p>Loading wallet…</p>
            </div>
          ) : (
            wallet && (
              <>
                {partial && (
                  <div className="wd-notice" role="status">
                    {wallet.stale
                      ? "Showing the latest saved snapshot. Some data may be delayed."
                      : "Some sources are unavailable. Available records are shown below."}
                  </div>
                )}
                <section
                  className="wd-deposit-hero"
                  aria-label="Lifetime credited deposits"
                >
                  <span className="wd-kicker">TOTAL CREDITED DEPOSITS</span>
                  <div
                    className="wd-hero-value"
                    title={`${exactAmount(snapshot?.lifetime.depositedRaw)} USDC`}
                  >
                    {formatRawUsd(snapshot?.lifetime.depositedRaw ?? null)}
                    <span>USDC</span>
                  </div>
                  <p>Lifetime credit reported by Papertrade.</p>
                  <span className="wd-hero-star" aria-hidden="true">
                    ✳
                  </span>
                </section>
                <dl className="wd-metrics">
                  <div>
                    <dt>Available balance</dt>
                    <dd title={`${exactAmount(snapshot?.balance)} USDC`}>
                      {formatRawUsd(snapshot?.balance ?? null)}
                    </dd>
                  </div>
                  <div>
                    <dt>Locked margin</dt>
                    <dd>{formatRawUsd(snapshot?.locked ?? null)}</dd>
                  </div>
                  <div>
                    <dt>Queued claims</dt>
                    <dd>{formatRawUsd(snapshot?.queued ?? null)}</dd>
                    <span>Awaiting settlement</span>
                  </div>
                  <div>
                    <dt>PAPER balance</dt>
                    <dd title={exactAmount(snapshot?.paper.balance)}>
                      {paperAmount(snapshot?.paper.balance)}
                    </dd>
                    <span>
                      {snapshot
                        ? "Staked PAPER shown below"
                        : "No snapshot available"}
                    </span>
                  </div>
                </dl>
                <div className="wd-position-note">
                  <span>
                    Realized P&amp;L{" "}
                    <strong>
                      {formatRawUsd(snapshot?.lifetime.realizedPnlRaw ?? null)}
                    </strong>
                  </span>
                  <span>
                    {snapshot
                      ? `${snapshot.openPositions.length} open position${snapshot.openPositions.length === 1 ? "" : "s"}`
                      : "Positions unavailable"}
                  </span>
                </div>
                <section className="wd-staking" aria-label="PAPER staking">
                  <div className="wd-section-heading">
                    <h3>PAPER staking</h3>
                    <span className="wd-tiny-note">
                      {!snapshot
                        ? "UNAVAILABLE"
                        : wallet.stale
                          ? "LAST AVAILABLE"
                          : "WALLET SNAPSHOT"}
                    </span>
                  </div>
                  <dl className="wd-staking-metrics">
                    <div>
                      <dt>Amount staked</dt>
                      <dd
                        title={`${exactAmount(snapshot?.paper.staked)} PAPER`}
                      >
                        {paperAmount(snapshot?.paper.staked)}
                      </dd>
                      <span>PAPER</span>
                    </div>
                    <div>
                      <dt>Pending rewards</dt>
                      <dd aria-label="Pending rewards unavailable">—</dd>
                      <span>USDC · unavailable</span>
                    </div>
                    <div>
                      <dt>Claimed rewards</dt>
                      <dd
                        title={`${exactAmount(snapshot?.lifetime.paperRewardsClaimedRaw)} USDC`}
                      >
                        {formatRawUsd(
                          snapshot?.lifetime.paperRewardsClaimedRaw,
                        )}
                      </dd>
                      <span>USDC · lifetime</span>
                    </div>
                  </dl>
                  <p className="wd-staking-note">
                    Rewards are paid in USDC. Pending rewards aren't available
                    in this view yet.
                  </p>
                </section>
                <PositionMetrics
                  key={wallet.address}
                  wallet={wallet}
                  onPosition={selectPosition}
                />
                <WalletMarginRisk
                  key={`margin-${wallet.address}`}
                  wallet={wallet}
                  displayName={displayName}
                  onPosition={selectPosition}
                  refreshError={Boolean(error)}
                />
                <PortfolioChart history={wallet.portfolio} />
                <section className="wd-activity" aria-label="Wallet activity">
                  <div className="wd-section-heading">
                    <div>
                      <h3>Activity</h3>
                    </div>
                    <span className="wd-tiny-note">PUBLIC RECORD</span>
                  </div>
                  <div
                    className="wd-tabs"
                    role="tablist"
                    aria-label="Activity type"
                  >
                    {(["cashflows", "trades"] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        role="tab"
                        data-wallet-tab={value}
                        id={`${contentId}-${value}-tab`}
                        aria-controls={`${contentId}-${value}-panel`}
                        aria-selected={tab === value}
                        tabIndex={tab === value ? 0 : -1}
                        onKeyDown={handleTabKey}
                        onClick={() => {
                          setTab(value);
                          setPageError(null);
                        }}
                      >
                        {value === "cashflows"
                          ? "Deposits & withdrawals"
                          : "Closed trades"}
                        <span>
                          {wallet[value].items.length}
                          {wallet[value].nextCursor ? "+" : ""}
                        </span>
                      </button>
                    ))}
                  </div>
                  {(newActivity ||
                    loadedPages.current.cashflows ||
                    loadedPages.current.trades) && (
                    <button
                      type="button"
                      className="wd-new-activity"
                      disabled={Boolean(paging) || loading}
                      onClick={() => {
                        loadedPages.current = {
                          cashflows: false,
                          trades: false,
                        };
                        setNewActivity(false);
                        setAttempt((value) => value + 1);
                      }}
                    >
                      {newActivity
                        ? "History updated · refresh"
                        : "Refresh history"}
                    </button>
                  )}
                  <div
                    role="tabpanel"
                    id={`${contentId}-${tab}-panel`}
                    aria-labelledby={`${contentId}-${tab}-tab`}
                    tabIndex={0}
                  >
                    {selectedHistory?.items.length ? (
                      <ol className="wd-history">
                        {tab === "cashflows"
                          ? wallet.cashflows.items.map((item, index) => (
                              <CashflowRow
                                key={
                                  item.id ??
                                  `${item.txHash}-${item.kind}-${index}`
                                }
                                item={item}
                              />
                            ))
                          : wallet.trades.items.map((item, index) => (
                              <TradeRow
                                key={
                                  typeof item.id === "string"
                                    ? item.id
                                    : `${String(item.txHash)}-${String(item.positionId)}-${index}`
                                }
                                item={item}
                                receivedAt={
                                  tradeReceiptSource(item, wallet.trades)
                                    .receivedAt
                                }
                                onSelect={
                                  closedPosition(item)
                                    ? () => {
                                        const position = closedPosition(item);
                                        if (position)
                                          selectPosition(
                                            position,
                                            tradeReceiptSource(
                                              item,
                                              wallet.trades,
                                            ).stale,
                                          );
                                      }
                                    : undefined
                                }
                              />
                            ))}
                      </ol>
                    ) : (
                      <div className="wd-empty">
                        <span aria-hidden="true">
                          {tab === "cashflows" ? "↙" : "〰"}
                        </span>
                        <h4>
                          {selectedHistory?.coverage?.indexing
                            ? "Indexing account history…"
                            : wallet.errors.some((message) =>
                                  message
                                    .toLowerCase()
                                    .includes(
                                      tab === "cashflows"
                                        ? "cashflow"
                                        : "trade",
                                    ),
                                )
                              ? "This history is unavailable."
                              : tab === "cashflows"
                                ? "No cashflows to show yet."
                                : "No closed trades to show yet."}
                        </h4>
                      </div>
                    )}
                    {selectedHistory?.items.length &&
                    selectedHistory.coverage?.indexing ? (
                      <p className="wd-coverage wd-coverage-partial">
                        Older history is being indexed.
                      </p>
                    ) : null}
                    {pageError && (
                      <p className="wd-page-error" role="alert">
                        {pageError}
                      </p>
                    )}
                    {selectedHistory?.nextCursor && (
                      <button
                        type="button"
                        className="wd-load-more"
                        onClick={loadMore}
                        disabled={Boolean(paging) || loading}
                      >
                        {paging === tab
                          ? "Loading older activity…"
                          : "Load older activity"}
                        <span aria-hidden="true">↓</span>
                      </button>
                    )}
                  </div>
                </section>
                <footer className="wd-footer">
                  <div>
                    <span
                      className={`wd-freshness-dot ${wallet.stale ? "wd-stale-dot" : ""}`}
                      aria-hidden="true"
                    />
                    <span>
                      {wallet.stale ? "Saved snapshot" : "Snapshot"} ·{" "}
                      {relativeTime(wallet.receivedAt)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setAttempt((value) => value + 1)}
                      disabled={loading}
                      aria-label="Refresh wallet details"
                    >
                      {loading ? "Refreshing…" : "Refresh ↻"}
                    </button>
                  </div>
                  <p>
                    Refreshes every 15 seconds while visible. Public,
                    source-reported records. Deposit credit is distinct from
                    gross funds sent. History may be incomplete.
                  </p>
                </footer>
              </>
            )
          )}
        </div>
        {receipt && (
          <PositionReceiptDialog
            snapshot={receipt}
            onClose={() => setReceipt(null)}
          />
        )}
      </aside>
    </div>,
    document.body,
  );
}

export default WalletDrawer;
