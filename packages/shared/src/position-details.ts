/** One interpretation of retained wallet records; never joins sampled ticker trades.
 * Accounting amounts (USD and PAPER) have 18 decimals. Prices divide by the
 * separate instrument priceScaleRaw, not by 10^18.
 */
export interface PositionInstrument {
  id: number;
  symbol: string;
  priceScaleRaw: string;
}

export interface PositionDetailContext {
  walletAddress: string;
  /** Receipt time of this source part, not the minimum of unrelated wallet parts. */
  receivedAt: number | null;
  /** Frozen display time. An open age does not prove the position is still open. */
  asOf: number;
  instrument?: PositionInstrument;
  /** History-page coverage can disclose ambiguity even without a per-row flag. */
  identityAmbiguous?: boolean;
}

export interface PositionDetails {
  version: 1;
  walletAddress: string;
  positionId: string;
  status: "open" | "closed" | "liquidated";
  instrumentId: number;
  symbol: string | null;
  side: "long" | "short";
  initialMarginRaw: string | null;
  /** Exact initial margin × original integer leverage; not current market value. */
  entryNotionalRaw: string | null;
  leverage: number | null;
  funding: "cash" | "queued-balance" | "unknown";
  entryPriceRaw: string | null;
  bustPriceRaw: string | null;
  exitPriceRaw: string | null;
  priceScaleRaw: string | null;
  openedAt: number | null;
  closedAt: number | null;
  heldMs: number | null;
  ageMs: number | null;
  /** Source adjusted P&L, not a reconstructed return or a cash-settlement claim. */
  adjustedPnlRaw: string | null;
  /** Separate source fee; adjusted P&L is not labeled net of this fee. */
  userPaidFeeRaw: string | null;
  paperMintedRaw: string | null;
  /** Eligible USD loss basis; distinct from PAPER minted and initial margin. */
  paperMintBasisRaw: string | null;
  paperMintBatchTotalRaw: string | null;
  txHash: string | null;
  /** Open intent ID is not a transaction hash. */
  intentId: string | null;
  provenance: {
    source: "wallet-open-position" | "wallet-trade-outcome";
    /** Retained observation key, when supplied; not a canonical event identifier. */
    retainedId: string | null;
    receivedAt: number | null;
    asOf: number;
    identityAmbiguous: boolean;
    partial: true;
    priceScaleSource: "outcome" | "verified-instrument" | "unavailable";
    derivedFields: ("entryNotionalRaw" | "heldMs" | "ageMs")[];
  };
  warnings: string[];
}

/** Verified deployment metadata, not an assumption about every future market.
 * Source: exchange.papertrade.xyz/assets/deployment-C3VOxZVa.js (2026-10-09).
 * Explicit context metadata takes precedence; closed outcomes use their own scale.
 */
export function verifiedPositionInstrument(
  instrumentId: number,
): PositionInstrument | undefined {
  if (instrumentId === 0) return { id: 0, symbol: "BTC", priceScaleRaw: "10" };
  if (instrumentId === 1) return { id: 1, symbol: "ETH", priceScaleRaw: "100" };
  return undefined;
}

const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): value is number =>
  integer(value) && value <= 8_640_000_000_000_000;
const uintMax = (1n << 256n) - 1n;
const intMin = -(1n << 255n);
const intMax = (1n << 255n) - 1n;
const unsigned = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 78 &&
  /^(0|[1-9]\d*)$/.test(value) &&
  BigInt(value) <= uintMax;
const signed = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 79 &&
  /^(0|-?[1-9]\d*)$/.test(value) &&
  BigInt(value) >= intMin &&
  BigInt(value) <= intMax;
const symbol = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 32;
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^0x[\da-fA-F]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function base(
  positionId: unknown,
  instrumentId: unknown,
  isLong: unknown,
  status: PositionDetails["status"],
  context: PositionDetailContext,
): PositionDetails | null {
  if (
    !unsigned(positionId) ||
    !integer(instrumentId) ||
    typeof isLong !== "boolean" ||
    !/^0x[\da-fA-F]{40}$/.test(context.walletAddress) ||
    !timestamp(context.asOf)
  )
    return null;
  const receivedAt = timestamp(context.receivedAt) ? context.receivedAt : null;
  return {
    version: 1,
    walletAddress: context.walletAddress.toLowerCase(),
    positionId,
    status,
    instrumentId,
    symbol: null,
    side: isLong ? "long" : "short",
    initialMarginRaw: null,
    entryNotionalRaw: null,
    leverage: null,
    funding: "unknown",
    entryPriceRaw: null,
    bustPriceRaw: null,
    exitPriceRaw: null,
    priceScaleRaw: null,
    openedAt: null,
    closedAt: null,
    heldMs: null,
    ageMs: null,
    adjustedPnlRaw: null,
    userPaidFeeRaw: null,
    paperMintedRaw: null,
    paperMintBasisRaw: null,
    paperMintBatchTotalRaw: null,
    txHash: null,
    intentId: null,
    provenance: {
      source:
        status === "open" ? "wallet-open-position" : "wallet-trade-outcome",
      retainedId: null,
      receivedAt,
      asOf: context.asOf,
      identityAmbiguous: context.identityAmbiguous === true,
      partial: true,
      priceScaleSource: "unavailable",
      derivedFields: [],
    },
    warnings:
      context.identityAmbiguous === true
        ? ["Retained history has ambiguous observation identity."]
        : [],
  };
}

function reader(details: PositionDetails) {
  return function read<T>(
    value: unknown,
    valid: (value: unknown) => value is T,
    label: string,
    optional = false,
  ): T | null {
    if (valid(value)) return value;
    if (!optional || value != null)
      details.warnings.push(`${label} is unavailable or invalid.`);
    return null;
  };
}

