import type {
  AssetMarketResponse,
  MarketSegment,
} from "../../../../packages/shared/src/types";

/** Never relabel an old/all-trader payload as a classified cohort. */
export function acceptsMarketSegment(
  data: AssetMarketResponse | null | undefined,
  instrument: number,
  segment: MarketSegment,
  now = Date.now(),
  failed = false,
): data is AssetMarketResponse {
  if (!data || data.instrument !== instrument) return false;
  if (segment === "all") return !data.segment || data.segment === "all";
  const coverage = data.segmentCoverage;
  if (
    failed ||
    data.segment !== "profitable" ||
    !Array.isArray(data.trades) ||
    !Array.isArray(data.points) ||
    !coverage ||
    coverage.basis !== "positive-lifetime-realized-trading-pnl" ||
    coverage.maxAccountAgeMs !== 300_000 ||
    !Number.isSafeInteger(coverage.classifiedAt) ||
    coverage.classifiedAt < 0 ||
    coverage.classifiedAt > now + 30_000 ||
    now - coverage.classifiedAt > 60_000
  )
    return false;
  const counts = [
    coverage.observedWallets,
    coverage.classifiedWallets,
    coverage.profitableWallets,
    coverage.unknownWallets,
  ];
  if (
    !counts.every((value) => Number.isSafeInteger(value) && value >= 0) ||
    coverage.classifiedWallets + coverage.unknownWallets !==
      coverage.observedWallets ||
    coverage.profitableWallets > coverage.classifiedWallets
  )
    return false;
  const { oldestAccountReceivedAt: oldest, newestAccountReceivedAt: newest } =
    coverage;
  return coverage.classifiedWallets === 0
    ? oldest === null && newest === null
    : Number.isSafeInteger(oldest) &&
        Number.isSafeInteger(newest) &&
        oldest! >= coverage.classifiedAt - coverage.maxAccountAgeMs &&
        oldest! <= newest! &&
        newest! <= coverage.classifiedAt;
}
