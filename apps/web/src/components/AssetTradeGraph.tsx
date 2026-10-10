import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { TradeEvent } from "../../../../packages/shared/src/types";
import { formatUsd, relativeTime, shortAddress } from "../lib/format";
import {
  GRAPH_PRICE_GAP_MS,
  GRAPH_TRADE_LIMIT,
  graphBubbleRadius,
  graphExecutionPrice,
  graphPriceExtent,
  graphPricePath,
  graphPrices,
  graphTrades,
  type GraphPricePoint,
} from "../lib/trade-graph";
import { Avatar } from "./Avatar";
import "./asset-trade-graph.css";

type PricedTrade = TradeEvent;
export interface AssetTradeGraphProps {
  instrument: number;
  symbol: string;
  points: GraphPricePoint[];
  trades: PricedTrade[];
  price: { priceUsd: number; sourceAt: number; receivedAt: number } | null;
  receivedAt: number | null;
  stale: boolean;
  connected: boolean;
  tradesCapped: boolean;
  onWallet: (address: string) => void;
}

const windows = [
  { label: "5m", ms: 300_000 },
  { label: "15m", ms: 900_000 },
  { label: "1h", ms: 3_600_000 },
];
const action = (trade: TradeEvent) =>
  trade.kind === "open"
    ? "Opened"
    : trade.kind === "close"
      ? "Closed"
      : "Liquidated";
const clockLabel = (time: number) =>
  new Date(time).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

function useVisibleClock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const update = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (!document.hidden) {
        setNow(Date.now());
        timer = setInterval(() => setNow(Date.now()), 1_000);
      }
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return now;
}

