import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  chartFilename,
  chartGeometry,
  chartShareUrl,
  formatChartNumber,
  formatChartTime,
  nearestChartPoint,
  type ChartColor,
  type ChartKind,
  type ChartPoint,
  type ChartRange,
} from "../lib/chart-data";
import type { ChartExportSnapshot } from "../lib/chart-export";
import "./chart-card.css";

export interface ChartCardProps {
  id: string;
  title: string;
  unit: string;
  kind: ChartKind;
  points: readonly ChartPoint[];
  range: ChartRange;
  sourceAt: number | null;
  coverage: string;
  stale?: boolean;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  shareUrl?: string;
  color?: ChartColor;
  /** Override only the latest headline; hover and plotted values remain the observations. */
  valueLabel?: string;
  valueTitle?: string;
  compact?: boolean;
  bucketMs?: number;
}

function ExpandIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 3l6 6m12-6-6 6M3 21l6-6m12 6-6-6" />
    </svg>
  );
}

function ChartPlot({
  points,
  range,
  kind,
  title,
  unit,
  bucketMs,
  expanded = false,
  compact = false,
  color,
}: Pick<
  ChartCardProps,
  "points" | "range" | "kind" | "title" | "unit" | "bucketMs" | "color"
> & { expanded?: boolean; compact?: boolean }) {
  const [selectedTime, setSelectedTime] = useState<number | null>(null);
  const patternId = useId().replace(/:/g, "");
  const descriptionId = useId();
  const width = compact ? 180 : 700,
    height = compact ? 56 : expanded ? 280 : 150;
  const left = compact ? 3 : 0,
    right = compact ? 3 : 8;
  const plotWidth = width - left - right;
  const geometry = useMemo(
    () => chartGeometry(points, range, kind, plotWidth, height - 12, bucketMs),
    [points, range.from, range.to, kind, plotWidth, height, bucketMs],
  );
  const selected =
    selectedTime === null
      ? null
      : geometry.points[nearestChartPoint(geometry.points, selectedTime) ?? 0];
  const available = geometry.points.some((point) => point.value !== null);
  function selectAt(clientX: number, target: SVGSVGElement) {
    const bounds = target.getBoundingClientRect();
    const proportion = Math.max(
      0,
      Math.min(
        1,
        (((clientX - bounds.left) / bounds.width) * width - left) / plotWidth,
      ),
    );
    const index = nearestChartPoint(
      geometry.points,
      geometry.from + proportion * (geometry.to - geometry.from),
    );
    setSelectedTime(index === null ? null : geometry.points[index].time);
  }
  const accent = color === "green" ? "#506746" : "#9078ad";
  return (
    <div className={`pc-chart-plot${compact ? " pc-chart-plot--spark" : ""}`}>
      {!compact && (
        <div className="pc-chart-y-axis" aria-hidden="true">
          {geometry.ticks.map((tick, index) => (
            <span
              key={index}
              style={{ top: `${((tick.y + 6) / (height + 5)) * 100}%` }}
            >
              {formatChartNumber(tick.value)}
            </span>
          ))}
        </div>
      )}
      <svg
        viewBox={`0 0 ${width} ${height + (compact ? 0 : 5)}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${title}: ${available ? `${geometry.points.filter((point) => point.value !== null).length} available observations in ${unit}` : "no observations in this range"}`}
        aria-describedby={compact ? undefined : descriptionId}
        tabIndex={compact || !available ? undefined : 0}
        onPointerMove={
          compact
            ? undefined
            : (event) => {
                if (event.pointerType !== "touch" || event.buttons)
                  selectAt(event.clientX, event.currentTarget);
              }
        }
        onPointerDown={
          compact
            ? undefined
            : (event) => selectAt(event.clientX, event.currentTarget)
        }
        onPointerLeave={
          compact
            ? undefined
            : (event) => {
                if (event.pointerType !== "touch") setSelectedTime(null);
              }
        }
        onBlur={() => setSelectedTime(null)}
        onKeyDown={
          compact
            ? undefined
            : (event) => {
                const keys = [
                  "ArrowLeft",
                  "ArrowRight",
                  "Home",
                  "End",
                  "Escape",
                ];
                if (!keys.includes(event.key)) return;
                if (event.key === "Escape") {
                  setSelectedTime(null);
                  return;
                }
                event.preventDefault();
                const current =
                  selectedTime === null
                    ? geometry.points.length - 1
                    : (nearestChartPoint(geometry.points, selectedTime) ?? 0);
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? geometry.points.length - 1
                      : Math.max(
                          0,
                          Math.min(
                            geometry.points.length - 1,
                            current + (event.key === "ArrowLeft" ? -1 : 1),
                          ),
                        );
                setSelectedTime(geometry.points[next]?.time ?? null);
              }
        }
      >
        <defs>
          <pattern
            id={patternId}
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(35)"
          >
            <rect width="6" height="6" fill={accent} opacity=".23" />
            <line
              x1="0"
              x2="0"
              y1="0"
              y2="6"
              stroke={accent}
              strokeWidth="2"
              opacity=".65"
            />
          </pattern>
        </defs>
        <g transform={`translate(${left},6)`}>
          {!compact &&
            geometry.ticks.map((tick, index) => (
              <line
                key={index}
                x1="0"
                x2={plotWidth}
                y1={tick.y}
                y2={tick.y}
                stroke="var(--line)"
                strokeWidth=".7"
              />
            ))}
          {kind === "bar" ? (
            geometry.bars.map((bar, index) => (
              <rect
                key={index}
                x={bar.x}
                y={bar.y}
                width={bar.width}
                height={bar.height}
                fill={bar.partial ? `url(#${patternId})` : accent}
                opacity={bar.partial ? 1 : 0.8}
              />
            ))
          ) : (
            <>
              <path
                d={geometry.path}
                fill="none"
                stroke={accent}
                strokeWidth={compact ? "1.5" : "2.2"}
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
              />
              {geometry.markers.map((point, index) => (
                <circle
                  key={index}
                  cx={point.x}
                  cy={point.y}
                  r={compact ? 2.5 : 3}
                  fill={accent}
                />
              ))}
            </>
          )}
          {!compact && selected && (
            <g>
              <line
                x1={geometry.x(selected.time)}
                x2={geometry.x(selected.time)}
                y1="0"
                y2={height - 12}
                stroke={accent}
                strokeDasharray="3 4"
                opacity=".55"
              />
              {selected.value !== null && (
                <circle
                  cx={geometry.x(selected.time)}
                  cy={geometry.y(selected.value)}
                  r="4"
                  fill={accent}
                  stroke="var(--paper)"
                  strokeWidth="2"
                />
              )}
            </g>
          )}
        </g>
      </svg>
      {!compact && (
        <>
          {!available && (
            <span className="pc-chart-empty">
              No observations in this range
            </span>
          )}
          <div className="pc-chart-axis">
            <span>
              {formatChartTime(
                geometry.from,
                range.to - range.from >= 86_400_000,
              )}
            </span>
            <span>
              {formatChartTime(geometry.to, range.to - range.from >= 86_400_000)}
            </span>
          </div>
          <div
            className="pc-chart-inspect"
            aria-live="polite"
            aria-atomic="true"
          >
            {selected ? (
              <>
                <strong>
                  {formatChartNumber(selected.value, false)} {unit}
                </strong>
                <span>
                  {formatChartTime(selected.time)}
                  {kind === "bar" ? " · bucket start" : ""}
                  {selected.partial ? " · partial" : ""}
                </span>
              </>
            ) : (
              <span>
                {kind === "bar"
                  ? "Hourly UTC buckets · hatched bars are partial"
                  : "Gaps indicate unavailable observations"}
              </span>
            )}
          </div>
          <span id={descriptionId} className="pc-chart-sr-only">
            Use left and right arrow keys to inspect observations. Missing
            values are not zero. Times are UTC.
          </span>
        </>
      )}
    </div>
  );
}

