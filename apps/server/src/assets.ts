import { z } from "zod";
import type {
  AssetActivity,
  AssetOiSample,
  AssetsResponse,
  AssetSummary,
} from "../../../packages/shared/src/types.js";
import type { Store } from "./store.js";
import { activityDelayed } from "./activity-health.js";

const time = z.number().int().nonnegative().safe();
const usd = z.number().finite().nonnegative();
export const houseSchema = z
  .object({
    ok: z.literal(true),
    historyGeneration: z.string().min(1).max(500),
    historyRevision: z.string().min(1).max(1000),
    sourceAsOfMs: time,
    head: z.tuple([
      time,
      z.number().finite(),
      z.number().finite(),
      usd,
      usd,
      usd,
      usd,
      usd,
    ]),
  })
  .refine(
    (value) => value.head[0] === value.sourceAsOfMs,
    "House snapshot timestamp mismatch",
  );
export type HouseSnapshot = z.infer<typeof houseSchema>;

/** Preserve the decimal representation supplied by the source, including exponent notation. */
export function sourceUsdRaw(value: number): string {
  if (!Number.isFinite(value) || value < 0)
    throw new Error("Invalid source notional");
  const [coefficient, exponent = "0"] = value.toString().split("e");
  const [whole, fraction = ""] = coefficient.split(".");
  const shift = 18 + Number(exponent) - fraction.length;
  const digits = BigInt(whole + fraction);
  return (
    shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift)
  ).toString();
}

// The official house-exposure chart labels the opposite house side. The wire
// columns bl/bs and el/es themselves map to TRADER long/short entry notionals.
const instruments = [
  { instrument: 0, symbol: "BTC", long: 4, short: 5 },
  { instrument: 1, symbol: "ETH", long: 6, short: 7 },
] as const;

export function assetNotionals(
  source: HouseSnapshot,
): Omit<AssetSummary, "activity" | "history">[] {
  return instruments.map(({ instrument, symbol, long, short }) => {
    const longRaw = sourceUsdRaw(source.head[long]);
    const shortRaw = sourceUsdRaw(source.head[short]);
    const total = BigInt(longRaw) + BigInt(shortRaw);
    const longSharePct =
      total === 0n
        ? null
        : Number((BigInt(longRaw) * 1000000n) / total) / 10000;
    return {
      instrument,
      symbol,
      openInterest: {
        longRaw,
        shortRaw,
        totalRaw: total.toString(),
        longSharePct,
        shortSharePct: longSharePct === null ? null : 100 - longSharePct,
      },
    };
  });
}

export async function retainAssetSource(
  store: Store,
  input: unknown,
  receivedAt = Date.now(),
): Promise<void> {
  const source = houseSchema.parse(input);
  if (source.sourceAsOfMs > receivedAt + 30000)
    throw new Error("Asset source timestamp is in the future");
  const previous = await store.get<HouseSnapshot>("asset-source");
  if (previous && source.sourceAsOfMs < previous.value.sourceAsOfMs)
    throw new Error(
      "Asset source moved backward; retaining the newer snapshot",
    );
  for (const asset of assetNotionals(source)) {
    await store.analytics.sample({
      instrument: asset.instrument,
      time: Math.floor(source.sourceAsOfMs / 60000) * 60000,
      longRaw: asset.openInterest.longRaw,
      shortRaw: asset.openInterest.shortRaw,
      sourceBlock: null,
      sourceAt: source.sourceAsOfMs,
      receivedAt,
    });
  }
  await store.put("asset-source", source, receivedAt);
}

