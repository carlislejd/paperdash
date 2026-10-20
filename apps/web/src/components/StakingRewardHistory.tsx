import { useEffect, useId, useMemo, useState } from "react";
import type {
  StakingRewardDay,
  StakingRewardHistory as RewardHistory,
} from "../../../../packages/shared/src/types";
import { formatRawToken, relativeTime } from "../lib/format";
import { formatChartTime, validChartTime } from "../lib/chart-data";
import "./staking-reward-history.css";

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
const DAY_MS = 86_400_000;

function rewardValue(day: StakingRewardDay): string | null {
  const raw = day.earnedUsdPer1kPaperRaw;
  return !day.missing &&
    typeof raw === "string" &&
    raw.length <= 79 &&
    /^\d+$/.test(raw) &&
    validChartTime(day.fromMs) &&
    validChartTime(day.toMs) &&
    day.toMs > day.fromMs
    ? raw
    : null;
}

function amountLabel(raw: string): string {
  const value = BigInt(raw);
  if (value > 0n && value < 1_000_000_000_000n) return "<$0.000001";
  const rounded = (value + 500_000_000_000n) / 1_000_000_000_000n;
  const whole = (rounded / 1_000_000n).toLocaleString("en-US");
  const fraction = (rounded % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "")
    .padEnd(2, "0");
  return `$${whole}.${fraction}`;
}

function intervalLabel(day: StakingRewardDay): string | null {
  if (!validChartTime(day.fromMs) || !validChartTime(day.toMs) || day.toMs <= day.fromMs)
    return null;
  const from = timeFormatter.format(day.fromMs);
  const to = timeFormatter.format(day.toMs);
  const differentDay =
    Math.floor(day.fromMs / DAY_MS) !== Math.floor(day.toMs / DAY_MS);
  return `${from}–${differentDay ? `${dateFormatter.format(day.toMs)} ` : ""}${to}`;
}

export function StakingRewardHistory({
  history,
  sourceAt,
  stale,
  loading,
}: {
  history: RewardHistory | undefined;
  sourceAt: number | null;
  stale: boolean;
  loading: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const tableId = useId();
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);
  const days = useMemo(
    () =>
      history?.basis === "observed-accumulator" && history.timeZone === "UTC" && Array.isArray(history.days)
        ? history.days.filter(day => validChartTime(day.dayMs))
            .slice()
            .sort((a, b) => b.dayMs - a.dayMs)
            .slice(0, 365)
        : [],
    [history],
  );
  const visible = expanded ? days : days.slice(0, 7);
  const hasClock = validChartTime(sourceAt);
  const delayed = stale || (hasClock && (now - sourceAt > 60_000 || sourceAt > now + 30_000));
  const observedFrom = history?.observedFromMs;

  return (
    <section className="staking-reward-history" aria-label="Daily staking rewards">
      <div className="staking-reward-history-heading">
        <h3>Daily staking rewards</h3>
        <span className={delayed ? "staking-reward-history-status is-stale" : "staking-reward-history-status"}>
          {hasClock ? (
            <>
              {delayed ? "Last available" : "Updated"} ·{" "}
              <time dateTime={new Date(sourceAt).toISOString()} title={formatChartTime(sourceAt)}>
                {relativeTime(sourceAt)}
              </time>
            </>
          ) : loading ? "Loading" : "Awaiting data"}
        </span>
      </div>
      <p className="staking-reward-history-description">
        USDC earned per 1,000 staked PAPER · actual observations
      </p>
      {days.length ? (
        <>
          <table id={tableId}>
            <caption className="sr-only">Actual observed staking rewards per 1,000 continuously staked PAPER, by UTC day. Partial days cover only the stated interval.</caption>
            <thead>
              <tr><th scope="col">Day (UTC)</th><th scope="col">USDC / 1K</th><th scope="col">Coverage</th></tr>
            </thead>
            <tbody>
              {visible.map(day => {
                const raw = rewardValue(day);
                const interval = intervalLabel(day);
                const partial = day.partial ||
                  day.fromMs !== day.dayMs || day.toMs !== day.dayMs + DAY_MS;
                return (
                  <tr key={day.dayMs} data-missing={raw === null} data-partial={partial}>
                    <th scope="row">
                      <time dateTime={new Date(day.dayMs).toISOString().slice(0, 10)} title={formatChartTime(day.dayMs)}>
                        {dateFormatter.format(day.dayMs)}
                      </time>
                    </th>
                    <td className="staking-reward-amount" title={raw === null ? "Rewards unavailable" : `${formatRawToken(raw)} USDC per 1,000 staked PAPER`}>
                      {raw === null ? "—" : amountLabel(raw)}
                    </td>
                    <td className="staking-reward-coverage" title={interval === null ? undefined : `${formatChartTime(day.fromMs)} → ${formatChartTime(day.toMs)}`}>
                      <span>{raw === null ? "Unavailable" : partial ? "Partial day" : "Full UTC day"}</span>
                      {interval && partial && <small>{interval}</small>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {days.length > 7 && (
            <button className="staking-reward-history-toggle" type="button" aria-expanded={expanded} aria-controls={tableId} onClick={() => setExpanded(value => !value)}>
              {expanded ? "Show latest 7 days" : `Show all ${days.length} days`}
            </button>
          )}
          <p className="staking-reward-history-note">
            {history?.truncated ? "Last 365 UTC days available in this view. " : ""}
            {validChartTime(observedFrom) ? `Tracking since ${formatChartTime(observedFrom)}. ` : ""}
            Daily history before tracking began is unavailable. Partial days are not full-day rates.
          </p>
        </>
      ) : (
        <p className="staking-reward-history-empty">
          {loading ? "Loading daily reward history." : "Daily reward tracking is starting. Earlier daily history is unavailable."}
        </p>
      )}
    </section>
  );
}
