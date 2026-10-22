import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type {
  AssetMarketResponse,
  MarketActivity,
  MarketSegment,
  MarketTradeSample,
  MarketWindow,
  TradeEvent,
} from "../../../../packages/shared/src/types";
import { MARKET_WINDOWS, selectMarketSample } from "../lib/market-sample";
import { formatUsd, relativeTime, shortAddress } from "../lib/format";
import { formatAxisTick } from "../lib/chart-axis";
import {
  GRAPH_PRICE_GAP_MS,
  GRAPH_TRADE_LIMIT,
  graphBubbleRadius,
  graphExecutionPrice,
  graphPriceAxis,
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
  chartSample?: MarketTradeSample;
  window: MarketWindow;
  onWindowChange: (window: MarketWindow) => void;
  activity: MarketActivity;
  onActivityChange: (activity: MarketActivity) => void;
  segment: MarketSegment;
  onSegmentChange: (segment: MarketSegment) => void;
  minPnlUsd: number;
  onMinPnlChange: (minPnlUsd: number) => void;
  segmentCoverage?: AssetMarketResponse["segmentCoverage"];
  segmentUnavailable: boolean;
  price: { priceUsd: number; sourceAt: number; receivedAt: number } | null;
  receivedAt: number | null;
  stale: boolean;
  freshness?: AssetMarketResponse["freshness"];
  connected: boolean;
  tradesCapped: boolean;
  onWallet: (address: string) => void;
}

const windows = Object.keys(MARKET_WINDOWS) as MarketWindow[];
const action = (trade: TradeEvent) =>
  trade.kind === "open"
    ? "Opened"
    : trade.kind === "close"
      ? "Closed"
      : "Liquidated";
const activityLabels = {
  all: { noun: "trades", heading: "activity", wallets: "trading" },
  entries: { noun: "entries", heading: "entries", wallets: "opening" },
  exits: { noun: "exits", heading: "exits", wallets: "exiting" },
} as const;
const realizedPnl = (trade: TradeEvent) =>
  typeof trade.pnlUsd === "number" && Number.isFinite(trade.pnlUsd)
    ? `${trade.pnlUsd > 0 ? "+" : ""}${formatUsd(trade.pnlUsd)}`
    : "Unavailable";

/** Diamond and circle enclose the same area for the same observed notional. */
function TradeMarker({ kind, radius }: { kind: TradeEvent["kind"]; radius: number }) {
  if (kind === "open") return <circle className="trade-graph-shape" r={radius} />;
  const diagonal = radius * Math.sqrt(Math.PI / 2);
  const cross = diagonal * 0.34;
  return (
    <>
      <path
        className="trade-graph-shape"
        d={`M0,${-diagonal} L${diagonal},0 L0,${diagonal} L${-diagonal},0 Z`}
      />
      {kind === "liq" && (
        <path
          className="trade-graph-liquidation-cross"
          d={`M${-cross},${-cross} L${cross},${cross} M${-cross},${cross} L${cross},${-cross}`}
        />
      )}
    </>
  );
}