interface RetainedAnalytics {
  activity: AssetActivity[];
  history: Record<number, AssetOiSample[]>;
}
const MINUTE_MS = 60000;
const DAY_MS = 86400000;
const HISTORY_LIMIT = 300;
const validClock = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Join the saved head to its older chart publication without changing storage. */
function alignAssetHistory(
  points: AssetOiSample[],
  asset: Omit<AssetSummary, "activity" | "history">,
  sourceAt: number,
  receivedAt: number,
  now: number,
): { history: AssetOiSample[]; regressed: boolean } {
  const byMinute = new Map<number, AssetOiSample>();
  for (const point of points) {
    if (
      point.instrument !== asset.instrument ||
      !validClock(point.time) ||
      !validClock(point.sourceAt) ||
      !validClock(point.receivedAt) ||
      point.time !== Math.floor(point.sourceAt / MINUTE_MS) * MINUTE_MS ||
      point.sourceAt > now + 30000 ||
      point.receivedAt > now + 30000 ||
      point.sourceAt > point.receivedAt + 30000 ||
      point.time < sourceAt - DAY_MS ||
      typeof point.longRaw !== "string" ||
      typeof point.shortRaw !== "string" ||
      !/^\d+$/.test(point.longRaw) ||
      !/^\d+$/.test(point.shortRaw)
    )
      continue;
    const saved = byMinute.get(point.time);
    if (!saved || point.sourceAt >= saved.sourceAt)
      byMinute.set(point.time, point);
  }
  const history = [...byMinute.values()].sort((a, b) => a.time - b.time);
  // The independent reads can straddle a collector publication. Never replace
  // a newer recorded observation with the older head captured by this read.
  if ((history.at(-1)?.sourceAt ?? -1) > sourceAt)
    return { history: history.slice(-HISTORY_LIMIT), regressed: true };
  const head: AssetOiSample = {
    instrument: asset.instrument,
    time: Math.floor(sourceAt / MINUTE_MS) * MINUTE_MS,
    longRaw: asset.openInterest.longRaw,
    shortRaw: asset.openInterest.shortRaw,
    sourceBlock: null,
    sourceAt,
    receivedAt,
  };
  if (history.at(-1)?.time === head.time) history[history.length - 1] = head;
  else history.push(head);
  return { history: history.slice(-HISTORY_LIMIT), regressed: false };
}
function thinHistory(
  points: AssetOiSample[],
  limit = HISTORY_LIMIT,
): AssetOiSample[] {
  if (points.length <= limit) return points;
  return Array.from(
    { length: limit },
    (_, index) =>
      points[Math.round((index * (points.length - 1)) / (limit - 1))],
  );
}
export async function refreshAssetAnalytics(
  store: Store,
  now = Date.now(),
): Promise<void> {
  const ids = instruments.map((asset) => asset.instrument);
  const activity = await store.analytics.activity(ids, now);
  const history: RetainedAnalytics["history"] = {};
  for (const id of ids)
    history[id] = thinHistory(
      await store.analytics.samples(id, now - 86400000, 1440),
    );
  await store.put(
    "asset-analytics",
    { activity, history } satisfies RetainedAnalytics,
    now,
  );
}
export async function readAssets(
  store: Store,
  now = Date.now(),
): Promise<AssetsResponse> {
  const [savedSource, analytics, collectionDelayed] = await Promise.all([
    store.get<HouseSnapshot>("asset-source"),
    store.get<RetainedAnalytics>("asset-analytics"),
    activityDelayed(store, now),
  ]);
  const parsed = houseSchema.safeParse(savedSource?.value);
  const source =
    savedSource &&
    parsed.success &&
    validClock(savedSource.receivedAt) &&
    savedSource.receivedAt <= now + 30000 &&
    parsed.data.sourceAsOfMs <= now + 30000 &&
    parsed.data.sourceAsOfMs <= savedSource.receivedAt + 30000
      ? { ...savedSource, value: parsed.data }
      : null;
  let historyRegressed = false;
  const assets = source
    ? assetNotionals(source.value).map((asset) => {
        const aligned = alignAssetHistory(
          analytics?.value.history[asset.instrument] ?? [],
          asset,
          source.value.sourceAsOfMs,
          source.receivedAt,
          now,
        );
        historyRegressed ||= aligned.regressed;
        return {
          ...asset,
          activity:
            analytics?.value.activity.find(
              (row) => row.instrument === asset.instrument,
            ) ?? null,
          history: aligned.history,
        };
      })
    : [];
  const marketStale =
    !source ||
    historyRegressed ||
    now - source.receivedAt > 20000 ||
    now - source.value.sourceAsOfMs > 30000;
  const activityStale =
    !analytics || now - analytics.receivedAt > 30000 || collectionDelayed;
  return {
    assets,
    sourceAt: source?.value.sourceAsOfMs ?? null,
    indexedBlock: null,
    receivedAt: source?.receivedAt ?? null,
    activityReceivedAt: analytics?.receivedAt ?? null,
    stale: marketStale || activityStale,
    ...(!source
      ? { error: "Asset snapshots are being collected." }
      : marketStale
        ? { error: "Showing the last saved asset snapshot." }
        : activityStale
          ? { error: "Trade activity snapshot is delayed." }
          : {}),
  };
}
