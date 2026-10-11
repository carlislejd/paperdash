import type { WalletSnapshot } from "./types.js";
import {
  normalizeOpenPosition,
  verifiedPositionInstrument,
  type PositionDetails,
} from "./position-details.js";

export interface RiskReference {
  instrumentId: number;
  symbol: string;
  priceUsd: number;
  /** Approximate numeric source representation, scaled to 18 decimals. */
  priceRaw: string;
  sourceAt: number;
  receivedAt: number;
  stale: boolean;
  source: "hyperliquid-bbo-mid";
}
export interface MarginRiskTotals {
  positionCount: number;
  initialMarginRaw: string;
  cashMarginRaw: string;
  queuedMarginRaw: string;
}
export type MarginRiskBandKey =
  | "at-or-beyond"
  | "0-10"
  | "10-25"
  | "25-50"
  | "50-100"
  | "100-500"
  | "over-500";
export interface MarginRiskBand {
  key: MarginRiskBandKey;
  lowerBps: number | null;
  upperBps: number | null;
  long: MarginRiskTotals;
  short: MarginRiskTotals;
}
export interface MarginRiskPosition {
  positionId: string;
  instrumentId: number;
  side: "long" | "short";
  funding: "cash" | "queued-balance";
  initialMarginRaw: string;
  bustPriceRaw: string;
  priceScaleRaw: string;
  /** Signed display distance; band selection and sorting use exact integers. */
  distanceBps: number;
  atOrBeyond: boolean;
}
export interface WalletAssetRisk {
  instrumentId: number;
  symbol: string;
  priceScaleRaw: string;
  reference: RiskReference | null;
  totals: MarginRiskTotals;
  bands: MarginRiskBand[] | null;
  nearest: MarginRiskPosition[];
}
export interface WalletMarginRiskResponse {
  address: string;
  asOf: number;
  snapshot: {
    sourceAt: number;
    receivedAt: number | null;
    indexedThroughBlock: number;
    accountRevision: number;
    stale: boolean;
  } | null;
  references: RiskReference[];
  assets: WalletAssetRisk[];
  coverage: {
    scope: "wallet-snapshot";
    partial: true;
    snapshotPositionCount: number | null;
    includedCount: number;
    excludedCount: number;
    /** Number of rows excluded because their wallet-scoped ID repeats. */
    duplicateCount: number;
  };
  stale: boolean;
  error?: string;
}
export interface MarginRiskContext {
  address: string;
  asOf: number;
  snapshotReceivedAt: number | null;
  snapshotStale: boolean;
  references: RiskReference[];
  error?: string;
}

const usdScale = 10n ** 18n;
const maxUint = (1n << 256n) - 1n;
const integer = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const time = (n: unknown): n is number => integer(n) && n <= 8.64e15;
const id = (n: unknown): n is string =>
  typeof n === "string" &&
  n.length <= 78 &&
  /^(0|[1-9]\d*)$/.test(n) &&
  BigInt(n) <= maxUint;
const address = (value: unknown): value is string =>
  typeof value === "string" && /^0x[\da-fA-F]{40}$/.test(value);

/** Preserve the decimal representation supplied by the numeric quote source.
 * This is not a protocol-scale mark and must not be advertised as one. */
export function referencePriceRaw(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const [coefficient, exponent = "0"] = value.toString().split("e");
  const [whole, fraction = ""] = coefficient.split(".");
  const shift = 18 + Number(exponent) - fraction.length;
  const digits = BigInt(whole + fraction);
  const raw =
    shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
  const result = raw.toString();
  return raw > 0n && result.length <= 79 ? result : null;
}

