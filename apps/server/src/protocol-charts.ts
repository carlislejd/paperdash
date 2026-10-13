import type { z } from "zod";
import type {
  AnnualizedStakingRevenue,
  PaperEconomicsResponse,
  ProtocolChartPoint,
  ProtocolChartMetric,
  ProtocolChartSeries,
  ProtocolChartsResponse,
  ProtocolSummary,
} from "../../../packages/shared/src/types.js";
import type { Store } from "./store.js";
import type { ProtocolChartObservation } from "./history-store.js";
import { protocolHistorySchema } from "./schemas.js";
import { snapshotPanelRevision, type PanelPublication } from "./panel-revisions.js";

const HOUR = 3600000;
const DAY = 86400000;
// Summary polling is not a midnight checkpoint. Only accept a baseline near
// that boundary, and always label such observed daily intervals as partial.
const DAY_BOUNDARY_TOLERANCE = 60000;
const YEAR = 365 * 86400000;
// Official production deployment genesisMs, also returned by summary.source.genesis.
// An unknown deployment must not annualize from an assumed first chart sample.
export const VERIFIED_PROTOCOL_GENESIS = 1791326520000;
const METRICS: ProtocolChartMetric[] = [
  "tvl",
  "openPositions",
  "volume",
  "paperSupply",
  "paperStaked",
  "stakingRewards",
];
type Context = Pick<Store, "get" | "put" | "history">;
const rawNumber = (raw: string) => Number(BigInt(raw)) / 1e18;

export function annualizedStakingRevenue(
  summary: ProtocolSummary | null,
  now = Date.now(),
): AnnualizedStakingRevenue {
  const base: AnnualizedStakingRevenue = {
    usdPerYearRaw: null,
    lifetimeRewardsRaw: summary?.fees.lifetime ?? null,
    fromMs: summary?.source.genesis ?? null,
    toMs: summary?.source.at ?? null,
    basis: "protocol-lifetime",
    yearDays: 365,
  };
  if (!summary || summary.source.genesis !== VERIFIED_PROTOCOL_GENESIS)
    return { ...base, reason: "Verified protocol lifetime is unavailable." };
  const elapsed = summary.source.at - summary.source.genesis;
  if (
    !Number.isSafeInteger(elapsed) ||
    elapsed <= 0 ||
    !Number.isSafeInteger(now) ||
    summary.source.at > now + 30000 ||
    !/^(0|[1-9]\d*)$/.test(summary.fees.lifetime)
  )
    return {
      ...base,
      reason: "Protocol lifetime or cumulative rewards are invalid.",
    };
  return {
    ...base,
    usdPerYearRaw: (
      (BigInt(summary.fees.lifetime) * BigInt(YEAR)) /
      BigInt(elapsed)
    ).toString(),
  };
}

export async function retainProtocolChartSummary(
  store: Context,
  summary: ProtocolSummary,
  now = Date.now(),
): Promise<void> {
  const at = summary.source.at;
  if (!Number.isSafeInteger(at) || at < 0 || at > now + 30000)
    throw new Error("Invalid protocol summary chart timestamp");
  await store.history.retainProtocolCharts("summary", [
    summaryObservation(summary),
  ]);
}
function summaryObservation(
  summary: ProtocolSummary,
): ProtocolChartObservation {
  const at = summary.source.at;
  return {
    time: Math.floor(at / HOUR) * HOUR,
    endpointAt: at,
    sourceAt: at,
    generation: `genesis:${summary.source.genesis ?? "unknown"}`,
    complete: false,
    values: {
      tvl: rawNumber(summary.balances.tvl),
      openPositions: summary.activity.open,
      volume: rawNumber(summary.activity.volume),
      paperSupply: rawNumber(summary.paper.supply),
      paperStaked: rawNumber(summary.paper.staked),
      stakingRewards: rawNumber(summary.fees.lifetime),
    },
    volumeRaw: summary.activity.volume,
    paperSupplyRaw: summary.paper.supply,
    paperStakedRaw: summary.paper.staked,
    allocatedRewardsRaw: summary.fees.lifetime,
  };
}

