import { useEffect, useId, useRef, useState } from "react";
import type { PaperEconomicsResponse } from "../../../../packages/shared/src/types";
import { useAnalytics } from "../lib/use-analytics";
import {
  formatStakerYield,
  formatYieldHours,
  formatYieldTime,
  stakerYieldDelayed,
  stakerYieldRate,
} from "../lib/staker-yield";
import "./staker-yield.css";

export function StakerYieldMetric() {
  const metric = useRef<HTMLDivElement>(null);
  const methodId = useId();
  const [methodOpen, setMethodOpen] = useState(false);
  useEffect(() => {
    if (!methodOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !metric.current?.contains(event.target))
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
  const { data, error } = useAnalytics<PaperEconomicsResponse>(
    "/api/paper/economics",
  );
  const rewards = data?.stakingYield;
  const rate = stakerYieldRate(rewards);
  const rewardDelayed = Boolean(error || stakerYieldDelayed(data));
  const collecting =
    rewards?.elapsedMs != null &&
    Number.isSafeInteger(rewards.elapsedMs) &&
    rewards.elapsedMs >= 0 &&
    rewards.elapsedMs < 3_600_000;

  return (
    <div
      className="metric metric-staker-yield"
      ref={metric}
      onPointerEnter={event => {
        if (event.pointerType === "mouse") setMethodOpen(true);
      }}
      onPointerLeave={() => {
        if (!metric.current?.contains(document.activeElement)) setMethodOpen(false);
      }}
      onFocus={() => setMethodOpen(true)}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setMethodOpen(false);
      }}
    >
      <span className="metric-label">
        Staking rewards / year
        <button
          type="button"
          className="staker-yield-info"
          aria-label="How staking rewards are calculated"
          aria-describedby={methodOpen ? methodId : undefined}
          onClick={() => setMethodOpen(true)}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
            <circle cx="8" cy="8" r="6.25" />
            <path d="M8 7v4M8 4.5v1" />
          </svg>
        </button>
      </span>
      <strong>{formatStakerYield(rate)}</strong>
      <span className="metric-note">
        USDC / 1K staked PAPER
        {rate !== null && rewardDelayed && <span className="staker-yield-delayed"> · Rewards delayed</span>}
        {rate === null && <span> · {collecting ? "Rewards pending" : "Rewards unavailable"}</span>}
      </span>
      <div className="staker-yield-method" id={methodId} role="tooltip" hidden={!methodOpen}>
          <p className="staker-yield-method-heading">How it’s calculated</p>
          <p>Historical annualized rate · {rate === null ? "unavailable" : rewardDelayed ? "last available" : "observed rewards"}</p>
          <p>
            Observed USDC earned per 1,000 staked PAPER, annualized over the measured
            interval. No compounding; future rewards vary.
          </p>
          {rate !== null && rewards ? (
            <>
              <p>{formatStakerYield(rate)} USDC / 1,000 staked PAPER / year.</p>
              <p>{formatYieldHours(rewards.elapsedMs)} hours measured, including partial hours.</p>
              <p className="staker-yield-interval">
                <time dateTime={new Date(rewards.fromMs!).toISOString()}>{formatYieldTime(rewards.fromMs!)}</time>
                <span aria-hidden="true"> → </span><span className="sr-only"> to </span>
                <time dateTime={new Date(rewards.toMs!).toISOString()}>{formatYieldTime(rewards.toMs!)}</time>
              </p>
              <p>USDC earned per PAPER ÷ elapsed hours × 8,760 × 1,000. Historical run rate, not a forecast.</p>
            </>
          ) : (
            <p>{collecting ? "Collecting the first hour of staking rewards." : "Waiting for staking reward observations."}</p>
          )}
      </div>
    </div>
  );
}