function LegendMarker({ kind }: { kind: TradeEvent["kind"] }) {
  return (
    <svg viewBox="-8 -8 16 16" width="14" height="14" aria-hidden="true">
      <TradeMarker kind={kind} radius={4.5} />
    </svg>
  );
}
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
  const range = MARKET_WINDOWS[props.window];
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
  }, [instrument, range, props.activity, props.segment, props.minPnlUsd]);

  useEffect(() => {
    // A pause belongs to one asset; returning to it must not revive old data.
    setFrozen(null);
  }, [instrument]);

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
  const sampled = Boolean(data.chartSample);
  const trades = useMemo(() => {
    const recent = graphTrades(data.trades, instrument, from, through);
    if (!data.chartSample) return recent;
    const selected = selectMarketSample(
      data.chartSample.trades,
      [],
      instrument,
      data.window,
      through,
    );
    // Unpriced executions remain inspectable, but never consume a priced
    // sample slot or borrow a position on the reference-price line.
    const unpriced = recent
      .filter((trade) => graphExecutionPrice(trade) === null)
      .slice(0, 20);
    return [...selected, ...unpriced].sort(
      (a, b) => b.ts - a.ts || b.id.localeCompare(a.id),
    );
  }, [
    data.chartSample,
    data.trades,
    data.window,
    instrument,
    from,
    through,
  ]);
  const plotted = useMemo(
    () =>
      trades.filter(
        (trade) => graphExecutionPrice(trade) !== null && trade.notionalUsd > 0,
      ),
    [trades],
  );
  const axis = useMemo(
    () =>
      graphPriceAxis([
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
    axis
      ? plotBottom - axis.position(price) * (plotBottom - padding.top)
      : plotBottom;
  const pricePath = graphPricePath(prices, x, y);
  const priceDelayed =
    !data.price ||
    !Number.isFinite(data.price.priceUsd) ||
    data.price.priceUsd <= 0 ||
    !Number.isSafeInteger(data.price.sourceAt) ||
    !Number.isSafeInteger(data.price.receivedAt) ||
    data.price.sourceAt > now + GRAPH_PRICE_GAP_MS ||
    data.price.receivedAt > now + GRAPH_PRICE_GAP_MS ||
    now - data.price.sourceAt > GRAPH_PRICE_GAP_MS ||
    now - data.price.receivedAt > GRAPH_PRICE_GAP_MS;
  const tradeDelayed =
    (data.freshness?.delayed ?? data.stale) ||
    !Number.isSafeInteger(data.receivedAt) ||
    data.receivedAt! > now + 30_000 ||
    // Match the current snapshot's 20s client lease; healthy reconciliation
    // can take 15–18s while live trade/quote events continue to arrive.
    now - data.receivedAt! >= 20_000;
  const displayPrice =
    data.price &&
    Number.isFinite(data.price.priceUsd) &&
    data.price.priceUsd > 0
      ? data.price.priceUsd
      : null;
  const missingPrices = trades.length - plotted.length;
  const capped =
    !sampled &&
    (data.tradesCapped ||
      data.trades.filter(
        (trade) =>
          trade.instrument === instrument &&
          trade.ts >= from &&
          trade.ts <= through,
      ).length > GRAPH_TRADE_LIMIT);
  const coverage = data.segment === "profitable" ? data.segmentCoverage : undefined;
  const coveragePercent = coverage && coverage.observedWallets > 0
    ? Math.min(
        coverage.unknownWallets > 0 ? 99.9 : 100,
        (coverage.classifiedWallets / coverage.observedWallets) * 100,
      ).toLocaleString(undefined, { maximumFractionDigits: 1 })
    : null;
  const profitRequirement = data.minPnlUsd > 0
    ? `with at least ${formatUsd(data.minPnlUsd, true)} realized profit`
    : "with positive realized profit";
  const activityLabel = activityLabels[data.activity];
  const priceLabel = (trade: TradeEvent) =>
    trade.kind === "open" ? "Entry price" : "Exit price";
  const tradeDescription = (trade: TradeEvent) =>
    `${action(trade)} ${symbol} ${trade.side}, ${formatUsd(trade.notionalUsd)} notional, ${priceLabel(trade).toLowerCase()} ${graphExecutionPrice(trade) === null ? "unavailable" : formatUsd(graphExecutionPrice(trade))}${trade.kind === "open" ? "" : `, realized P&L ${realizedPnl(trade)}`}, wallet ${shortAddress(trade.wallet)}`;

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
  const openTradeWallet = (trade: PricedTrade) => {
    selectTrade(trade);
    onWallet(trade.wallet);
  };

  return (
    <section className="trade-graph" aria-label={`${symbol} price and trades`}>
      <div className="trade-graph-heading">
        <div>
          <h3>{symbol} price</h3>
          <span className="trade-graph-reference">Hyperliquid midpoint</span>
          <strong className="trade-graph-price">
            {formatUsd(displayPrice)}
          </strong>
          <span className="trade-graph-quote-age">
            {data.price
              ? `Last quote · ${relativeTime(data.price.sourceAt)}`
              : "Waiting for a quote"}
          </span>
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
                key={window}
                type="button"
                aria-pressed={props.window === window}
                disabled={paused}
                title={
                  paused ? "Resume the chart to change its window" : undefined
                }
                onClick={() => props.onWindowChange(window)}
              >
                {window}
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
      <div className="trade-graph-toolbar">
        <div className="trade-graph-trader-filter">
          <span className="trade-graph-filter-label">Activity</span>
          <div
            className="trade-graph-ranges"
            role="group"
            aria-label="Trade activity"
          >
            {(["all", "entries", "exits"] as const).map((activity) => (
              <button
                key={activity}
                type="button"
                aria-label={activity === "all" ? "Entries and exits" : activity === "entries" ? "Entries only" : "Exits and liquidations"}
                aria-pressed={props.activity === activity}
                disabled={paused}
                title={paused ? "Resume the chart to change its activity" : activity === "exits" ? "Closes and liquidations" : undefined}
                onClick={() => props.onActivityChange(activity)}
              >
                {activity === "all" ? "Both" : activity === "entries" ? "Entries" : "Exits"}
              </button>
            ))}
          </div>
        </div>
        <div className="trade-graph-trader-filter">
          <span className="trade-graph-filter-label">Traders</span>
          <div
            className="trade-graph-ranges"
            role="group"
            aria-label="Trader segment"
          >
            {(["all", "profitable"] as const).map((segment) => (
              <button
                key={segment}
                type="button"
                aria-label={
                  segment === "all" ? "All traders" : "Profitable traders"
                }
                aria-pressed={props.segment === segment}
                disabled={paused}
                title={
                  paused ? "Resume the chart to change its traders" : undefined
                }
                onClick={() => props.onSegmentChange(segment)}
              >
                {segment === "all" ? "All" : "Profitable"}
              </button>
            ))}
          </div>
        </div>
        {props.segment === "profitable" && (
          <label className="trade-graph-segment">
            <span>Min. realized profit</span>
            <select
              aria-label="Minimum realized profit"
              value={props.minPnlUsd}
              disabled={paused}
              title="Lifetime realized trading profit in USD; excludes rewards and unrealized P&L"
              onChange={(event) =>
                props.onMinPnlChange(Number(event.target.value))
              }
            >
              <option value={0}>Any profit</option>
              <option value={1_000}>$1,000+</option>
              <option value={10_000}>$10,000+</option>
              <option value={100_000}>$100,000+</option>
            </select>
          </label>
        )}
        <span className="trade-graph-filter-summary">
          {data.segment === "profitable"
            ? coverage
              ? coverage.observedWallets === 0
                ? `No ${activityLabel.wallets} wallets observed · past hour`
                : coverage.classifiedWallets === 0
                  ? "Profit checks pending · past hour"
                  : `${coverage.profitableWallets.toLocaleString()} confirmed qualifying ${coverage.profitableWallets === 1 ? "wallet" : "wallets"} · past hour`
              : "Checking trader profitability…"
            : data.activity === "all" ? "All observed entries, exits & liquidations" : data.activity === "entries" ? "Observed entries" : "Observed exits, including liquidations"}
        </span>
      </div>
      <div className="trade-graph-layout">
        <div className="trade-graph-main">
          <div className="trade-graph-legend" aria-label="Chart legend">
            <div className="trade-graph-legend-kinds">
              <span className="reference">Reference</span>
              <span><LegendMarker kind="open" />Entry</span>
              <span><LegendMarker kind="close" />Exit</span>
              <span><LegendMarker kind="liq" />Liquidation</span>
            </div>
            <div className="trade-graph-legend-sides">
              <span className="long">Long</span>
              <span className="short">Short</span>
              <small>Color = position side · area ≈ notional</small>
            </div>
          </div>
          <div ref={chartRef} className="trade-graph-canvas">
            {axis ? (
              <svg
                key={instrument}
                viewBox={`0 0 ${width} ${height}`}
                width="100%"
                height={height}
                role="group"
                tabIndex={0}
                aria-label={`${symbol} reference price and execution markers`}
                aria-describedby={descriptionId}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    const selected = plotted.find((trade) => trade.id === selectedId);
                    if (selected) {
                      event.preventDefault();
                      openTradeWallet(selected);
                    }
                    return;
                  }
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
                {axis.ticks.map((value) => {
                  return (
                    <g key={value} className="trade-graph-grid">
                      <line
                        x1={padding.left}
                        x2={plotRight}
                        y1={y(value)}
                        y2={y(value)}
                      />
                      <text x={plotRight + 11} y={y(value) + 3}>
                        {formatAxisTick(value, axis.ticks, {
                          compact: false,
                          currency: true,
                        })}
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
                      className={`trade-graph-bubble ${trade.side} trade-graph-${trade.kind} ${activeId === trade.id ? "is-active" : ""}`}
                      data-trade-kind={trade.kind}
                      role="button"
                      tabIndex={-1}
                      aria-label={tradeDescription(trade)}
                      aria-pressed={activeId === trade.id}
                      style={{
                        transform: `translate(${x(trade.ts)}px,${y(graphExecutionPrice(trade)!)}px)`,
                      }}
                      onPointerEnter={() => setHoveredId(trade.id)}
                      onPointerLeave={() => setHoveredId(null)}
                      onFocus={() => selectTrade(trade)}
                      onClick={() => openTradeWallet(trade)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          event.stopPropagation();
                          openTradeWallet(trade);
                        }
                      }}
                    >
                      <circle
                        className="trade-graph-hit"
                        r={Math.max(
                          16,
                          graphBubbleRadius(trade.notionalUsd, largest) * (trade.kind === "open" ? 1 : Math.sqrt(Math.PI / 2)),
                        )}
                      />
                      <TradeMarker kind={trade.kind} radius={graphBubbleRadius(trade.notionalUsd, largest)} />
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
                  {graphExecutionPrice(active) === null ? "Unavailable" : formatUsd(graphExecutionPrice(active))}
                  <small>{priceLabel(active)}</small>
                </span>
                {active.kind !== "open" && <span>
                  {realizedPnl(active)}
                  <small>Realized P&L</small>
                </span>}
              </>
            ) : (
              <span className="trade-graph-select-hint">
                Hover a marker to inspect. Click a marker to open its wallet.
              </span>
            )}
          </div>
          <p className="trade-graph-note" id={descriptionId}>
            Line: Hyperliquid bid/ask midpoint · markers: execution price.
            {sampled
              ? ` Up to 2 largest observed priced trades per ${data.chartSample!.bucketMs / 1000}s across ${data.window}.`
              : " Recent observations only; full-window trade sampling is not available."}
            {missingPrices > 0
              ? ` ${missingPrices} ${missingPrices === 1 ? "trade without a valid price or notional appears" : "trades without valid prices or notionals appear"} in the feed only.`
              : ""}
            <span className="sr-only">
              {" "}
              Arrow keys inspect trades; Escape clears selection. Activate a
              marker with Enter or Space to open its wallet.
            </span>
          </p>
          {data.segment === "profitable" && (
            <p className="trade-graph-note trade-graph-segment-note">
              {data.activity === "entries" ? "Entries" : data.activity === "exits" ? "Exits, including liquidations," : "Entries and exits"} by wallets with {data.minPnlUsd > 0
                ? `at least ${formatUsd(data.minPnlUsd, true)} in lifetime realized trading profit.`
                : "positive lifetime realized trading P&L."}{" "}
              Rewards and unrealized P&L excluded. Classification uses the latest
              retained account snapshot, not profitability at the time of the trade.
              {coverage
                ? ` Classified ${relativeTime(coverage.classifiedAt)}. Account snapshots were at most 5 minutes old when classified. Trades update with each classified snapshot.`
                : " Classification unavailable; trades are hidden until a recent snapshot is available."}
            </p>
          )}
          {data.activity !== "entries" && <p className="trade-graph-note">
            Exits include closes and liquidations. Color identifies the position side;
            realized P&L is shown only when supplied by the trade source.
          </p>}
          {!prices.length && axis && (
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
              {data.segment === "profitable"
                ? `Profitable trader ${activityLabel.heading}`
                : sampled
                  ? `Largest observed ${activityLabel.noun}`
                  : `Recent observed ${activityLabel.noun}`}{" "}
              <span>{data.segment === "profitable"
                ? data.segmentUnavailable
                  ? "Unavailable"
                  : coverage?.classifiedWallets === 0 && coverage.unknownWallets > 0
                    ? "Checking profit…"
                    : `${trades.length} confirmed`
                : trades.length}</span>
            </h4>
            <small>
              {paused
                ? "Paused"
                : data.segment === "profitable"
                  ? data.segmentUnavailable
                    ? "Classification unavailable"
                    : tradeDelayed
                      ? "Trade coverage delayed"
                      : "Classified snapshot"
                  : tradeDelayed
                    ? "Trade snapshot delayed"
                    : data.connected
                      ? "Live observations"
                      : "Retained observations"}
              {data.freshness?.historyGap ? " · history gap" : ""}
            </small>
          </div>
          {data.segment === "profitable" && (
            <div className="trade-graph-coverage" aria-label="Trader profit coverage">
              {coverage ? <>
                <strong>
                  Profit checked for {coverage.classifiedWallets.toLocaleString()} of {coverage.observedWallets.toLocaleString()} wallets
                </strong>
                <span>
                  {activityLabel.wallets[0].toUpperCase() + activityLabel.wallets.slice(1)} wallets · past hour{coveragePercent !== null ? ` · ${coveragePercent}%` : ""}
                </span>
                {coverage.observedWallets > 0 && (
                  <progress
                    aria-label={`Profit checked for ${activityLabel.wallets} wallets in the past hour`}
                    value={coverage.classifiedWallets}
                    max={coverage.observedWallets}
                  />
                )}
                <span className={coverage.unknownWallets > 0 ? "trade-graph-coverage-incomplete" : undefined}>
                  {coverage.unknownWallets > 0
                    ? `${coverage.unknownWallets.toLocaleString()} unknown ${coverage.unknownWallets === 1 ? "wallet" : "wallets"} excluded; more may qualify.`
                    : coverage.observedWallets > 0
                      ? `All observed ${activityLabel.wallets} wallets checked.`
                      : `No ${activityLabel.wallets} wallets observed in the past hour.`}
                </span>
              </> : <>
                <strong>Profit coverage unavailable</strong>
                <span>Trades are hidden until a recent classification is available.</span>
              </>}
            </div>
          )}
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
                  aria-label={`View wallet, ${tradeDescription(trade)}`}
                >
                  <Avatar address={trade.wallet} />
                  <span>
                    <strong>{shortAddress(trade.wallet)}</strong>
                    <small className={trade.side}>
                      {action(trade)} {trade.side} ·{" "}
                      {trade.leverage.toLocaleString()}×
                    </small>
                    <small className="trade-graph-feed-detail">
                      {priceLabel(trade)} {graphExecutionPrice(trade) === null ? "unavailable" : formatUsd(graphExecutionPrice(trade))}
                    </small>
                    {trade.kind !== "open" && <small className="trade-graph-feed-detail">
                      P&L {realizedPnl(trade).toLowerCase()}
                    </small>}
                  </span>
                </button>
                <button
                  type="button"
                  className="trade-graph-feed-value"
                  onFocus={() => setSelectedId(trade.id)}
                  onClick={() => selectTrade(trade)}
                  aria-label={`Inspect ${action(trade).toLowerCase()} ${trade.side} trade ${trade.id}, ${priceLabel(trade).toLowerCase()} ${graphExecutionPrice(trade) === null ? "unavailable" : formatUsd(graphExecutionPrice(trade))}${trade.kind === "open" ? "" : `, realized P&L ${realizedPnl(trade)}`}`}
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
                {data.segmentUnavailable
                  ? "Waiting for a recent trader classification."
                  : data.segment === "profitable"
                    ? coverage?.observedWallets === 0
                      ? `No ${activityLabel.wallets} wallets observed in the past hour.`
                      : coverage && coverage.unknownWallets > 0
                        ? `No confirmed ${activityLabel.noun} from wallets ${profitRequirement} in this window. Profit is still unknown for ${coverage.unknownWallets.toLocaleString()} observed ${coverage.unknownWallets === 1 ? "wallet" : "wallets"}, so this is not a complete count.`
                        : `No observed ${activityLabel.noun} from wallets ${profitRequirement} in this window. Try a lower profit minimum or a wider window.`
                    : sampled
                      ? `No sampled ${activityLabel.noun} in the selected window.`
                      : `No recent observed ${activityLabel.noun} in the selected window.`}
              </li>
            )}
          </ul>
          <p>
            {sampled
              ? `Selected across ${data.window} · `
              : capped
                ? `${trades.length} recent trades shown · `
                : ""}
            Observed {activityLabel.noun} only · history may be incomplete
            {data.receivedAt ? ` · ${relativeTime(data.receivedAt)}` : ""}
          </p>
        </aside>
      </div>
    </section>
  );
}
