import type { ChartPoint } from "./types.js";

/** Decode only real source TVL; keep bucketing and raw-unit conversion identical. */
export function readLiveTvl(
  summary: unknown,
): { point: ChartPoint; sourceAt: number } | null {
  if (!summary || typeof summary !== "object") return null;
  const value = summary as {
    ok?: unknown;
    source?: { at?: unknown };
    balances?: { tvl?: unknown };
  };
  const at = value.source?.at;
  const raw = value.balances?.tvl;
  if (
    value.ok !== true ||
    typeof at !== "number" ||
    !Number.isSafeInteger(at) ||
    at < 0 ||
    typeof raw !== "string" ||
    raw.length > 78 ||
    !/^(0|[1-9]\d*)$/.test(raw)
  )
    return null;
  const tvl = Number(BigInt(raw)) / 1e18;
  if (!Number.isFinite(tvl)) return null;
  return {
    point: { time: Math.floor(at / 60000) * 60000, value: tvl },
    sourceAt: at,
  };
}
