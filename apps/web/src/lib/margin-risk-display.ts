import type {
  MarginRiskBandKey,
  MarginRiskTotals,
  MarginRiskPosition,
  WalletAssetRisk,
  WalletMarginRiskResponse,
} from "../../../../packages/shared/src/margin-risk";
import type { WalletSnapshot } from "../../../../packages/shared/src/types";
import { formatRawUsd, rawToNumber } from "./format";
import { formatChartNumber } from "./chart-data";

export const riskBandLabels: Record<MarginRiskBandKey, string> = {
  "at-or-beyond": "At / beyond",
  "0-10": "0–0.1%",
  "10-25": "0.1–0.25%",
  "25-50": "0.25–0.5%",
  "50-100": "0.5–1%",
  "100-500": "1–5%",
  "over-500": ">5%",
};

export function riskMatchesSnapshot(
  risk: WalletMarginRiskResponse | undefined,
  snapshot: WalletSnapshot | null,
  address: string,
): boolean {
  return Boolean(
    risk &&
      snapshot &&
      risk.snapshot &&
      risk.address.toLowerCase() === address.toLowerCase() &&
      snapshot.address.toLowerCase() === address.toLowerCase() &&
      risk.snapshot.accountRevision === snapshot.accountRevision &&
      risk.snapshot.indexedThroughBlock === snapshot.indexedThroughBlock &&
      risk.snapshot.sourceAt === snapshot.indexedThroughTimestamp * 1000,
  );
}

export function riskMoney(raw: string): string {
  const value = rawToNumber(raw);
  return value !== null && Math.abs(value) >= 1e15
    ? `$${formatChartNumber(value)}`
    : formatRawUsd(raw, true);
}

export function riskDistanceText(
  position: Pick<MarginRiskPosition, "atOrBeyond" | "distanceBps">,
): string {
  if (position.atOrBeyond) return "At / beyond";
  const percent = Math.abs(position.distanceBps) / 100;
  if (percent < 0.001) return "<0.001%";
  return `${percent.toLocaleString("en-US", { maximumFractionDigits: 3 })}%`;
}

export function riskBarMaximum(asset: WalletAssetRisk): bigint {
  return (asset.bands ?? []).reduce((maximum, band) => {
    const long = BigInt(band.long.initialMarginRaw),
      short = BigInt(band.short.initialMarginRaw);
    return long > maximum
      ? short > long
        ? short
        : long
      : short > maximum
        ? short
        : maximum;
  }, 0n);
}

/** Ratios are calculated as bounded integers even for uint256-sized margins. */
export function riskBarWidths(totals: MarginRiskTotals, maximum: bigint) {
  if (maximum <= 0n) return { cash: 0, queued: 0 };
  return {
    cash: Number((BigInt(totals.cashMarginRaw) * 10000n) / maximum) / 100,
    queued: Number((BigInt(totals.queuedMarginRaw) * 10000n) / maximum) / 100,
  };
}

export interface MarginRiskExportSnapshot {
  asset: WalletAssetRisk;
  address: string;
  name: string | null;
  snapshotAt: number;
  stale: boolean;
  includedCount: number;
  excludedCount: number;
}
