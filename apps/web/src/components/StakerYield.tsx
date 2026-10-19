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
    <div className="metric metric-staker-yield">
      <span className="metric-label">Staker yield / year</span>
      <strong>{formatStakerApr(rate, quote?.priceUsdRaw)}</strong>
      <span className="metric-note">
        Simple APR · {delayed ? "last available" : "observed rate"}
      </span>
      <span className="metric-note staker-yield-price">
        {quote ? `PAPER ${formatPaperPrice(quote.priceUsdRaw)} · perp midpoint` : "PAPER price unavailable"}
      </span>
      <a
        className="metric-note staker-yield-source"
        href="https://app.hyperliquid.xyz/trade/para:PAPER"
        target="_blank"
        rel="noopener noreferrer"
      >
        Hyperliquid para:PAPER <span aria-hidden="true">↗</span>
      </a>
      {quote && priceDelayed && <span className="metric-note staker-yield-delayed">Price delayed</span>}
      {rate !== null && rewardDelayed && <span className="metric-note staker-yield-delayed">Rewards delayed</span>}
      {rate === null && (
        <span className="metric-note">
          {collecting ? "Collecting the first hour of rewards" : "Waiting for reward observations"}
        </span>
      )}
      <details className="staker-yield-method">
        <summary>How it’s calculated</summary>
        <div>
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
      </details>
    </div>
  );
}
