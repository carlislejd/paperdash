import { useParagonClock, useParagonValuation } from "../lib/paragon-valuation-context";
import {
  addPaperValueRaw, formatParagonValue, paperValueRaw,
  PARAGON_LABEL, PARAGON_PNL_NOTE, PARAGON_VALUE_NOTE,
} from "../lib/paragon-valuation";
import { formatPaperPrice } from "../lib/staker-yield";
import "./paragon-valuation.css";

export function ParagonToggle() {
  const { enabled, setEnabled, quote, priceDelayed } = useParagonValuation();
  return (
    <div className="paragon-control">
      <label className="paragon-toggle">
        <input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />
        <span>Show Paragon estimates</span>
      </label>
      {enabled && (
        <span className="paragon-source">
          <a href="https://app.hyperliquid.xyz/trade/para:PAPER" target="_blank" rel="noopener noreferrer">
            {quote ? `${formatPaperPrice(quote.priceUsdRaw)} / PAPER` : "Price unavailable"} ↗
          </a>
          {" · "}Perpetual midpoint{quote && priceDelayed ? " · Price delayed" : ""}
        </span>
      )}
    </div>
  );
}

export function ParagonEstimate({
  paperRaw, baseRaw, label = "PAPER value", holdingsDelayed = false,
  compact = false, receivedAt,
}: {
  paperRaw: string | null | undefined;
  /** Explicit null means the P&L inputs are unavailable; undefined means value only. */
  baseRaw?: string | null;
  label?: string;
  holdingsDelayed?: boolean;
  compact?: boolean;
  /** Optional directory receipt clock. Wallets supply their own freshness. */
  receivedAt?: number | null;
}) {
  const { enabled, quote, priceDelayed } = useParagonValuation();
  const now = useParagonClock();
  if (!enabled) return null;
  const raw = baseRaw === undefined ? paperValueRaw(paperRaw, quote)
    : addPaperValueRaw(baseRaw, paperRaw, quote);
  const balanceDelayed = holdingsDelayed || (receivedAt !== undefined && (
    receivedAt === null || !Number.isSafeInteger(receivedAt) || receivedAt <= 0 ||
    receivedAt > now || now - receivedAt > 60000
  ));
  const unavailable = !quote ? "Price unavailable"
    : paperValueRaw(paperRaw, quote) === null ? "Holdings unavailable"
      : "P&L inputs unavailable";
  const title = `${PARAGON_VALUE_NOTE}${baseRaw !== undefined ? ` ${PARAGON_PNL_NOTE}` : ""}${quote ? ` Quote: ${new Date(quote.sourceAt).toISOString()}.` : ""}`;
  return (
    <span className="paragon-estimate" title={title}>
      <span className="paragon-estimate-value">
        {label && `${label} · `}{raw === null ? unavailable : `≈ ${formatParagonValue(raw, compact)}`}
      </span>
      <span className="paragon-estimate-label">({PARAGON_LABEL})</span>
      {raw !== null && (priceDelayed || balanceDelayed) && (
        <span className="paragon-estimate-delayed">
          Last available{priceDelayed ? " · Price delayed" : ""}{balanceDelayed ? (baseRaw === undefined ? " · Holdings delayed" : " · Inputs delayed") : ""}
        </span>
      )}
    </span>
  );
}
