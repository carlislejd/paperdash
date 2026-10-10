import type {
  HouseResponse,
  ProtocolSummary,
} from "../../../packages/shared/src/types.js";
import type { Store } from "./store.js";
import { houseSchema } from "./assets.js";
import type { HousePoint, HouseSample, HouseStore } from "./house-store.js";
export type { HouseResponse } from "../../../packages/shared/src/types.js";
type HouseContext = Pick<Store, "get" | "put"> & { house: HouseStore };
interface SavedHouse extends HouseResponse {
  summaryReceivedAt: number | null;
}

/** Decimal representation of the numeric wire value, scaled to 18 decimals; never Number(value * 1e18). */
export function signedSourceUsdRaw(value: number): string {
  if (!Number.isFinite(value)) throw new Error("Invalid house USD value");
  const [coefficient, exponent = "0"] = Math.abs(value).toString().split("e");
  const [whole, fraction = ""] = coefficient.split(".");
  const shift = 18 + Number(exponent) - fraction.length;
  const digits = BigInt(whole + fraction);
  const magnitude =
    shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
  const result = (value < 0 ? -magnitude : magnitude).toString();
  if (result.length > 79)
    throw new Error("House USD value exceeds supported raw range");
  return result;
}
export function normalizeHouse(
  input: unknown,
  receivedAt = Date.now(),
): HouseSample {
  const source = houseSchema.parse(input);
  if (
    !Number.isSafeInteger(receivedAt) ||
    receivedAt < 0 ||
    source.sourceAsOfMs > receivedAt + 30000
  )
    throw new Error("Invalid house receipt/source timestamp");
  const lpRaw = signedSourceUsdRaw(source.head[1]);
  const openPnlRaw = (-BigInt(signedSourceUsdRaw(source.head[2]))).toString();
  const queueDebtRaw = signedSourceUsdRaw(source.head[3]);
  return {
    sourceAt: source.sourceAsOfMs,
    receivedAt,
    generation: source.historyGeneration,
    revision: source.historyRevision,
    house: {
      lpRaw,
      openPnlRaw,
      queueDebtRaw,
      fundsRaw: (
        BigInt(lpRaw) +
        BigInt(openPnlRaw) -
        BigInt(queueDebtRaw)
      ).toString(),
    },
  };
}
export async function retainHouseSource(
  store: HouseContext,
  input: unknown,
  receivedAt = Date.now(),
): Promise<void> {
  if (!(await store.house.sample(normalizeHouse(input, receivedAt))))
    throw new Error(
      "House source moved backward; retaining the newer observation",
    );
}
/** Thin only for the saved response; durable minute samples remain intact. Preserve any skipped gap. */
export function thinHouseHistory(
  points: HousePoint[],
  limit = 300,
): HousePoint[] {
  if (points.length <= limit) return points;
  const chosen: HousePoint[] = [];
  let previous = -1;
  for (let i = 0; i < limit; i++) {
    const index = Math.round((i * (points.length - 1)) / (limit - 1));
    const gap = points
      .slice(previous + 1, index + 1)
      .some((point) => point.gapBefore);
    chosen.push({ ...points[index], ...(gap ? { gapBefore: true } : {}) });
    previous = index;
  }
  return chosen;
}
function empty(): HouseResponse {
  return {
    sourceAt: null,
    receivedAt: null,
    stale: true,
    house: null,
    paper: {
      supplyRaw: null,
      stakedRaw: null,
      stakerRewardsRaw: null,
      pendingRewardsRaw: null,
    },
    sourceBlock: null,
    summarySourceAt: null,
    history: [],
    coverage: {
      source: "retained-house-observations",
      approximate: true,
      observedFrom: null,
      partial: true,
    },
  };
}
export async function refreshHouse(
  store: HouseContext,
  now = Date.now(),
): Promise<void> {
  const [retained, summary] = await Promise.all([
    store.house.read(now),
    store.get<ProtocolSummary>("summary"),
  ]);
  const latest = retained.latest;
  const data: SavedHouse = {
    ...empty(),
    sourceAt: latest?.sourceAt ?? null,
    receivedAt: latest?.receivedAt ?? null,
    house: latest?.house ?? null,
    paper: {
      supplyRaw: summary?.value.paper.supply ?? null,
      stakedRaw: summary?.value.paper.staked ?? null,
      stakerRewardsRaw: summary?.value.fees.lifetime ?? null,
      pendingRewardsRaw: summary?.value.paper.pendingRewards ?? null,
    },
    sourceBlock: summary?.value.source.block ?? null,
    summarySourceAt: summary?.value.source.at ?? null,
    summaryReceivedAt: summary?.receivedAt ?? null,
    history: thinHouseHistory(retained.history),
    coverage: {
      source: "retained-house-observations",
      approximate: true,
      observedFrom: retained.observedFrom,
      partial: true,
    },
  };
  data.stale =
    !latest ||
    now - latest.sourceAt > 30000 ||
    latest.sourceAt > now + 30000 ||
    now - latest.receivedAt > 30000 ||
    latest.receivedAt > now + 30000 ||
    !summary ||
    now - summary.receivedAt > 30000 ||
    summary.receivedAt > now + 30000 ||
    now - summary.value.source.at > 30000 ||
    summary.value.source.at > now + 30000;
  await store.put("house", data, now);
}
export async function readHouse(
  store: Pick<Store, "get">,
  now = Date.now(),
): Promise<HouseResponse> {
  const [saved, heartbeat] = await Promise.all([
    store.get<SavedHouse>("house"),
    store.get<{ at: number; errors?: Record<string, string> }>(
      "collector-heartbeat",
    ),
  ]);
  if (!saved)
    return { ...empty(), error: "Waiting for the first house observation." };
  const { summaryReceivedAt, ...data } = saved.value;
  const houseDelayed =
    data.sourceAt === null ||
    data.receivedAt === null ||
    now - data.sourceAt > 30000 ||
    data.sourceAt > now + 30000 ||
    now - data.receivedAt > 30000 ||
    data.receivedAt > now + 30000 ||
    Boolean(heartbeat?.value.errors?.["asset-market"]);
  const summaryDelayed =
    data.summarySourceAt === null ||
    summaryReceivedAt === null ||
    now - data.summarySourceAt > 30000 ||
    data.summarySourceAt > now + 30000 ||
    now - summaryReceivedAt > 30000 ||
    summaryReceivedAt > now + 30000 ||
    Boolean(heartbeat?.value.errors?.summary);
  const collectorDelayed =
    !heartbeat ||
    now - heartbeat.value.at > 30000 ||
    heartbeat.value.at > now + 30000 ||
    now - saved.receivedAt > 15000 ||
    Boolean(heartbeat.value.errors?.["house"]);
  const stale =
    data.stale || houseDelayed || summaryDelayed || collectorDelayed;
  return {
    ...data,
    stale,
    ...(stale
      ? {
          error: houseDelayed
            ? "House observations are delayed."
            : summaryDelayed
              ? "PAPER protocol summary is delayed."
              : "House collector snapshot is delayed.",
        }
      : {}),
  };
}
