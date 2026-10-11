import type { PositionDetails } from "../../../../packages/shared/src/position-details";
import { formatHoldingTime, formatLeverage } from "./position-format";

export interface PositionReceiptSnapshot {
  position: PositionDetails;
  displayName: string | null;
  stale: boolean;
}
export interface ReceiptField {
  label: string;
  value: string;
  exact: string;
  /** Rounded monetary presentation for images; exact values remain inspectable. */
  exportValue?: string;
}
export interface PositionReceiptModel {
  title: string;
  status: string;
  identity: string;
  wallet: string;
  owner: string | null;
  headline: ReceiptField;
  fields: ReceiptField[];
  clock: string;
  coverage: string;
  warnings: string[];
}
const group = (value: string) => value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** Decimal string arithmetic only; a nonterminating scale stays an exact ratio. */
export function exactScaledValue(
  raw: string | null,
  scale = "1000000000000000000",
): string | null {
  if (
    raw === null ||
    !/^-?\d+$/.test(raw) ||
    !/^\d+$/.test(scale) ||
    BigInt(scale) <= 0n
  )
    return null;
  let value = BigInt(raw);
  const negative = value < 0n;
  if (negative) value = -value;
  const divisor = BigInt(scale),
    whole = value / divisor;
  let remainder = value % divisor,
    fraction = "";
  for (let digit = 0; remainder && digit < 256; digit++) {
    remainder *= 10n;
    fraction += String(remainder / divisor);
    remainder %= divisor;
  }
  if (remainder)
    return `${negative ? "−" : ""}${group(value.toString())} ÷ ${group(scale)}`;
  return `${negative ? "−" : ""}${group(whole.toString())}${fraction ? `.${fraction}` : ""}`;
}
function amount(
  label: string,
  raw: string | null,
  unit: string,
  scale?: string | null,
): ReceiptField {
  const exact = scale === null ? null : exactScaledValue(raw, scale);
  if (exact === null) return { label, value: "—", exact: "Unavailable" };
  // Round currency using integer arithmetic, including instrument-scaled prices.
  // Preserve full precision in the separate exact-value view.
  if (unit === "USD" || unit === "USDC") {
    const signed = BigInt(raw!),
      absolute = signed < 0n ? -signed : signed,
      divisor = BigInt(scale ?? "1000000000000000000"),
      cents = (absolute * 200n + divisor) / (divisor * 2n);
    const display = `${signed < 0n && cents !== 0n ? "−" : ""}${group((cents / 100n).toString())}.${(cents % 100n).toString().padStart(2, "0")} ${unit}`;
    return {
      label,
      value: display,
      exportValue: display,
      exact: `${exact} ${unit}`,
    };
  }
  const parts = exact.split(".");
  const display =
    parts.length === 2 && parts[1].length > 6
      ? `${parts[0]}.${parts[1].slice(0, 6)}…`
      : exact;
  return { label, value: `${display} ${unit}`, exact: `${exact} ${unit}` };
}
export function receiptDate(value: number | null): string {
  return value !== null &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 8_640_000_000_000_000
    ? new Date(value)
        .toISOString()
        .replace("T", " ")
        .replace(".000Z", " UTC")
        .replace("Z", " UTC")
    : "Unavailable";
}
export function positionReceiptModel(
  snapshot: PositionReceiptSnapshot,
): PositionReceiptModel {
  const p = snapshot.position,
    open = p.status === "open";
  const simple = (label: string, value: string): ReceiptField => ({
    label,
    value,
    exact: value === "—" ? "Unavailable" : value,
  });
  const fields = [
    amount("Initial margin", p.initialMarginRaw, "USDC"),
    simple(
      "Margin funding",
      p.funding === "cash"
        ? "Cash"
        : p.funding === "queued-balance"
          ? "Queued balance"
          : "—",
    ),
    amount("Entry notional", p.entryNotionalRaw, "USD"),
    simple("Entry leverage", formatLeverage(p.leverage)),
    amount("Entry price", p.entryPriceRaw, "USD", p.priceScaleRaw),
    amount(
      open ? "Bust price" : "Exit price",
      open ? p.bustPriceRaw : p.exitPriceRaw,
      "USD",
      p.priceScaleRaw,
    ),
    simple(
      open ? "Age at snapshot" : "Held",
      formatHoldingTime(open ? p.ageMs : p.heldMs),
    ),
    amount("User fee", p.userPaidFeeRaw, "USDC"),
    amount("PAPER issued", p.paperMintedRaw, "PAPER"),
    amount("Eligible loss basis", p.paperMintBasisRaw, "USD"),
    simple("Opened", receiptDate(p.openedAt)),
    simple(
      open ? "Snapshot time" : "Closed",
      receiptDate(open ? p.provenance.asOf : p.closedAt),
    ),
  ];
  return {
    title: `${p.symbol ?? `Market ${p.instrumentId}`} ${p.side === "long" ? "Long" : "Short"}`,
    status: open
      ? "Open at snapshot"
      : p.status === "liquidated"
        ? "Liquidated"
        : "Closed",
    identity: `Position #${p.positionId}`,
    wallet: p.walletAddress,
    owner: snapshot.displayName,
    headline: open
      ? amount("Initial margin", p.initialMarginRaw, "USDC")
      : amount("Adjusted P&L", p.adjustedPnlRaw, "USDC"),
    fields,
    clock: `${open ? "Snapshot time" : "History checked"} · ${receiptDate(open ? p.provenance.asOf : p.provenance.receivedAt)}`,
    coverage: `${snapshot.stale ? "Last available · " : ""}Retained public ${open ? "snapshot" : "outcome"} · partial coverage`,
    warnings: [...p.warnings],
  };
}
export function freezePositionReceipt(
  position: PositionDetails,
  displayName: string | null,
  stale: boolean,
): PositionReceiptSnapshot {
  return structuredClone({
    position,
    displayName: displayName?.trim() || null,
    stale,
  });
}
export function positionWalletLink(address: string, location: string): string {
  const url = new URL(location);
  url.search = "";
  url.hash = "";
  if (/^0x[\da-f]{40}$/i.test(address))
    url.searchParams.set("wallet", address.toLowerCase());
  return url.toString();
}
export function positionReceiptFilename(position: PositionDetails): string {
  return `paperclub-${position.status}-position-${position.positionId}-${position.walletAddress.slice(2, 8)}.png`;
}