export async function retainProtocolChartHistory(
  store: Context,
  history: z.infer<typeof protocolHistorySchema>,
  now = Date.now(),
): Promise<void> {
  if (
    ![60000, HOUR].includes(history.intervalMs) ||
    history.startMs % history.intervalMs ||
    history.source.asOfMs > now + 30000
  )
    throw new Error("Invalid protocol chart history interval/timestamp");
  const grouped = new Map<number, ProtocolChartObservation>();
  const currentHour = Math.floor(now / HOUR) * HOUR;
  for (let i = 0; i < history.columns.tvl.length; i++) {
    const at = history.startMs + i * history.intervalMs;
    const time = Math.floor(at / HOUR) * HOUR;
    if (time < currentHour - 169 * HOUR || at > history.source.asOfMs) continue;
    const values: ProtocolChartObservation["values"] = {};
    for (const metric of METRICS) {
      if (metric === "openPositions") continue;
      const column = history.columns[metric];
      if (!column) continue;
      const value = column[i];
      values[metric] =
        typeof value === "number" && Number.isFinite(value) && value >= 0
          ? value
          : null;
    }
    // Protocol history columns are bucket-end cumulative/snapshot values.
    // Keep the last source bucket, including explicit nulls, in each UTC hour.
    grouped.set(time, {
      time,
      endpointAt: Math.min(at + history.intervalMs - 1, history.source.asOfMs),
      sourceAt: history.source.asOfMs,
      generation: history.source.generation,
      complete:
        at + history.intervalMs >= time + HOUR &&
        history.source.asOfMs >= time + HOUR,
      values,
    });
  }
  await store.history.retainProtocolCharts(
    "history",
    [...grouped.values()].slice(-170),
  );
}

function emptySeries(metric: ProtocolChartMetric): ProtocolChartSeries {
  return {
    unit:
      metric === "openPositions"
        ? "positions"
        : metric.startsWith("paper")
          ? "PAPER"
          : "USD",
    aggregation:
      metric === "volume"
        ? "hourly-change"
        : metric === "stakingRewards"
          ? "cumulative"
          : "snapshot",
    points: [],
    source:
      metric === "openPositions"
        ? "retained-summary-observations"
        : "protocol-history-and-retained-summary",
    coverage: { observedFrom: null, partial: true },
  };
}
function empty(): ProtocolChartsResponse {
  return {
    receivedAt: null,
    sourceAt: null,
    stale: true,
    intervalMs: HOUR,
    series: Object.fromEntries(
      METRICS.map((key) => [key, emptySeries(key)]),
    ) as ProtocolChartsResponse["series"],
  };
}
function emptyEconomics(): PaperEconomicsResponse {
  return {
    sourceAt: null,
    receivedAt: null,
    stale: true,
    supplyRaw: null,
    stakedRaw: null,
    allocatedRewardsRaw: null,
    pendingRewardsRaw: null,
    stakeRatioBps: null,
    annualized: annualizedStakingRevenue(null),
    series: {
      supply: emptySeries("paperSupply"),
      staked: emptySeries("paperStaked"),
      allocated: emptySeries("stakingRewards"),
      supplyChange: {
        ...emptySeries("paperSupply"),
        aggregation: "hourly-change",
      },
      rewardAllocation: {
        ...emptySeries("stakingRewards"),
        aggregation: "hourly-change",
      },
    },
    daily: {
      intervalMs: DAY,
      timeZone: "UTC",
      supplyChange: {
        ...emptySeries("paperSupply"),
        aggregation: "daily-change",
      },
      rewardAllocation: {
        ...emptySeries("stakingRewards"),
        aggregation: "daily-change",
      },
    },
    coverage: { partial: true, historyApproximate: true },
  };
}

/** Calendar changes are calculated from coherent cumulative endpoints, never
 * summed from possibly missing hourly bars or joined across source namespaces. */
