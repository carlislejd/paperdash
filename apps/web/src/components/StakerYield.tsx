import { useEffect, useId, useRef, useState } from "react";
import { paperPriceDelayed, validPaperPrice } from "../../../../packages/shared/src/paper-price";
import type { PaperEconomicsResponse } from "../../../../packages/shared/src/types";
import { useAnalytics } from "../lib/use-analytics";
import {
  formatPaperPrice,
  formatStakerApr,
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
  const quote = validPaperPrice(data?.paperPrice);
  const rewardDelayed = Boolean(error || stakerYieldDelayed(data));
  const priceDelayed = paperPriceDelayed(quote);
  const delayed = rate !== null && quote !== null && (rewardDelayed || priceDelayed);
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
        Staker yield / year
        <button
          type="button"
          className="staker-yield-info"
          aria-label="How staker yield is calculated"
          aria-describedby={methodOpen ? methodId : undefined}
          onClick={() => setMethodOpen(true)}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
            <circle cx="8" cy="8" r="6.25" />
            <path d="M8 7v4M8 4.5v1" />
          </svg>
        </button>
      </span>
      <strong>{formatStakerApr(rate, quote?.priceUsdRaw)}</strong>
      <span className="metric-note staker-yield-price-row">
        <a
          className="staker-yield-source"
          href="https://app.hyperliquid.xyz/trade/para:PAPER"
          target="_blank"
          rel="noopener noreferrer"
          aria-describedby={methodOpen ? methodId : undefined}
        >
          {quote ? `PAPER price ${formatPaperPrice(quote.priceUsdRaw)}` : "PAPER price unavailable"} <span aria-hidden="true">↗</span>
        </a>
        {quote && priceDelayed && <span className="staker-yield-delayed"> · Price delayed</span>}
        {rate !== null && rewardDelayed && <span className="staker-yield-delayed"> · Rewards delayed</span>}
        {rate === null && <span> · {collecting ? "Rewards pending" : "Rewards unavailable"}</span>}
      </span>
      <div className="staker-yield-method" id={methodId} role="tooltip" hidden={!methodOpen}>
          <p className="staker-yield-method-heading">How it’s calculated</p>
          <p>Simple APR · {rate === null || quote === null ? "unavailable" : delayed ? "last available" : "observed rate"}</p>
          <p>
            Observed annual USDC earned per PAPER ÷ PAPER price. No compounding;
            future rewards vary.
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
              <p>USDC earned per PAPER ÷ elapsed hours × 8,760. Retrospective run rate.</p>
            </>
          ) : (
            <p>{collecting ? "Collecting the first hour of staking rewards." : "Waiting for staking reward observations."}</p>
          )}
          <p>Price is the midpoint of the best bid and ask for Paragon’s PAPER perpetual on Hyperliquid.</p>
          {quote && (
            <p>Price as of <time dateTime={new Date(quote.sourceAt).toISOString()}>{formatYieldTime(quote.sourceAt)}</time>.</p>
          )}
      </div>
    </div>
  );
}