/** Pure local rendering; all source requests and SSE remain owned by the app. */
export function AssetTradeGraph(props: AssetTradeGraphProps) {
  const { instrument, symbol, onWallet } = props;
  const now = useVisibleClock();
  const [range, setRange] = useState(900_000);
  const [frozen, setFrozen] = useState<{
    at: number;
    instrument: number;
    data: AssetTradeGraphProps;
  } | null>(null);
  const paused = frozen?.instrument === instrument;
  const data = paused ? frozen.data : props;
  const through = paused ? frozen.at : now;
  const from = through - range;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLUListElement>(null);
  const feedRows = useRef(new Map<string, HTMLLIElement>());
  const [width, setWidth] = useState(640);
  const id = useId().replaceAll(":", "");
  const clipId = `${id}-clip`;
  const descriptionId = `${id}-description`;

  useEffect(() => {
    const element = chartRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(220, Math.floor(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setSelectedId(null);
    setHoveredId(null);
    if (feedRef.current) feedRef.current.scrollTop = 0;
  }, [instrument, range]);

  const prices = useMemo(() => {
    const latest = data.price;
    return graphPrices(
      latest
        ? [...data.points, { time: latest.sourceAt, priceUsd: latest.priceUsd }]
        : data.points,
      from,
      through,
    );
  }, [data.points, data.price, from, through]);
  const trades = useMemo(
    () => graphTrades(data.trades, instrument, from, through) as PricedTrade[],
    [data.trades, instrument, from, through],
  );
  const plotted = useMemo(
    () =>
      trades.filter(
        (trade) => graphExecutionPrice(trade) !== null && trade.notionalUsd > 0,
      ),
    [trades],
  );
  const extent = useMemo(
    () =>
      graphPriceExtent([
        ...prices,
        ...plotted.map((trade) => ({
          time: trade.ts,
          priceUsd: graphExecutionPrice(trade)!,
        })),
      ]),
    [prices, plotted],
  );
  const activeId = hoveredId ?? selectedId;
  const active = trades.find((trade) => trade.id === activeId) ?? null;
  const largest = Math.max(1, ...plotted.map((trade) => trade.notionalUsd));
  const latest = prices.at(-1);
  const previousTopology = useRef("");
  const topology = prices
    .map((point, index) =>
      index === 0 ||
      point.gapBefore ||
      point.time - prices[index - 1].time > GRAPH_PRICE_GAP_MS
        ? "M"
        : "L",
    )
    .join("");
  const canMorphLine = topology === previousTopology.current;
  useEffect(() => {
    previousTopology.current = topology;
  }, [topology]);
  const height = width < 450 ? 300 : 340;
  const padding = { left: 12, right: 73, top: 25, bottom: 32 };
  const plotRight = width - padding.right;
  const plotBottom = height - padding.bottom;
  const x = (time: number) =>
    padding.left + ((time - from) / range) * (plotRight - padding.left);
  const y = (price: number) =>
    extent
      ? plotBottom -
        ((price - extent[0]) / (extent[1] - extent[0])) *
          (plotBottom - padding.top)
      : plotBottom;
  const pricePath = graphPricePath(prices, x, y);
  const priceDelayed =
    data.stale || !data.price || now - data.price.sourceAt > GRAPH_PRICE_GAP_MS;
  const displayPrice =
    data.price &&
    Number.isFinite(data.price.priceUsd) &&
    data.price.priceUsd > 0
      ? data.price.priceUsd
      : null;
  const missingPrices = trades.length - plotted.length;
  const capped =
    data.tradesCapped ||
    data.trades.filter(
      (trade) =>
        trade.instrument === instrument &&
        trade.ts >= from &&
        trade.ts <= through,
    ).length > GRAPH_TRADE_LIMIT;

  const selectTrade = (trade: PricedTrade) => {
    setSelectedId(trade.id);
    setHoveredId(null);
    const list = feedRef.current;
    const row = feedRows.current.get(trade.id);
    if (list && row) {
      const listBox = list.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      if (rowBox.top < listBox.top || rowBox.bottom > listBox.bottom)
        list.scrollTo({
          top: list.scrollTop + rowBox.top - listBox.top - 8,
          behavior: "auto",
        });
    }
  };

  return (
    <section className="trade-graph" aria-label={`${symbol} price and trades`}>
      <div className="trade-graph-heading">
        <div>
          <h3>{symbol} price</h3>
          <span className="trade-graph-reference">Reference price</span>
          <strong className="trade-graph-price">
            {formatUsd(displayPrice)}
          </strong>
        </div>
        <div className="trade-graph-controls">
          <span
            className={`trade-graph-status ${priceDelayed ? "delayed" : ""}`}
          >
            <i />
            {paused
              ? "Paused"
              : priceDelayed
                ? "Delayed"
                : data.connected
                  ? "Live"
                  : "Updating"}
          </span>
          <div
            className="trade-graph-ranges"
            role="group"
            aria-label="Price chart window"
          >
            {windows.map((window) => (
              <button
                key={window.label}
                type="button"
                aria-pressed={range === window.ms}
                onClick={() => setRange(window.ms)}
              >
                {window.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="trade-graph-pause"
            onClick={() => {
              setFrozen(paused ? null : { at: now, instrument, data: props });
              setHoveredId(null);
            }}
          >
            {paused ? "Resume live chart" : "Pause chart"}
          </button>
        </div>
      </div>
      <div className="trade-graph-layout">
        <div className="trade-graph-main">
          <div className="trade-graph-legend">
            <span className="reference">Reference</span>
            <span className="long">Long</span>
            <span className="short">Short</span>
            <small>Bubble area ≈ notional</small>
          </div>
          <div ref={chartRef} className="trade-graph-canvas">
            {extent ? (
              <svg
                viewBox={`0 0 ${width} ${height}`}
                width="100%"
                height={height}
                role="group"
                tabIndex={0}
                aria-label={`${symbol} reference price and execution bubbles`}
                aria-describedby={descriptionId}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setSelectedId(null);
                    setHoveredId(null);
                  }
                  if (
                    !plotted.length ||
                    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                      event.key,
                    )
                  )
                    return;
                  event.preventDefault();
                  const current = plotted.findIndex(
                    (trade) => trade.id === selectedId,
                  );
                  const next =
                    event.key === "Home"
                      ? plotted.length - 1
                      : event.key === "End"
                        ? 0
                        : event.key === "ArrowLeft"
                          ? Math.min(plotted.length - 1, current + 1)
                          : Math.max(0, current - 1);
                  selectTrade(plotted[next]);
                }}
              >
                <defs>
                  <clipPath id={clipId}>
                    <rect
                      x={padding.left - 1}
                      y={0}
                      width={plotRight - padding.left + 2}
                      height={plotBottom + 1}
                    />
                  </clipPath>
                </defs>
                {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
                  const value = extent[0] + (extent[1] - extent[0]) * fraction;
                  return (
                    <g key={fraction} className="trade-graph-grid">
                      <line
                        x1={padding.left}
                        x2={plotRight}
                        y1={y(value)}
                        y2={y(value)}
                      />
                      <text x={plotRight + 11} y={y(value) + 3}>
                        {formatUsd(value)}
                      </text>
                    </g>
                  );
                })}
                <g clipPath={`url(#${clipId})`}>
                  <path
                    className={`trade-graph-line ${canMorphLine ? "can-morph" : ""}`}
                    d={pricePath}
                    style={{ d: `path("${pricePath}")` } as CSSProperties}
                  />
                  {active && graphExecutionPrice(active) !== null && (
                    <g className="trade-graph-crosshair">
                      <line
                        x1={x(active.ts)}
                        x2={x(active.ts)}
                        y1={padding.top}
                        y2={plotBottom}
                      />
                      <line
                        x1={padding.left}
                        x2={plotRight}
                        y1={y(graphExecutionPrice(active)!)}
                        y2={y(graphExecutionPrice(active)!)}
                      />
                    </g>
                  )}
                  {[...plotted].reverse().map((trade) => (
                    <g
                      key={trade.id}
                      className={`trade-graph-bubble ${trade.side} ${activeId === trade.id ? "is-active" : ""}`}
                      role="button"
                      tabIndex={-1}
                      aria-label={`${action(trade)} ${symbol} ${trade.side}, ${formatUsd(trade.notionalUsd)} notional, wallet ${shortAddress(trade.wallet)}`}
                      aria-pressed={activeId === trade.id}
                      style={{
                        transform: `translate(${x(trade.ts)}px,${y(graphExecutionPrice(trade)!)}px)`,
                      }}
                      onPointerEnter={() => setHoveredId(trade.id)}
                      onPointerLeave={() => setHoveredId(null)}
                      onFocus={() => selectTrade(trade)}
                      onClick={() => selectTrade(trade)}
                    >
                      <circle
                        className="trade-graph-hit"
                        r={Math.max(
                          12,
                          graphBubbleRadius(trade.notionalUsd, largest),
                        )}
                      />
                      <circle
                        r={graphBubbleRadius(trade.notionalUsd, largest)}
                      />
                    </g>
                  ))}
                  {latest && (
                    <circle
                      className={`trade-graph-edge ${!paused && !priceDelayed ? "is-live" : ""}`}
                      cx={x(latest.time)}
                      cy={y(latest.priceUsd)}
                      r="3.5"
                    />
                  )}
                </g>
                {[0, 0.5, 1].map((fraction) => (
                  <text
                    className="trade-graph-time"
                    key={fraction}
                    x={x(from + range * fraction)}
                    y={height - 8}
                    textAnchor={
                      fraction === 0
                        ? "start"
                        : fraction === 1
                          ? "end"
                          : "middle"
                    }
                  >
                    {clockLabel(from + range * fraction)}
                  </text>
                ))}
              </svg>
            ) : (
              <div className="trade-graph-empty">
                <strong>Waiting for price observations</strong>
                <span>
                  Trades appear in the feed while prices are unavailable.
                </span>
              </div>
            )}
          </div>
          <div
            className="trade-graph-inspect"
            aria-live="polite"
            aria-atomic="true"
          >
            {active ? (
              <>
                <button
                  type="button"
                  onClick={() => onWallet(active.wallet)}
                  className="trade-graph-selected-wallet"
                >
                  <Avatar address={active.wallet} />
                  <span>
                    {shortAddress(active.wallet)}
                    <small>View wallet ↗</small>
                  </span>
                </button>
                <span className={active.side}>
                  {action(active)} {active.side}
                  <small>{new Date(active.ts).toLocaleTimeString()}</small>
                </span>
                <span>
                  {formatUsd(active.notionalUsd, true)}
                  <small>Notional</small>
                </span>
                <span>
                  {formatUsd(graphExecutionPrice(active))}
                  <small>Execution price</small>
                </span>
              </>
            ) : (
              <span className="trade-graph-select-hint">
                Select a bubble or a trade to inspect it.
              </span>
            )}
          </div>
          <p className="trade-graph-note" id={descriptionId}>
            Line: reference price · bubbles: execution price.
            {missingPrices > 0
              ? ` ${missingPrices} ${missingPrices === 1 ? "trade without a valid price or notional appears" : "trades without valid prices or notionals appear"} in the feed only.`
              : ""}
            <span className="sr-only">
              {" "}
              Arrow keys select trades; Escape clears selection.
            </span>
          </p>
          {!prices.length && extent && (
            <p className="trade-graph-note">
              Reference price history is unavailable. Only priced executions are
              plotted.
            </p>
          )}
        </div>
        <aside
          className="trade-graph-feed"
          aria-label={`${symbol} chart trade feed`}
        >
          <div className="trade-graph-feed-heading">
            <h4>
              Trades <span>{trades.length}</span>
            </h4>
            <small>
              {paused
                ? "Paused"
                : data.connected && !data.stale
                  ? "Live observations"
                  : "Retained observations"}
            </small>
          </div>
          <ul ref={feedRef}>
            {trades.map((trade) => (
              <li
                key={trade.id}
                ref={(element) => {
                  if (element) feedRows.current.set(trade.id, element);
                  else feedRows.current.delete(trade.id);
                }}
                data-trade-id={trade.id}
                className={activeId === trade.id ? "is-active" : ""}
                onPointerEnter={() => setHoveredId(trade.id)}
                onPointerLeave={() => setHoveredId(null)}
              >
                <button
                  type="button"
                  className="trade-graph-feed-wallet"
                  onFocus={() => setSelectedId(trade.id)}
                  onClick={() => onWallet(trade.wallet)}
                  aria-label={`View wallet ${shortAddress(trade.wallet)}, ${action(trade).toLowerCase()} ${trade.side}`}
                >
                  <Avatar address={trade.wallet} />
                  <span>
                    <strong>{shortAddress(trade.wallet)}</strong>
                    <small className={trade.side}>
                      {action(trade)} {trade.side} ·{" "}
                      {trade.leverage.toLocaleString()}×
                    </small>
                  </span>
                </button>
                <button
                  type="button"
                  className="trade-graph-feed-value"
                  onFocus={() => setSelectedId(trade.id)}
                  onClick={() => selectTrade(trade)}
                  aria-label={`Inspect ${action(trade).toLowerCase()} ${trade.side} trade ${trade.id}`}
                  aria-pressed={activeId === trade.id}
                >
                  <strong>{formatUsd(trade.notionalUsd, true)}</strong>
                  <time dateTime={new Date(trade.ts).toISOString()}>
                    {paused ? clockLabel(trade.ts) : relativeTime(trade.ts)}
                  </time>
                </button>
              </li>
            ))}
            {!trades.length && (
              <li className="trade-graph-feed-empty">
                No observed trades in this window.
              </li>
            )}
          </ul>
          <p>
            {capped ? `${trades.length} recent trades shown · ` : ""}Partial
            public activity
            {data.receivedAt ? ` · ${relativeTime(data.receivedAt)}` : ""}
          </p>
        </aside>
      </div>
    </section>
  );
}