function dailySeries(
  metric: "paperSupply" | "stakingRewards",
  histories: ProtocolChartObservation[],
  summaries: ProtocolChartObservation[],
  now: number,
): ProtocolChartSeries {
  const today = Math.floor(now / DAY) * DAY;
  const firstDay = today - 6 * DAY;
  const rawField =
    metric === "paperSupply" ? "paperSupplyRaw" : "allocatedRewardsRaw";
  const origins = ([histories, summaries] as const).map((rows) => {
    const hours = new Map<number, ProtocolChartObservation>();
    for (const row of rows) {
      if (
        row.time < firstDay - HOUR ||
        row.time > now ||
        row.endpointAt > now + 30000
      )
        continue;
      const previous = hours.get(row.time);
      if (!previous || row.endpointAt >= previous.endpointAt)
        hours.set(row.time, row);
    }
    return hours;
  });
  function candidate(
    day: number,
    origin: "history" | "summary",
  ): ProtocolChartPoint | null {
    const hours = origins[origin === "history" ? 0 : 1];
    const baseline = hours.get(day - HOUR);
    const current = day === today;
    const last = current
      ? [...hours.values()]
          .filter((row) => row.time >= day && row.time < day + DAY)
          .sort((a, b) => a.endpointAt - b.endpointAt)
          .at(-1)
      : hours.get(day + DAY - HOUR);
    if (!baseline || !last || baseline.generation === "genesis:unknown")
      return null;
    if (origin === "history") {
      if (!baseline.complete || baseline.endpointAt !== day - 1) return null;
      if (!current && (!last.complete || last.endpointAt !== day + DAY - 1))
        return null;
    } else if (
      day - baseline.endpointAt > DAY_BOUNDARY_TOLERANCE ||
      (!current && day + DAY - last.endpointAt > DAY_BOUNDARY_TOLERANCE)
    )
      return null;
    let previous: ProtocolChartObservation | undefined;
    for (let time = baseline.time; time <= last.time; time += HOUR) {
      const row = hours.get(time);
      const value = row?.values[metric];
      if (
        !row ||
        value == null ||
        row.generation !== baseline.generation ||
        (origin === "history" && row !== last && !row.complete)
      )
        return null;
      if (metric === "stakingRewards" && previous) {
        const beforeRaw = previous[rawField],
          currentRaw = row[rawField];
        const decreased =
          beforeRaw !== undefined && currentRaw !== undefined
            ? BigInt(currentRaw) < BigInt(beforeRaw)
            : value < previous.values[metric]!;
        if (decreased) return null;
      }
      previous = row;
    }
    const beforeRaw = baseline[rawField],
      afterRaw = last[rawField];
    const difference =
      beforeRaw !== undefined && afterRaw !== undefined
        ? (BigInt(afterRaw) - BigInt(beforeRaw)).toString()
        : undefined;
    const value =
      difference !== undefined
        ? rawNumber(difference)
        : last.values[metric]! - baseline.values[metric]!;
    if (!Number.isFinite(value) || (metric === "stakingRewards" && value < 0))
      return null;
    return {
      time: day,
      value,
      observedFromMs: baseline.endpointAt,
      observedToMs: last.endpointAt,
      ...(difference === undefined ? {} : { valueRaw: difference }),
      ...(current || origin === "summary" || !last.complete
        ? { partial: true }
        : {}),
    };
  }
  const points: ProtocolChartPoint[] =
    histories.length || summaries.length
      ? Array.from({ length: 7 }, (_, index) => {
          const day = firstDay + index * DAY;
          const historical = candidate(day, "history");
          const observed = candidate(day, "summary");
          const selected =
            day === today &&
            observed &&
            (!historical || observed.observedToMs! >= historical.observedToMs!)
              ? observed
              : historical ?? observed;
          return (
            selected ?? { time: day, value: null, partial: true, gapBefore: true }
          );
        })
      : [];
  return {
    ...emptySeries(metric),
    aggregation: "daily-change",
    points,
    coverage: {
      observedFrom: points.find((point) => point.value !== null)?.time ?? null,
      partial: true,
    },
  };
}
function series(
  metric: ProtocolChartMetric,
  histories: ProtocolChartObservation[],
  summaries: ProtocolChartObservation[],
  now: number,
  delta?: "signed" | "nonnegative",
): ProtocolChartSeries {
  const selected = new Map<
    number,
    ProtocolChartObservation & { origin: "history" | "summary" }
  >();
  const hour = Math.floor(now / HOUR) * HOUR;
  for (const [origin, rows] of [
    ["history", histories],
    ["summary", summaries],
  ] as const)
    for (const row of rows) {
      if (
        !(metric in row.values) ||
        row.time > hour ||
        row.time < hour - 169 * HOUR
      )
        continue;
      const previous = selected.get(row.time);
      if (!previous || row.endpointAt > previous.endpointAt)
        selected.set(row.time, { ...row, origin });
    }
  const rows = [...selected.values()].sort((a, b) => a.time - b.time);
  const points = rows
    .map((row, i) => {
      const previous = rows[i - 1];
      const discontinuity =
        !!previous &&
        (row.time - previous.time !== HOUR ||
          // Summary genesis and history generations are different namespaces.
          // They cannot establish a compatible pair for economic changes.
          (delta !== undefined && row.origin !== previous.origin) ||
          (delta !== undefined && row.generation === "genesis:unknown") ||
          (row.origin === previous.origin &&
            row.generation !== previous.generation));
      let value = row.values[metric] ?? null;
      let reset = false;
      if (delta !== undefined) {
        const before = previous?.values[metric];
        if (
          !previous ||
          !previous.complete ||
          discontinuity ||
          value === null ||
          before == null
        )
          value = null;
        else {
          const field =
            metric === "paperSupply" ? "paperSupplyRaw" : "allocatedRewardsRaw";
          const currentRaw = row[field];
          const previousRaw = previous[field];
          value =
            currentRaw !== undefined && previousRaw !== undefined
              ? rawNumber((BigInt(currentRaw) - BigInt(previousRaw)).toString())
              : value - before;
          if (delta === "nonnegative" && value < 0) {
            value = null;
            reset = true;
          }
        }
      } else if (metric === "volume") {
        const before = previous?.values.volume;
        if (
          !previous ||
          !previous.complete ||
          discontinuity ||
          value === null ||
          before == null
        )
          value = null;
        else if (
          row.volumeRaw !== undefined &&
          previous.volumeRaw !== undefined
        ) {
          const delta = BigInt(row.volumeRaw) - BigInt(previous.volumeRaw);
          value = delta >= 0n ? rawNumber(delta.toString()) : null;
        } else value = value >= before ? value - before : null;
      }
      return {
        time: row.time,
        value: value !== null && Number.isFinite(value) ? value : null,
        ...(discontinuity || reset ? { gapBefore: true } : {}),
        ...(row.time === hour ||
        !row.complete ||
        ((metric === "volume" || delta !== undefined) &&
          previous &&
          !previous.complete)
          ? { partial: true }
          : {}),
      };
    })
    .filter((point) => point.time >= hour - 168 * HOUR)
    .slice(-169);
  return {
    ...emptySeries(metric),
    ...(delta !== undefined ? { aggregation: "hourly-change" as const } : {}),
    points,
    coverage: {
      observedFrom: points.find((point) => point.value !== null)?.time ?? null,
      partial: true,
    },
  };
}