export function ChartCard(props: ChartCardProps) {
  const {
    id,
    title,
    unit,
    points,
    range,
    sourceAt,
    coverage,
    loading = false,
    error,
    onRetry,
    compact = false,
  } = props;
  const stale = Boolean(props.stale || error);
  const [open, setOpen] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("chart") === id,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [manualLink, setManualLink] = useState<string | null>(null);
  const [readyFile, setReadyFile] = useState<{
    file: File;
    title: string;
    text: string;
    url: string;
  } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const titleId = useId(),
    coverageId = useId();
  const prepared = useMemo(
    () => chartGeometry(points, range, props.kind, 700, 150, props.bucketMs),
    [points, range.from, range.to, props.kind, props.bucketMs],
  );
  const last = prepared.points.at(-1);
  const link = () => props.shareUrl ?? chartShareUrl(window.location.href, id);
  const exportCoverage = `${coverage}${prepared.truncated ? " · Latest 2,048 observations" : ""}`;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const changed = () =>
      setOpen(new URLSearchParams(window.location.search).get("chart") === id);
    window.addEventListener("popstate", changed);
    return () => window.removeEventListener("popstate", changed);
  }, [id]);
  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    if (!element) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : opener.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element.showModal();
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      element.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected)
        previousFocus.focus({ preventScroll: true });
    };
  }, [open]);
  function close() {
    setOpen(false);
    setManualLink(null);
    setReadyFile(null);
    const url = new URL(window.location.href);
    if (url.searchParams.get("chart") === id) {
      url.searchParams.delete("chart");
      window.history.replaceState(window.history.state, "", url);
    }
  }
  function snapshot(): ChartExportSnapshot {
    return {
      title,
      unit,
      kind: props.kind,
      points: prepared.points.map((point) => ({ ...point })),
      range: { ...range },
      sourceAt,
      coverage: exportCoverage,
      stale,
      color: props.color ?? "lavender",
      bucketMs: props.bucketMs,
      valueLabel: props.valueLabel,
    };
  }
  async function png(frozen = snapshot()) {
    const { renderChartPng } = await import("../lib/chart-export");
    return renderChartPng(frozen);
  }
  async function copyLink() {
    const url = link();
    try {
      await navigator.clipboard.writeText(url);
      if (mounted.current) {
        setMessage("Chart link copied.");
        setManualLink(null);
      }
    } catch {
      if (mounted.current) {
        setManualLink(url);
        setMessage("Copy this chart link.");
      }
    }
  }
  async function download() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const blob = await png();
      if (!mounted.current) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = chartFilename(id);
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setMessage("PNG downloaded.");
    } catch (cause) {
      if (mounted.current)
        setMessage(
          cause instanceof Error
            ? cause.message
            : "Image export failed. Try again.",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function share() {
    if (busy) return;
    if (!navigator.share || !navigator.canShare) {
      await copyLink();
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      // Keep the link/range/description with the same frozen snapshot as the PNG.
      // A retry after transient activation expires must not relabel an older image.
      const frozen = snapshot();
      const metadata = {
        title: `${frozen.title} · paperclub`,
        text: `${frozen.range.label} · ${frozen.coverage}`,
        url: link(),
      };
      const ready = readyFile ?? {
        ...metadata,
        file: new File([await png(frozen)], chartFilename(id), {
          type: "image/png",
        }),
      };
      if (!mounted.current) return;
      if (!navigator.canShare({ files: [ready.file] })) {
        await copyLink();
        return;
      }
      setReadyFile(ready);
      await navigator.share({
        files: [ready.file],
        title: ready.title,
        text: ready.text,
        url: ready.url,
      });
      if (mounted.current) {
        setMessage("Chart shared.");
        setReadyFile(null);
      }
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof DOMException && cause.name === "AbortError") {
        setMessage("Share cancelled.");
        setReadyFile(null);
      } else if (
        cause instanceof DOMException &&
        cause.name === "NotAllowedError"
      )
        setMessage("Image ready. Tap Share again, or copy the link.");
      else
        setMessage(
          cause instanceof Error
            ? cause.message
            : "Sharing failed. Download the PNG or copy the link.",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const status =
    !points.length && loading
      ? "Loading"
      : stale
        ? "Last available"
        : formatChartTime(sourceAt);
  return (
    <section
      className={`pc-chart-card${compact ? " pc-chart-card--compact" : ""}`}
      aria-label={`${title} chart card`}
      title={compact ? exportCoverage : undefined}
    >
      <div className="pc-chart-heading">
        <h3>{title}</h3>
        <button
          ref={opener}
          type="button"
          className="pc-chart-expand"
          aria-label={`Expand ${title} chart`}
          onClick={() => {
            setMessage("");
            setOpen(true);
          }}
        >
          <ExpandIcon />
        </button>
      </div>
      <div className="pc-chart-headline">
        <strong
          title={
            props.valueTitle ??
            `${formatChartNumber(last?.value, false)} ${unit}`
          }
        >
          {props.valueLabel ?? formatChartNumber(last?.value)}
        </strong>
        <span>{unit}</span>
        {compact && <ChartPlot {...props} compact />}
      </div>
      {!compact && <ChartPlot {...props} />}
      <div className="pc-chart-meta">
        <span>
          {range.label} · {status}
        </span>
        {!compact && <span title={exportCoverage}>{exportCoverage}</span>}
      </div>
      {error && onRetry && (
        <button type="button" className="pc-chart-retry" onClick={onRetry}>
          Retry {title.toLowerCase()}
        </button>
      )}
      {open &&
        createPortal(
          <dialog
            ref={dialog}
            className="pc-chart-dialog"
            aria-labelledby={titleId}
            aria-describedby={coverageId}
            onCancel={(event) => {
              event.preventDefault();
              close();
            }}
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                const rect = event.currentTarget.getBoundingClientRect();
                if (
                  event.clientX < rect.left ||
                  event.clientX > rect.right ||
                  event.clientY < rect.top ||
                  event.clientY > rect.bottom
                )
                  close();
              }
            }}
          >
            <div className="pc-chart-dialog-header">
              <span className="pc-chart-brand">paperclub.</span>
              <button
                ref={closeButton}
                type="button"
                className="pc-chart-close"
                aria-label={`Close ${title} chart`}
                onClick={close}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  aria-hidden="true"
                >
                  <path d="m6 6 12 12M6 18 18 6" />
                </svg>
              </button>
            </div>
            <div className="pc-chart-dialog-title">
              <h2 id={titleId}>{title}</h2>
              <span>{range.label}</span>
            </div>
            <div className="pc-chart-headline">
              <strong
                title={
                  props.valueTitle ??
                  `${formatChartNumber(last?.value, false)} ${unit}`
                }
              >
                {props.valueLabel ?? formatChartNumber(last?.value)}
              </strong>
              <span>{unit}</span>
              <small>{status}</small>
            </div>
            <ChartPlot {...props} expanded compact={false} />
            <p id={coverageId} className="pc-chart-coverage">
              {exportCoverage}
            </p>
            <p className="pc-chart-stamp">
              Data timestamp: {formatChartTime(sourceAt)}
              {stale ? " · Last available" : ""}
            </p>
            {error && onRetry && (
              <button
                type="button"
                className="pc-chart-retry"
                onClick={onRetry}
              >
                Retry {title.toLowerCase()}
              </button>
            )}
            <div className="pc-chart-actions">
              <button type="button" disabled={busy} onClick={download}>
                {busy ? "Preparing image…" : "Download PNG"}
              </button>
              <button type="button" disabled={busy} onClick={share}>
                {readyFile ? "Share image" : "Share"}
              </button>
              <button type="button" disabled={busy} onClick={copyLink}>
                Copy chart link
              </button>
            </div>
            <p className="pc-chart-action-status" role="status">
              {message}
            </p>
            {manualLink && (
              <label className="pc-chart-link">
                Chart link
                <input
                  readOnly
                  value={manualLink}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
            )}
          </dialog>,
          document.body,
        )}
    </section>
  );
}

export default ChartCard;
