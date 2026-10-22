import { useEffect, useId, useRef, useState } from "react";
import type { PaperEconomicsResponse } from "../../../../packages/shared/src/types";
import { allocationRateForDisplay } from "../lib/allocation-rate";
import { validChartTime } from "../lib/chart-data";
import { formatRawUsd, relativeTime } from "../lib/format";
import { formatYieldHours, formatYieldTime } from "../lib/staker-yield";
import "./staker-revenue.css";

export function StakerRevenue({ data, stale, loading }: {
  data: PaperEconomicsResponse | null;
  stale: boolean;
  loading: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  const [methodOpen, setMethodOpen] = useState(false);
  const help = useRef<HTMLDivElement>(null);
  const methodId = useId();
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!methodOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !help.current?.contains(event.target))
        setMethodOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMethodOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [methodOpen]);

  const annualized = allocationRateForDisplay(data);
  const total = typeof data?.allocatedRewardsRaw === "string" &&
    /^(0|[1-9]\d{0,77})$/.test(data.allocatedRewardsRaw)
    ? data.allocatedRewardsRaw : null;
  const sourceAt = validChartTime(data?.sourceAt) ? data.sourceAt : null;
  const delayed = stale || [sourceAt, data?.receivedAt].some(time =>
    !validChartTime(time) || now - time > 30_000 || time > now + 30_000,
  );

  return (
    <section className="staker-revenue" aria-label="Staker revenue">
      <div className="staker-revenue-heading">
        <h3>Staker revenue</h3>
        <div
          className="staker-revenue-help"
          ref={help}
          onPointerEnter={event => {
            if (event.pointerType === "mouse") setMethodOpen(true);
          }}
          onPointerLeave={() => {
            if (!help.current?.contains(document.activeElement)) setMethodOpen(false);
          }}
          onFocus={() => setMethodOpen(true)}
          onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget)) setMethodOpen(false);
          }}
        >
          <button type="button" aria-label="How staker revenue is calculated"
            aria-describedby={methodOpen ? methodId : undefined}
            onClick={() => setMethodOpen(true)}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
              <circle cx="8" cy="8" r="6.25" />
              <path d="M8 7v4M8 4.5v1" />
            </svg>
          </button>
          <div className="staker-revenue-method" id={methodId} role="tooltip" hidden={!methodOpen}>
            <p><strong>How it’s calculated</strong></p>
            <p>Total allocated is lifetime USDC allocated to stakers, including unclaimed rewards. It is not a total of claims or cash distributions.</p>
            {annualized ? (
              <>
                <p>Total allocated ÷ elapsed hours × 24 × 365</p>
                <p>{formatYieldHours(annualized.toMs - annualized.fromMs)} hours measured, including partial hours, since the announced trading start.</p>
                <p>
                  <time dateTime={new Date(annualized.fromMs).toISOString()}>{formatYieldTime(annualized.fromMs)}</time>
                  {" → "}
                  <time dateTime={new Date(annualized.toMs).toISOString()}>{formatYieldTime(annualized.toMs)}</time>
                </p>
                <p>Verified prelaunch allocation baseline: {formatRawUsd(annualized.baselineRewardsRaw)}. Average daily allocations: {formatRawUsd(annualized.usdPerDayRaw)} USDC.</p>
              </>
            ) : <p>Waiting for verified trading-window allocation totals.</p>}
            <p>Historical run rate across all stakers, not a forecast or a per-token yield. Uses the source observation time; partial hours count.</p>
          </div>
        </div>
        <span className={`staker-revenue-status${delayed ? " is-stale" : ""}`}>
          {sourceAt !== null ? <>{delayed ? "Last available" : "Updated"} · <time dateTime={new Date(sourceAt).toISOString()} title={formatYieldTime(sourceAt)}>{relativeTime(sourceAt)}</time></>
            : loading ? "Loading" : "Awaiting data"}
        </span>
      </div>
      <dl>
        <div>
          <dt>Total allocated</dt>
          <dd><strong title={formatRawUsd(total)}>{formatRawUsd(total, true)}</strong><small>USDC · lifetime</small></dd>
        </div>
        <div>
          <dt>Annualized</dt>
          <dd><strong title={formatRawUsd(annualized?.usdPerYearRaw)}>{formatRawUsd(annualized?.usdPerYearRaw, true)}</strong><small>USDC / year</small></dd>
        </div>
      </dl>
      <p className="staker-revenue-note">USDC allocated to stakers · historical run rate</p>
    </section>
  );
}