const emptyTotals = (): MarginRiskTotals => ({
  positionCount: 0,
  initialMarginRaw: "0",
  cashMarginRaw: "0",
  queuedMarginRaw: "0",
});
function add(total: MarginRiskTotals, position: PositionDetails) {
  const margin = BigInt(position.initialMarginRaw!);
  total.positionCount++;
  total.initialMarginRaw = (BigInt(total.initialMarginRaw) + margin).toString();
  const field =
    position.funding === "cash" ? "cashMarginRaw" : "queuedMarginRaw";
  total[field] = (BigInt(total[field]) + margin).toString();
}
const bandBounds: [MarginRiskBandKey, number | null, number | null][] = [
  ["at-or-beyond", null, 0],
  ["0-10", 0, 10],
  ["10-25", 10, 25],
  ["25-50", 25, 50],
  ["50-100", 50, 100],
  ["100-500", 100, 500],
  ["over-500", 500, null],
];
const newBands = (): MarginRiskBand[] =>
  bandBounds.map(([key, lowerBps, upperBps]) => ({
    key,
    lowerBps,
    upperBps,
    long: emptyTotals(),
    short: emptyTotals(),
  }));
function references(context: MarginRiskContext): RiskReference[] {
  const selected = new Map<number, RiskReference>();
  for (const value of context.references) {
    const instrument = verifiedPositionInstrument(value.instrumentId);
    const raw = referencePriceRaw(value.priceUsd);
    if (
      !instrument ||
      value.symbol !== instrument.symbol ||
      value.source !== "hyperliquid-bbo-mid" ||
      raw === null ||
      raw !== value.priceRaw ||
      !time(value.sourceAt) ||
      !time(value.receivedAt) ||
      value.sourceAt > context.asOf + 30_000 ||
      value.receivedAt > context.asOf + 30_000 ||
      value.sourceAt > value.receivedAt + 30_000
    )
      continue;
    const current = selected.get(value.instrumentId);
    if (
      current &&
      (current.sourceAt > value.sourceAt ||
        (current.sourceAt === value.sourceAt &&
          current.receivedAt >= value.receivedAt))
    )
      continue;
    selected.set(value.instrumentId, {
      ...value,
      stale: Boolean(
        value.stale ||
        context.asOf - value.sourceAt > 30_000 ||
        context.asOf - value.receivedAt > 30_000,
      ),
    });
  }
  return [...selected.values()].sort((a, b) => a.instrumentId - b.instrumentId);
}

/** A hypothetical comparison against recorded bust thresholds, not liquidation
 * eligibility, predicted loss or a complete global position inventory. Terminal
 * market metadata and a matching protocol-block quote are not in this snapshot. */
