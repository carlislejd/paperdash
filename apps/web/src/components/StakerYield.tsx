import { useId, useState } from "react";
import type { AnnualizedStakerYield } from "../../../../packages/shared/src/staking-yield";
import type { PaperEconomicsResponse } from "../../../../packages/shared/src/types";
import { useAnalytics } from "../lib/use-analytics";
import {
  formatStakerApr,
  formatStakerYield,
  formatYieldHours,
  formatYieldTime,
  parsePaperPrice,
  stakerYieldDelayed,
  stakerYieldRate,
} from "../lib/staker-yield";
import "./staker-yield.css";

export function StakerYieldMetric() {
  const { data, error } = useAnalytics<PaperEconomicsResponse>(
    "/api/paper/economics",
  );
  const stale = Boolean(error || stakerYieldDelayed(data));
  return (
    <div className="metric metric-staker-yield">
      <span
        className="metric-label"
        title="Historical annual USDC reward rate per 1,000 staked PAPER, using all observed hours including partial hours. Future rewards vary."
      >
        Staker yield / year
      </span>
      <strong>{formatStakerYield(stakerYieldRate(data?.stakingYield))}</strong>
      <span className="metric-note">
        USDC / 1K PAPER · observed rate
        {stale && data && (
          <span className="staker-yield-delayed">Last available</span>
        )}
      </span>
    </div>
  );
}

export function StakerYield({
  data,
  stale,
}: {
  data: AnnualizedStakerYield | null | undefined;
  stale: boolean;
}) {
  const [price, setPrice] = useState("");
  const id = useId();
  const rate = stakerYieldRate(data);
  const invalidPrice = price.trim() !== "" && parsePaperPrice(price) === null;
  const interval = rate !== null && data?.fromMs != null && data.toMs != null;
  const collecting =
    data?.elapsedMs != null &&
    Number.isSafeInteger(data.elapsedMs) &&
    data.elapsedMs >= 0 &&
    data.elapsedMs < 3_600_000;

  return (
    <section className="staker-yield" aria-labelledby={`${id}-heading`}>
      <div className="staker-yield-heading">
        <h3 id={`${id}-heading`}>Staker yield / year</h3>
        {stale && <span className="staker-yield-delayed">Last available</span>}
      </div>
      <div className="staker-yield-value">
        <strong>{formatStakerYield(rate)}</strong>
        <span>USDC / 1,000 staked PAPER</span>
      </div>
      <p className="staker-yield-intro">
        Stake PAPER to earn USDC. Historical rate; future rewards vary.
      </p>
      <div className="staker-yield-calculator">
        <div className="staker-yield-price">
          <label htmlFor={`${id}-price`}>PAPER price (USDC)</label>
          <input
            id={`${id}-price`}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            maxLength={80}
            placeholder="Enter a price"
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            aria-invalid={invalidPrice}
            aria-describedby={`${id}-price-note`}
          />
        </div>
        <div className="staker-yield-apr" aria-live="polite" aria-atomic="true">
          <span>Simple APR</span>
          <strong>{formatStakerApr(rate, price)}</strong>
        </div>
        <p id={`${id}-price-note`} className="staker-yield-price-note">
          {invalidPrice
            ? "Enter a price greater than zero, with up to 18 decimal places."
            : "Hypothetical price · APR = annual USDC per PAPER ÷ price. No compounding."}
        </p>
      </div>
      <div className="staker-yield-method">
        {interval ? (
          <>
            <p>
              Observed rate ·{" "}
              <strong>{formatYieldHours(data.elapsedMs)} hours</strong> measured
            </p>
            <p className="staker-yield-interval">
              <time
                dateTime={new Date(data.fromMs!).toISOString()}
                title={new Date(data.fromMs!).toISOString()}
              >
                {formatYieldTime(data.fromMs!)}
              </time>
              <span aria-hidden="true"> → </span>
              <span className="sr-only"> to </span>
              <time
                dateTime={new Date(data.toMs!).toISOString()}
                title={new Date(data.toMs!).toISOString()}
              >
                {formatYieldTime(data.toMs!)}
              </time>
            </p>
            <p>
              USDC earned per PAPER ÷ elapsed hours × 8,760. Includes partial
              hours; retrospective run rate.
            </p>
          </>
        ) : (
          <p>
            {collecting
              ? "Collecting the first hour of staking rewards."
              : "Waiting for staking reward observations."}
          </p>
        )}
      </div>
    </section>
  );
}