function marginAndLeverage(
  details: PositionDetails,
  margin: unknown,
  leverage: unknown,
) {
  const read = reader(details);
  details.initialMarginRaw = read(margin, unsigned, "Initial margin");
  details.leverage = read(
    leverage,
    (value): value is number => integer(value) && value > 0,
    "Leverage",
  );
  if (details.initialMarginRaw !== null && details.leverage !== null) {
    details.entryNotionalRaw = (
      BigInt(details.initialMarginRaw) * BigInt(details.leverage)
    ).toString();
    details.provenance.derivedFields.push("entryNotionalRaw");
  }
}

/** Full-close and liquidation outcomes carry their own prices and issuance.
 * terminal/retired concern instrument lifecycle, not whether an outcome settled.
 * Funding mode and bust price are absent from this source and remain unavailable.
 */
export function normalizeClosedPosition(
  item: unknown,
  context: PositionDetailContext,
): PositionDetails | null {
  if (
    !object(item) ||
    (item.kind !== "PositionClosed" && item.kind !== "Liquidated")
  )
    return null;
  const details = base(
    item.positionId,
    item.instrumentId,
    item.isLong,
    item.kind === "Liquidated" ? "liquidated" : "closed",
    context,
  );
  if (!details) return null;
  details.provenance.retainedId =
    typeof item.id === "string" && item.id.length > 0 && item.id.length <= 512
      ? item.id
      : null;
  const read = reader(details);
  details.symbol = read(item.symbol, symbol, "Market symbol");
  details.priceScaleRaw = read(
    item.priceScaleRaw,
    (value): value is string => unsigned(value) && value !== "0",
    "Price scale",
  );
  if (details.priceScaleRaw !== null)
    details.provenance.priceScaleSource = "outcome";
  details.entryPriceRaw = read(item.entryPriceRaw, unsigned, "Entry price");
  details.exitPriceRaw = read(item.exitPriceRaw, unsigned, "Exit price");
  marginAndLeverage(details, item.marginRaw, item.leverage);
  details.openedAt = read(item.openedAtMs, timestamp, "Opening time");
  details.closedAt = read(item.timestampMs, timestamp, "Closing time");
  const clock = details.provenance.receivedAt ?? context.asOf;
  if (
    details.openedAt !== null &&
    details.closedAt !== null &&
    details.openedAt <= details.closedAt &&
    details.closedAt - clock <= 30_000 &&
    details.closedAt - context.asOf <= 30_000
  ) {
    details.heldMs = details.closedAt - details.openedAt;
    details.provenance.derivedFields.push("heldMs");
  } else
    details.warnings.push(
      "Holding duration is unavailable because the execution times are missing or inconsistent.",
    );
  details.adjustedPnlRaw = read(item.adjustedPnlRaw, signed, "Adjusted P&L");
  details.userPaidFeeRaw = read(item.userPaidFeeRaw, unsigned, "User-paid fee");
  details.paperMintedRaw = read(item.paperMintedRaw, unsigned, "PAPER minted");
  details.paperMintBasisRaw = read(
    item.paperMintBasisRaw,
    unsigned,
    "PAPER eligible loss basis",
  );
  details.paperMintBatchTotalRaw = read(
    item.paperMintBatchTotalRaw,
    unsigned,
    "PAPER batch total",
    true,
  );
  details.txHash = read(item.txHash, hash, "Transaction hash");
  return details;
}

/** Tuple: id,instrument,isLong,useDebt,entry,margin,leverage,bust,openedAt,intentId.
 * useDebt means queued-balance margin, not an additional borrowed amount.
 * https://docs.papertrade.xyz/#/learn/lp-queue
 */
export function normalizeOpenPosition(
  tuple: unknown,
  context: PositionDetailContext,
): PositionDetails | null {
  if (!Array.isArray(tuple) || tuple.length < 9) return null;
  const details = base(tuple[0], tuple[1], tuple[2], "open", context);
  if (!details) return null;
  const read = reader(details);
  const instrument =
    context.instrument ?? verifiedPositionInstrument(details.instrumentId);
  if (instrument?.id === details.instrumentId) {
    details.symbol = read(instrument.symbol, symbol, "Market symbol");
    details.priceScaleRaw = read(
      instrument.priceScaleRaw,
      (value): value is string => unsigned(value) && value !== "0",
      "Price scale",
    );
    if (details.priceScaleRaw !== null)
      details.provenance.priceScaleSource = "verified-instrument";
  } else
    details.warnings.push(
      "Instrument metadata is unavailable; raw prices have no verified display scale.",
    );
  details.funding =
    tuple[3] === true
      ? "queued-balance"
      : tuple[3] === false
        ? "cash"
        : "unknown";
  if (details.funding === "unknown")
    details.warnings.push("Margin funding type is unavailable or invalid.");
  details.entryPriceRaw = read(tuple[4], unsigned, "Entry price");
  marginAndLeverage(details, tuple[5], tuple[6]);
  details.bustPriceRaw = read(tuple[7], unsigned, "Bust price");
  details.openedAt = read(tuple[8], timestamp, "Opening time");
  if (
    details.openedAt !== null &&
    details.openedAt <= context.asOf &&
    (details.provenance.receivedAt === null ||
      details.openedAt - details.provenance.receivedAt <= 30_000)
  ) {
    details.ageMs = context.asOf - details.openedAt;
    details.provenance.derivedFields.push("ageMs");
  } else
    details.warnings.push(
      "Open-position age is unavailable because the opening time is missing or inconsistent.",
    );
  details.intentId = read(tuple[9], hash, "Opening intent ID", true);
  return details;
}
