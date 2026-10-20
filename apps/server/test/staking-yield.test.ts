import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProtocolSummary } from "../../../packages/shared/src/types.js";
import { VERIFIED_PROTOCOL_GENESIS } from "../../../packages/shared/src/staking-yield.js";
import { createStore, type Store } from "../src/store.js";
import { readStakingRewardHistory, refreshStakerYield } from "../src/staking-yield.js";
import { Collector } from "../src/collector.js";
import { Upstream } from "../src/upstream.js";
import { ChangeBus } from "../src/bus.js";
import {
  readPaperEconomics,
  refreshProtocolCharts,
  retainProtocolChartSummary,
} from "../src/protocol-charts.js";

const HOUR = 3_600_000;
const start = VERIFIED_PROTOCOL_GENESIS + 12 * HOUR + 12_345;
const initialAccumulator = 10n ** 26n;
const rewardPerHour = 10n ** 24n; // $0.001 per PAPER per hour.
const stores: Store[] = [];
const directories: string[] = [];
const collectors: Collector[] = [];
const upstreams: Upstream[] = [];
const buses: ChangeBus[] = [];
afterEach(async () => {
  for (const collector of collectors.splice(0)) await collector.stop();
  for (const upstream of upstreams.splice(0)) await upstream.close();
  for (const bus of buses.splice(0)) bus.close();
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function summary(at = start, accumulator = initialAccumulator): ProtocolSummary {
  return {
    ok: true,
    source: { at, genesis: VERIFIED_PROTOCOL_GENESIS, block: "1000" },
    balances: { tvl: "0", margin: "0", lp: "0", reserve: "0", queue: "0" },
    activity: { volume: "0", open: 0 },
    fees: { pending: "0", lifetime: "1000000000000000000000" },
    paper: {
      supply: "1000000000000000000000",
      staked: "500000000000000000000",
      accumulator: accumulator.toString(),
    },
  };
}

async function memory() {
  const store = await createStore({ memory: true, databaseUrl: "" });
  stores.push(store);
  return store;
}

describe("retained staking yield", () => {
  it("retains a reset between chart refreshes through the actual summary collector lane", async () => {
    const store = await memory();
    const upstream = new Upstream(store);
    const bus = new ChangeBus();
    const collector = new Collector(store, upstream, bus);
    upstreams.push(upstream);
    buses.push(bus);
    collectors.push(collector);
    let clock = start;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    // The accepted 2-second summary stream can regress and recover before the
    // 10-second chart publication sees either intermediate observation.
    for (const [at, units] of [
      [start, 100],
      [start + 2_000, 50],
      [start + 4_000, 101],
    ]) {
      clock = at;
      const current = summary(at, BigInt(units) * rewardPerHour);
      current.source.block = String(at);
      await collector["retainSummary"](current);
    }
    await refreshProtocolCharts(store, clock);
    expect((await readPaperEconomics(store, clock)).stakingYield).toMatchObject({
      fromMs: start + 2_000,
      toMs: start + 4_000,
      usdPerPaperPerYearRaw: null,
    });
    clock = start + 2_000 + HOUR;
    const finish = summary(clock, 110n * rewardPerHour);
    finish.source.block = String(clock);
    await collector["retainSummary"](finish);
    await refreshProtocolCharts(store, clock);
    expect((await readPaperEconomics(store, clock)).stakingYield).toMatchObject({
      fromMs: start + 2_000,
      elapsedMs: HOUR,
      earnedUsdPerPaperRaw: "60000000000000000",
      usdPerPaperPerYearRaw: "525600000000000000000",
    });
  });

  it("cannot overwrite newer retained observations when a chart refresh reads an older summary", async () => {
    const store = await memory();
    const older = summary(start + HOUR, initialAccumulator + rewardPerHour);
    const newer = summary(start + 2 * HOUR, initialAccumulator + 2n * rewardPerHour);
    await refreshStakerYield(store, summary(), start);
    await refreshStakerYield(store, older, older.source.at);
    await refreshStakerYield(store, newer, newer.source.at);
    const retained = await store.get("staking-yield-window");
    // Equivalent to a publication sampling summary just before the collector
    // advances the retained yield window. Its read must never act as a reset.
    await store.put("summary", older, older.source.at);
    const writes = vi.spyOn(store, "put");
    await refreshProtocolCharts(store, newer.source.at);
    expect((await readPaperEconomics(store, newer.source.at)).stakingYield?.usdPerPaperPerYearRaw)
      .toBeNull();
    expect(await store.get("staking-yield-window")).toEqual(retained);
    expect(writes.mock.calls.some(([key]) => key === "staking-yield-window")).toBe(false);
    await store.put("summary", newer, newer.source.at);
    await refreshProtocolCharts(store, newer.source.at);
    expect((await readPaperEconomics(store, newer.source.at)).stakingYield).toMatchObject({
      fromMs: start,
      toMs: newer.source.at,
      usdPerPaperPerYearRaw: "8760000000000000000",
    });
  });

  it("starts from an observed accumulator and keeps a measured 90-minute interval", async () => {
    const store = await memory();
    const first = await refreshStakerYield(store, summary(), start);
    expect(first.usdPerPaperPerYearRaw).toBeNull();
    expect(first.earnedUsdPerPaperRaw).toBe("0");
    expect(first.fromMs).toBe(start);
    await refreshStakerYield(store, summary(start + HOUR, initialAccumulator + rewardPerHour), start + HOUR);
    const finish = start + 1.5 * HOUR;
    const result = await refreshStakerYield(
      store, summary(finish, initialAccumulator + 3n * rewardPerHour / 2n), finish,
    );
    expect(result).toMatchObject({
      fromMs: start,
      toMs: finish,
      elapsedMs: 5_400_000,
      usdPerPaperPerYearRaw: "8760000000000000000",
      earnedUsdPerPaperRaw: "1500000000000000",
    });
  });

  it("preserves the original baseline across database reopen and seven-day chart eviction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paperdash-staking-yield-"));
    directories.push(directory);
    const firstStore = await createStore({ dataDir: directory, databaseUrl: "" });
    await refreshStakerYield(firstStore, summary(), start);
    await firstStore.close();
    const reopened = await createStore({ dataDir: directory, databaseUrl: "" });
    stores.push(reopened);
    // The chart reader returns only 170 hourly rows. Yield must retain all 193
    // measured hours independently, even after its initial chart row is gone.
    for (let hour = 1; hour <= 193; hour++) {
      const at = start + hour * HOUR;
      const current = summary(at, initialAccumulator + BigInt(hour) * rewardPerHour);
      await retainProtocolChartSummary(reopened, current, at);
      await refreshStakerYield(reopened, current, at);
    }
    expect((await reopened.history.protocolChartRows("summary"))[0].endpointAt)
      .toBeGreaterThan(start);
    const finish = start + 193 * HOUR;
    await reopened.put("summary", summary(finish, initialAccumulator + 193n * rewardPerHour), finish);
    await reopened.put("collector-heartbeat", { at: finish, errors: {} }, finish);
    const reads = vi.spyOn(reopened, "get");
    const chartReads = vi.spyOn(reopened.history, "protocolChartRows");
    await refreshProtocolCharts(reopened, finish);
    expect(reads.mock.calls).toEqual([["summary"], ["staking-yield-window"], ["staking-reward-history"], ["staking-reward-history-days"]]);
    expect(chartReads.mock.calls).toEqual([["history"], ["summary"]]);
    expect((await readPaperEconomics(reopened, finish)).stakingYield).toMatchObject({
      fromMs: start,
      elapsedMs: 193 * HOUR,
      earnedUsdPerPaperRaw: "193000000000000000",
      usdPerPaperPerYearRaw: "8760000000000000000",
    });
  });

  it("measures cumulative earnings through an outage while retaining zero-reward hours", async () => {
    const store = await memory();
    await refreshStakerYield(store, summary(), start);
    await refreshStakerYield(store, summary(start + HOUR, initialAccumulator + rewardPerHour), start + HOUR);
    expect((await refreshStakerYield(store, null, start + 2 * HOUR)).usdPerPaperPerYearRaw)
      .toBeNull();
    const finish = start + 4 * HOUR;
    const result = await refreshStakerYield(store, summary(finish, initialAccumulator + rewardPerHour), finish);
    // The same $0.001 earned over four hours is $2.19 per year, not $8.76.
    expect(result.elapsedMs).toBe(4 * HOUR);
    expect(result.usdPerPaperPerYearRaw).toBe("2190000000000000000");
  });

  it("does not divide historical rewards by today's stake or allocated fee total", async () => {
    const store = await memory();
    await refreshStakerYield(store, summary(), start);
    const next = summary(start + HOUR, initialAccumulator + rewardPerHour);
    next.paper.staked = "0";
    next.paper.supply = "99999999999999999999999999999999";
    next.fees.lifetime = "1";
    const result = await refreshStakerYield(store, next, next.source.at);
    expect(result.usdPerPaperPerYearRaw).toBe("8760000000000000000");
  });

  it("never recovers across a previously observed accumulator regression", async () => {
    const store = await memory();
    await refreshStakerYield(store, summary(), start);
    await refreshStakerYield(store, summary(start + HOUR, initialAccumulator + 10n * rewardPerHour), start + HOUR);
    const resetAt = start + 2 * HOUR;
    const reset = initialAccumulator + 5n * rewardPerHour;
    expect((await refreshStakerYield(store, summary(resetAt, reset), resetAt)).usdPerPaperPerYearRaw)
      .toBeNull();
    const recoveredAt = resetAt + HOUR;
    const result = await refreshStakerYield(
      store, summary(recoveredAt, initialAccumulator + 11n * rewardPerHour), recoveredAt,
    );
    expect(result).toMatchObject({
      fromMs: resetAt,
      elapsedMs: HOUR,
      earnedUsdPerPaperRaw: "6000000000000000",
      usdPerPaperPerYearRaw: "52560000000000000000",
    });
  });

  it("restarts the measured window after a source-clock rollback or conflicting same-time publication", async () => {
    const store = await memory();
    await refreshStakerYield(store, summary(), start);
    await refreshStakerYield(store, summary(start + 2 * HOUR), start + 2 * HOUR);
    const rollbackAt = start + HOUR;
    const rollback = await refreshStakerYield(store, summary(rollbackAt), start + 2 * HOUR);
    expect(rollback.usdPerPaperPerYearRaw).toBeNull();
    expect(rollback.fromMs).toBe(rollbackAt);
    const conflict = await refreshStakerYield(
      store, summary(rollbackAt, initialAccumulator + rewardPerHour), start + 2 * HOUR,
    );
    expect(conflict.usdPerPaperPerYearRaw).toBeNull();
    const resumedAt = rollbackAt + HOUR;
    const result = await refreshStakerYield(
      store, summary(resumedAt, initialAccumulator + 2n * rewardPerHour), resumedAt,
    );
    expect(result.fromMs).toBe(rollbackAt);
    expect(result.earnedUsdPerPaperRaw).toBe("1000000000000000");
  });

  it("keeps unavailable observations distinct from a measured zero", async () => {
    const store = await memory();
    for (const invalid of [
      null,
      { ...summary(), ok: false },
      { ...summary(), source: { ...summary().source, genesis: undefined } },
      { ...summary(), paper: { supply: "1", staked: "1" } },
      { ...summary(), paper: { ...summary().paper, accumulator: "01" } },
    ]) {
      expect((await refreshStakerYield(store, invalid, start)).usdPerPaperPerYearRaw)
        .toBeNull();
    }
    await refreshStakerYield(store, summary(), start);
    const zero = await refreshStakerYield(store, summary(start + HOUR), start + HOUR);
    expect(zero.usdPerPaperPerYearRaw).toBe("0");
    expect(zero.earnedUsdPerPaperRaw).toBe("0");
  });
});