export function buildWalletMarginRisk(
  snapshot: WalletSnapshot | null,
  context: MarginRiskContext,
): WalletMarginRiskResponse {
  if (!address(context.address) || !time(context.asOf))
    throw new Error("Invalid margin-risk context");
  const result: WalletMarginRiskResponse = {
    address: context.address.toLowerCase(),
    asOf: context.asOf,
    snapshot: null,
    references: references(context),
    assets: [],
    coverage: {
      scope: "wallet-snapshot",
      partial: true,
      snapshotPositionCount: null,
      includedCount: 0,
      excludedCount: 0,
      duplicateCount: 0,
    },
    stale: true,
    ...(context.error ? { error: context.error } : {}),
  };
  if (!snapshot) return result;
  const rows = snapshot.openPositions;
  const sourceAt = snapshot.indexedThroughTimestamp * 1000;
  if (
    !address(snapshot.address) ||
    snapshot.address.toLowerCase() !== result.address ||
    !Array.isArray(rows) ||
    rows.length > 10_000 ||
    !integer(snapshot.indexedThroughTimestamp) ||
    !time(sourceAt) ||
    sourceAt > context.asOf + 30_000 ||
    !integer(snapshot.indexedThroughBlock) ||
    !integer(snapshot.accountRevision)
  ) {
    result.error =
      context.error ?? "Wallet snapshot is unavailable or invalid.";
    return result;
  }
  const receivedAt = time(context.snapshotReceivedAt)
    ? context.snapshotReceivedAt
    : null;
  const snapshotStale = Boolean(
    context.snapshotStale ||
    receivedAt === null ||
    receivedAt > context.asOf + 30_000 ||
    sourceAt > (receivedAt ?? context.asOf) + 30_000 ||
    context.asOf - receivedAt > 30_000 ||
    context.asOf - sourceAt > 30_000,
  );
  result.snapshot = {
    sourceAt,
    receivedAt,
    indexedThroughBlock: snapshot.indexedThroughBlock,
    accountRevision: snapshot.accountRevision,
    stale: snapshotStale,
  };
  result.coverage.snapshotPositionCount = rows.length;
  const ids = new Map<string, number>();
  for (const row of rows) {
    if (Array.isArray(row) && id(row[0]))
      ids.set(row[0], (ids.get(row[0]) ?? 0) + 1);
  }
  const groups = new Map<number, PositionDetails[]>();
  for (const row of rows) {
    if (Array.isArray(row) && id(row[0]) && ids.get(row[0])! > 1) {
      result.coverage.duplicateCount++;
      result.coverage.excludedCount++;
      continue;
    }
    const position = normalizeOpenPosition(row, {
      walletAddress: result.address,
      receivedAt,
      asOf: context.asOf,
    });
    if (
      !position ||
      position.symbol === null ||
      position.priceScaleRaw === null ||
      position.funding === "unknown" ||
      position.initialMarginRaw === null ||
      position.bustPriceRaw === null ||
      position.entryPriceRaw === null ||
      position.entryPriceRaw === "0" ||
      position.leverage === null ||
      position.ageMs === null ||
      position.openedAt! > sourceAt + 30_000
    ) {
      result.coverage.excludedCount++;
      continue;
    }
    // A zero bust is representable in the source and can be valid for a long.
    const group = groups.get(position.instrumentId) ?? [];
    group.push(position);
    groups.set(position.instrumentId, group);
    result.coverage.includedCount++;
  }
  for (const [instrumentId, positions] of [...groups].sort(
    ([a], [b]) => a - b,
  )) {
    const instrument = verifiedPositionInstrument(instrumentId)!;
    const reference =
      result.references.find((r) => r.instrumentId === instrumentId) ?? null;
    const asset: WalletAssetRisk = {
      instrumentId,
      symbol: instrument.symbol,
      priceScaleRaw: instrument.priceScaleRaw,
      reference,
      totals: emptyTotals(),
      bands: reference ? newBands() : null,
      nearest: [],
    };
    const candidates: { position: MarginRiskPosition; magnitude: bigint }[] =
      [];
    for (const position of positions) {
      add(asset.totals, position);
      if (!reference || !asset.bands) continue;
      const denominator =
        BigInt(reference.priceRaw) * BigInt(instrument.priceScaleRaw);
      const difference =
        denominator - BigInt(position.bustPriceRaw!) * usdScale;
      const numerator = position.side === "long" ? difference : -difference;
      const bpsNumerator = numerator * 10_000n;
      const band = asset.bands.find(
        (b) =>
          b.upperBps === null ||
          bpsNumerator <= BigInt(b.upperBps) * denominator,
      )!;
      add(band[position.side], position);
      candidates.push({
        magnitude: numerator < 0n ? -numerator : numerator,
        position: {
          positionId: position.positionId,
          instrumentId,
          side: position.side,
          funding: position.funding as "cash" | "queued-balance",
          initialMarginRaw: position.initialMarginRaw!,
          bustPriceRaw: position.bustPriceRaw!,
          priceScaleRaw: instrument.priceScaleRaw,
          distanceBps: Number((bpsNumerator * 10_000n) / denominator) / 10_000,
          atOrBeyond: numerator <= 0n,
        },
      });
    }
    candidates.sort((a, b) =>
      a.magnitude < b.magnitude
        ? -1
        : a.magnitude > b.magnitude
          ? 1
          : BigInt(a.position.positionId) < BigInt(b.position.positionId)
            ? -1
            : 1,
    );
    asset.nearest = candidates.slice(0, 5).map((c) => c.position);
    result.assets.push(asset);
  }
  result.stale =
    snapshotStale ||
    result.assets.some((asset) => !asset.reference || asset.reference.stale);
  return result;
}
