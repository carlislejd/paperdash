import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProtocolSummary } from "../../../packages/shared/src/types.js";
import { VERIFIED_PROTOCOL_GENESIS } from "../../../packages/shared/src/staking-yield.js";
import { createStore, type Store } from "../src/store.js";
import { refreshStakerYield } from "../src/staking-yield.js";
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
    expect(reads.mock.calls).toEqual([["summary"], ["paper-price"], ["staking-yield-window"]]);
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