function stakeRatioBps(summary: ProtocolSummary | null): number | null {
  if (!summary) return null;
  const supply = BigInt(summary.paper.supply);
  const staked = BigInt(summary.paper.staked);
  return supply > 0n && staked >= 0n && staked <= supply
    ? Number((staked * 10000n) / supply)
    : null;
}
export async function refreshProtocolCharts(
  store: Context,
  now = Date.now(),
): Promise<PanelPublication[]> {
  const [histories, summaries, summary] = await Promise.all([
    store.history.protocolChartRows("history"),
    store.history.protocolChartRows("summary"),
    store.get<ProtocolSummary>("summary"),
  ]);
  const sourceAt = summary?.value.source.at ?? null;
  const data: ProtocolChartsResponse = {
    ...empty(),
    receivedAt: now,
    sourceAt,
    stale:
      !summary ||
      sourceAt === null ||
      now - sourceAt > 30000 ||
      sourceAt > now + 30000 ||
      now - summary.receivedAt > 30000 ||
      summary.receivedAt > now + 30000,
    series: Object.fromEntries(
      METRICS.map((metric) => [
        metric,
        series(metric, histories, summaries, now),
      ]),
    ) as ProtocolChartsResponse["series"],
  };
  data.panelRevision = snapshotPanelRevision(data);
  await store.put("protocol-charts", data, now);
  // Reuse this invocation's bounded observations and summary. Viewers read the
  // saved response; economics adds no upstream request or history scan.
  const current = summary?.value ?? null;
  // This same summary drives the headline. Include it even if the separate
  // hourly-retention write has not happened yet; this adds no storage read.
  const dailySummaries =
    current &&
    Number.isSafeInteger(current.source.at) &&
    current.source.at >= 0 &&
    current.source.at <= now + 30000
      ? [...summaries, summaryObservation(current)]
      : summaries;
  const economics: PaperEconomicsResponse = {
    ...emptyEconomics(),
    sourceAt,
    receivedAt: now,
    stale: data.stale,
    supplyRaw: current?.paper.supply ?? null,
    stakedRaw: current?.paper.staked ?? null,
    allocatedRewardsRaw: current?.fees.lifetime ?? null,
    pendingRewardsRaw: current?.paper.pendingRewards ?? null,
    stakeRatioBps: stakeRatioBps(current),
    annualized: annualizedStakingRevenue(current, now),
    series: {
      supply: data.series.paperSupply,
      staked: data.series.paperStaked,
      allocated: data.series.stakingRewards,
      supplyChange: series("paperSupply", histories, summaries, now, "signed"),
      rewardAllocation: series(
        "stakingRewards",
        histories,
        summaries,
        now,
        "nonnegative",
      ),
    },
    daily: {
      intervalMs: DAY,
      timeZone: "UTC",
      supplyChange: dailySeries("paperSupply", histories, dailySummaries, now),
      rewardAllocation: dailySeries("stakingRewards", histories, dailySummaries, now),
    },
  };
  economics.panelRevision = snapshotPanelRevision(economics);
  await store.put("paper-economics", economics, now);
  const publication = {
    receivedAt: now,
    sourceAt,
    stale: data.stale,
    freshUntil: Math.min(
      now + 30000,
      (sourceAt ?? 0) + 30000,
      (summary?.receivedAt ?? 0) + 30000,
    ),
  };
  return [
    { ...publication, key: "protocol-charts", revision: data.panelRevision },
    { ...publication, key: "paper-economics", revision: economics.panelRevision },
  ];
}