const DAY = 24 * HOUR;
const dayStart = Math.floor((VERIFIED_PROTOCOL_GENESIS + 3 * DAY) / DAY) * DAY;
const unchangedParticipation = {
  supplyFromRaw: summary().paper.supply, supplyToRaw: summary().paper.supply,
  stakedFromRaw: summary().paper.staked, stakedToRaw: summary().paper.staked,
};

describe("retained daily rewards per 1K staked PAPER", () => {
  async function record(store: Store, at: number, accumulator: bigint) {
    await refreshStakerYield(store, summary(at, accumulator), at);
  }

  it("seeds only the legacy last endpoint and preserves sub-per-PAPER raw precision", async () => {
    const store = await memory();
    const lastAt = dayStart + 12 * HOUR;
    const huge = 10n ** 70n;
    const point = (at: number, raw: bigint) => ({ at, genesis: VERIFIED_PROTOCOL_GENESIS, accumulatorRaw: raw.toString() });
    await store.put("staking-yield-window", {
      first: point(lastAt - 2 * DAY, huge - 10n ** 30n),
      last: point(lastAt, huge),
    }, lastAt);
    await record(store, lastAt + 2_000, huge + 999_999_999n);
    expect(await readStakingRewardHistory(store, lastAt + 2_000)).toMatchObject({
      observedFromMs: lastAt,
      availableFromMs: dayStart,
      truncated: false,
      days: [{
        dayMs: dayStart, fromMs: lastAt, toMs: lastAt + 2_000,
        earnedUsdPer1kPaperRaw: "999", partial: true, missing: false,
        participation: null,
      }],
    });
  });

  it("requires two endpoints, keeps a measured zero, and recognizes exact UTC days", async () => {
    const store = await memory();
    await record(store, dayStart, initialAccumulator);
    expect((await readStakingRewardHistory(store, dayStart)).days[0]).toMatchObject({
      earnedUsdPer1kPaperRaw: null, missing: true, partial: true,
    });
    await record(store, dayStart + HOUR, initialAccumulator);
    expect((await readStakingRewardHistory(store, dayStart + HOUR)).days[0]).toMatchObject({
      earnedUsdPer1kPaperRaw: "0", missing: false, partial: true,
    });
    await record(store, dayStart + DAY, initialAccumulator);
    expect((await readStakingRewardHistory(store, dayStart + DAY)).days).toEqual([
      { dayMs: dayStart, fromMs: dayStart, toMs: dayStart + DAY, earnedUsdPer1kPaperRaw: "0", partial: false, missing: false, participation: unchangedParticipation },
      { dayMs: dayStart + DAY, fromMs: dayStart + DAY, toMs: dayStart + DAY, earnedUsdPer1kPaperRaw: null, partial: true, missing: true, participation: null },
    ]);
  });

  it("shares approximate midnight endpoints without overlap or invented normalization", async () => {
    const store = await memory();
    await record(store, dayStart + 20_000, initialAccumulator);
    await record(store, dayStart + DAY - 10_000, initialAccumulator + 3n * rewardPerHour);
    await record(store, dayStart + DAY + 10_000, initialAccumulator + 4n * rewardPerHour);
    await record(store, dayStart + DAY + HOUR, initialAccumulator + 5n * rewardPerHour);
    const { days } = await readStakingRewardHistory(store, dayStart + DAY + HOUR);
    expect(days).toEqual([
      { dayMs: dayStart, fromMs: dayStart + 20_000, toMs: dayStart + DAY + 10_000, earnedUsdPer1kPaperRaw: "4000000000000000000", partial: true, missing: false, participation: unchangedParticipation },
      { dayMs: dayStart + DAY, fromMs: dayStart + DAY + 10_000, toMs: dayStart + DAY + HOUR, earnedUsdPer1kPaperRaw: "1000000000000000000", partial: true, missing: false, participation: unchangedParticipation },
    ]);
    expect((await store.get(`staking-reward-day:${dayStart}`))?.value).toEqual(days[0]);
  });

  it("leaves missing days unknown and never assigns a multi-day outage delta to the next day", async () => {
    const store = await memory();
    const first = dayStart + 12 * HOUR;
    await record(store, first, initialAccumulator);
    await record(store, first + HOUR, initialAccumulator + rewardPerHour);
    const resume = first + 3 * DAY;
    await record(store, resume, initialAccumulator + 100n * rewardPerHour);
    await record(store, resume + HOUR, initialAccumulator + 101n * rewardPerHour);
    const { days } = await readStakingRewardHistory(store, resume + HOUR);
    expect(days).toHaveLength(4);
    expect(days[0]).toMatchObject({ earnedUsdPer1kPaperRaw: "1000000000000000000", toMs: first + HOUR, partial: true });
    for (const missing of days.slice(1, 3))
      expect(missing).toMatchObject({ fromMs: null, toMs: null, earnedUsdPer1kPaperRaw: null, partial: true, missing: true });
    expect(days[3]).toMatchObject({ fromMs: resume, earnedUsdPer1kPaperRaw: "1000000000000000000", partial: true, missing: false });
  });

  it("does not bridge a missed midnight merely because the two samples are on adjacent dates", async () => {
    const store = await memory();
    await record(store, dayStart + HOUR, initialAccumulator);
    await record(store, dayStart + 23 * HOUR, initialAccumulator + rewardPerHour);
    await record(store, dayStart + DAY + 20_000, initialAccumulator + 10n * rewardPerHour);
    const { days } = await readStakingRewardHistory(store, dayStart + DAY + 20_000);
    expect(days[0]).toMatchObject({ toMs: dayStart + 23 * HOUR, earnedUsdPer1kPaperRaw: "1000000000000000000", partial: true });
    expect(days[1]).toMatchObject({ fromMs: dayStart + DAY + 20_000, earnedUsdPer1kPaperRaw: null, missing: true });
  });

  it("keeps reset days unknown even if the counter later exceeds its prior high", async () => {
    const store = await memory();
    await record(store, dayStart + HOUR, initialAccumulator);
    await record(store, dayStart + 2 * HOUR, initialAccumulator + 10n * rewardPerHour);
    await record(store, dayStart + 3 * HOUR, initialAccumulator + 5n * rewardPerHour);
    await record(store, dayStart + 4 * HOUR, initialAccumulator + 11n * rewardPerHour);
    expect((await readStakingRewardHistory(store, dayStart + 4 * HOUR)).days[0]).toMatchObject({
      earnedUsdPer1kPaperRaw: null, missing: true, participation: null,
    });
    await record(store, dayStart + DAY, initialAccumulator + 12n * rewardPerHour);
    await record(store, dayStart + DAY + HOUR, initialAccumulator + 13n * rewardPerHour);
    const { days } = await readStakingRewardHistory(store, dayStart + DAY + HOUR);
    expect(days[0].missing).toBe(true);
    expect(days[1]).toMatchObject({ earnedUsdPer1kPaperRaw: "1000000000000000000", missing: false, participation: unchangedParticipation });
  });

  it("invalidates the prior date's approximate endpoint when the clock rolls back across that endpoint", async () => {
    const store = await memory();
    await record(store, dayStart + HOUR, initialAccumulator);
    await record(store, dayStart + DAY - 10_000, initialAccumulator + rewardPerHour);
    await record(store, dayStart + DAY + 30_000, initialAccumulator + 2n * rewardPerHour);
    await record(store, dayStart + DAY + 60_000, initialAccumulator + 3n * rewardPerHour);
    const rollback = dayStart + DAY + 10_000;
    await refreshStakerYield(store, summary(rollback, initialAccumulator + rewardPerHour), dayStart + DAY + 60_000);
    const { days } = await readStakingRewardHistory(store, dayStart + DAY + 60_000);
    expect(days[0]).toMatchObject({ earnedUsdPer1kPaperRaw: null, missing: true, participation: null });
    expect(days[1]).toMatchObject({ fromMs: rollback, earnedUsdPer1kPaperRaw: null, missing: true, participation: null });
    expect((await store.get(`staking-reward-day:${dayStart}`))?.value).toMatchObject({ earnedUsdPer1kPaperRaw: null, missing: true });
  });

  it("persists daily history across restarts and bounds publication without deleting older completed days", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paperdash-reward-history-"));
    directories.push(directory);
    const firstStore = await createStore({ dataDir: directory, databaseUrl: "" });
    await record(firstStore, dayStart, initialAccumulator);
    await record(firstStore, dayStart + DAY, initialAccumulator + rewardPerHour);
    await firstStore.close();
    const reopened = await createStore({ dataDir: directory, databaseUrl: "" });
    stores.push(reopened);
    expect((await readStakingRewardHistory(reopened, dayStart + DAY)).days[0]).toMatchObject({
      earnedUsdPer1kPaperRaw: "1000000000000000000", partial: false, participation: unchangedParticipation,
    });
    // Memory store makes the long retention exercise independent of disk speed.
    const bounded = await memory();
    for (let day = 0; day <= 366; day++)
      await record(bounded, dayStart + day * DAY, initialAccumulator + BigInt(day) * rewardPerHour);
    const history = await readStakingRewardHistory(bounded, dayStart + 366 * DAY);
    expect(history.days).toHaveLength(365);
    expect(history.availableFromMs).toBe(dayStart + 2 * DAY);
    expect(history.observedFromMs).toBe(dayStart);
    expect(history.truncated).toBe(true);
    expect((await bounded.get(`staking-reward-day:${dayStart}`))?.value).toMatchObject({
      earnedUsdPer1kPaperRaw: "1000000000000000000", partial: false, participation: unchangedParticipation,
    });
    const writes = vi.spyOn(bounded, "put");
    await record(bounded, dayStart + 366 * DAY + 2_000, initialAccumulator + 366n * rewardPerHour);
    expect(writes.mock.calls.map(([key]) => key)).toEqual(["staking-reward-history", "staking-yield-window"]);
    expect(JSON.stringify(writes.mock.calls[0][1]).length).toBeLessThan(1_000);
  });

  it("uses exact PAPER totals from the reward interval endpoints, including decreases and zero baselines", async () => {
    const store = await memory();
    const firstAt = dayStart + 12_345;
    const first = summary(firstAt);
    first.paper.supply = "0";
    first.paper.staked = "0";
    await refreshStakerYield(store, first, firstAt);
    const nextAt = firstAt + HOUR;
    const next = summary(nextAt, initialAccumulator + rewardPerHour);
    next.paper.supply = "900719925474099300000000000000001";
    next.paper.staked = "800719925474099300000000000000007";
    await refreshStakerYield(store, next, nextAt);
    expect((await readStakingRewardHistory(store, nextAt)).days[0]).toMatchObject({
      fromMs: firstAt, toMs: nextAt, earnedUsdPer1kPaperRaw: "1000000000000000000",
      participation: {
        supplyFromRaw: "0", supplyToRaw: next.paper.supply,
        stakedFromRaw: "0", stakedToRaw: next.paper.staked,
      },
    });
    // A lower future total is a valid signed change, not a reward-counter reset.
    const another = await memory();
    await refreshStakerYield(another, next, nextAt);
    const lastAt = nextAt + HOUR;
    const last = summary(lastAt, initialAccumulator + 2n * rewardPerHour);
    last.paper.staked = "0";
    const annual = await refreshStakerYield(another, last, lastAt);
    expect(annual.fromMs).toBe(nextAt);
    expect((await readStakingRewardHistory(another, lastAt)).days[0]).toMatchObject({
      fromMs: nextAt, toMs: lastAt, missing: false,
      participation: {
        supplyFromRaw: next.paper.supply, supplyToRaw: last.paper.supply,
        stakedFromRaw: next.paper.staked, stakedToRaw: "0",
      },
    });
  });

  it("keeps daily rewards when same-time PAPER totals conflict, including a shared midnight endpoint", async () => {
    const store = await memory();
    await record(store, dayStart, initialAccumulator);
    const midnight = dayStart + DAY;
    await record(store, midnight, initialAccumulator + rewardPerHour);
    const conflicted = summary(midnight, initialAccumulator + rewardPerHour);
    conflicted.paper.staked = "1";
    await refreshStakerYield(store, conflicted, midnight);
    await record(store, midnight + HOUR, initialAccumulator + 2n * rewardPerHour);
    const history = await readStakingRewardHistory(store, midnight + HOUR);
    expect(history.observedFromMs).toBe(dayStart);
    expect(history.days).toHaveLength(2);
    for (const day of history.days)
      expect(day).toMatchObject({ earnedUsdPer1kPaperRaw: "1000000000000000000", missing: false, participation: null });
    expect((await store.get(`staking-reward-day:${dayStart}`))?.value)
      .toMatchObject({ earnedUsdPer1kPaperRaw: "1000000000000000000", participation: null });
    const annual = (await store.get<{ first: { at: number } }>("staking-yield-window"))?.value;
    expect(annual?.first.at).toBe(dayStart);
    // The following day's own non-conflicting pair can publish again.
    await record(store, midnight + DAY, initialAccumulator + 3n * rewardPerHour);
    await record(store, midnight + DAY + HOUR, initialAccumulator + 4n * rewardPerHour);
    expect((await readStakingRewardHistory(store, midnight + DAY + HOUR)).days[2])
      .toMatchObject({ missing: false, participation: unchangedParticipation });
  });

  it("retains conflicting first endpoints instead of silently replacing them with matching-time totals", async () => {
    const store = await memory();
    await record(store, dayStart, initialAccumulator);
    const changed = summary(dayStart);
    changed.paper.supply = "2000000000000000000000";
    await refreshStakerYield(store, changed, dayStart);
    await record(store, dayStart + HOUR, initialAccumulator + rewardPerHour);
    expect((await readStakingRewardHistory(store, dayStart + HOUR)).days[0]).toMatchObject({
      fromMs: dayStart, toMs: dayStart + HOUR, earnedUsdPer1kPaperRaw: "1000000000000000000",
      missing: false, participation: null,
    });
  });

  it("leaves malformed or impossible PAPER endpoints unavailable without losing valid rewards", async () => {
    for (const [supply, staked] of [["01", "0"], ["1", "2"], ["-1", "0"], ["1", "-1"], ["0", "1"], ["1e18", "0"]]) {
      const store = await memory();
      const first = summary(dayStart);
      first.paper.supply = supply;
      first.paper.staked = staked;
      await refreshStakerYield(store, first, dayStart);
      await record(store, dayStart + HOUR, initialAccumulator + rewardPerHour);
      expect((await readStakingRewardHistory(store, dayStart + HOUR)).days[0])
        .toMatchObject({ earnedUsdPer1kPaperRaw: "1000000000000000000", missing: false, participation: null });
    }
  });

  it("preserves legacy daily rows and the annual baseline across reopen without inventing participation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paperdash-legacy-reward-participation-"));
    directories.push(directory);
    const firstStore = await createStore({ dataDir: directory, databaseUrl: "" });
    const point = (at: number, accumulator: bigint) => ({ at, genesis: VERIFIED_PROTOCOL_GENESIS, accumulatorRaw: accumulator.toString() });
    const first = point(dayStart, initialAccumulator);
    const last = point(dayStart + DAY, initialAccumulator + rewardPerHour);
    const older = point(dayStart - DAY, initialAccumulator - rewardPerHour);
    await firstStore.put("staking-yield-window", { first: older, last }, last.at);
    await firstStore.put("staking-reward-history", {
      version: 1, observedFromMs: dayStart, last,
      day: { dayMs: last.at, first: last, last, invalid: false },
    }, last.at);
    await firstStore.put("staking-reward-history-days", [{ dayMs: dayStart, first, last, invalid: false }], last.at);
    await firstStore.close();
    const reopened = await createStore({ dataDir: directory, databaseUrl: "" });
    stores.push(reopened);
    // Seeing the same legacy endpoint again cannot backfill newly captured totals.
    await record(reopened, last.at, initialAccumulator + rewardPerHour);
    await record(reopened, last.at + HOUR, initialAccumulator + 2n * rewardPerHour);
    let history = await readStakingRewardHistory(reopened, last.at + HOUR);
    expect(history.observedFromMs).toBe(dayStart);
    expect(history.days).toHaveLength(2);
    expect(history.days[0]).toMatchObject({ fromMs: dayStart, toMs: last.at, earnedUsdPer1kPaperRaw: "1000000000000000000", participation: null });
    expect(history.days[1]).toMatchObject({ fromMs: last.at, toMs: last.at + HOUR, earnedUsdPer1kPaperRaw: "1000000000000000000", participation: null });
    const annual = await refreshStakerYield(reopened, summary(last.at + DAY, initialAccumulator + 3n * rewardPerHour), last.at + DAY);
    expect(annual.fromMs).toBe(older.at);
    await record(reopened, last.at + DAY + HOUR, initialAccumulator + 4n * rewardPerHour);
    history = await readStakingRewardHistory(reopened, last.at + DAY + HOUR);
    expect(history.days[2]).toMatchObject({ fromMs: last.at + DAY, missing: false, participation: unchangedParticipation });
  });
});