type SnapshotHeartbeat = { at: number; errors?: Record<string, string> };
function snapshotStale(
  saved: {
    value: { stale: boolean; sourceAt: number | null };
    receivedAt: number;
  },
  heartbeat: { value: SnapshotHeartbeat } | null,
  now: number,
): boolean {
  return (
    saved.value.stale ||
    !heartbeat ||
    now - saved.receivedAt > 30000 ||
    saved.receivedAt > now + 30000 ||
    now - heartbeat.value.at > 30000 ||
    heartbeat.value.at > now + 30000 ||
    saved.value.sourceAt === null ||
    now - saved.value.sourceAt > 30000 ||
    saved.value.sourceAt > now + 30000 ||
    !!(
      heartbeat.value.errors?.summary ||
      heartbeat.value.errors?.history ||
      heartbeat.value.errors?.["protocol-charts"]
    )
  );
}

export async function readPaperEconomics(
  store: Pick<Store, "get">,
  now = Date.now(),
): Promise<PaperEconomicsResponse> {
  const [saved, heartbeat] = await Promise.all([
    store.get<PaperEconomicsResponse>("paper-economics"),
    store.get<SnapshotHeartbeat>("collector-heartbeat"),
  ]);
  if (!saved)
    return {
      ...emptyEconomics(),
      error: "Waiting for retained PAPER observations.",
    };
  const stale = snapshotStale(saved, heartbeat, now);
  return {
    ...saved.value,
    stale,
    ...(stale
      ? {
          error:
            "PAPER economics collection is delayed; showing retained observations.",
        }
      : {}),
  };
}
export async function readProtocolCharts(
  store: Pick<Store, "get">,
  now = Date.now(),
): Promise<ProtocolChartsResponse> {
  const [saved, heartbeat] = await Promise.all([
    store.get<ProtocolChartsResponse>("protocol-charts"),
    store.get<SnapshotHeartbeat>("collector-heartbeat"),
  ]);
  if (!saved)
    return { ...empty(), error: "Waiting for retained protocol observations." };
  const stale = snapshotStale(saved, heartbeat, now);
  return {
    ...saved.value,
    stale,
    ...(stale
      ? {
          error:
            "Protocol chart collection is delayed; showing retained observations.",
        }
      : {}),
  };
}
