import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "../src/store.js";
import {
  readProtocolCharts,
  refreshProtocolCharts,
} from "../src/protocol-charts.js";
import type { DepositMetricsRead } from "../src/deposit-metrics-store.js";
import type {
  ProtocolChartsResponse,
  ProtocolSummary,
} from "../../../packages/shared/src/types.js";

const DAY = 86400000;
const today = Date.UTC(2026, 9, 13),
  now = today + 3600000;
const stores: Store[] = [];
const rollup: DepositMetricsRead = {
  days: [
    {
      time: today,
      depositVolumeRaw: "12345678901234567890123456789",
      depositCount: 3,
      firstDepositors: 2,
    },
  ],
  observedFrom: today - 10 * DAY + 1000,
  updatedAt: now - 10000,
  projectionBackfillComplete: true,
  pending: false,
  excludedRecords: 1,
};
async function fixture() {
  const store = await createStore({ memory: true, databaseUrl: "" });
  stores.push(store);
  const summary: ProtocolSummary = {
    ok: true,
    source: { at: now, block: "1" },
    balances: { tvl: "1", margin: "0", lp: "1", reserve: "0", queue: "0" },
    activity: { volume: "1", open: 1 },
    fees: { pending: "0", lifetime: "0" },
    paper: { supply: "0", staked: "0" },
  };
  await store.put("summary", summary, now);
  await store.put("collector-heartbeat", { at: now, errors: {} }, now);
  const read = vi.spyOn(store.depositMetrics, "read").mockResolvedValue(rollup);
  return { store, read };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
});

describe("saved deposit chart delivery", () => {
  it("uses one bounded rollup read and shares exact amounts in the existing chart snapshot", async () => {
    const { store, read } = await fixture();
    await refreshProtocolCharts(store, now);
    expect(read).toHaveBeenCalledExactlyOnceWith(today - 6 * DAY, today + DAY);
    const snapshot = await readProtocolCharts(store, now);
    expect(snapshot.deposits).toEqual({
      intervalMs: DAY,
      timeZone: "UTC",
      days: rollup.days,
      observedFrom: rollup.observedFrom,
      updatedAt: rollup.updatedAt,
      stale: false,
      coverage: {
        partial: true,
        identityAmbiguous: true,
        projectionBackfillComplete: true,
        pending: false,
        excludedRecords: 1,
      },
    });
    // Viewer reads only the shared snapshots, never the projection or raw ledgers.
    await Promise.all(
      Array.from({ length: 20 }, () => readProtocolCharts(store, now)),
    );
    expect(read).toHaveBeenCalledTimes(1);
    const revision = snapshot.panelRevision;
    await refreshProtocolCharts(store, now + 1000);
    expect((await readProtocolCharts(store, now + 1000)).panelRevision).toBe(
      revision,
    );
    read.mockResolvedValue({
      ...rollup,
      days: [{ ...rollup.days[0], firstDepositors: 3 }],
    });
    await refreshProtocolCharts(store, now + 2000);
    expect(
      (await readProtocolCharts(store, now + 2000)).panelRevision,
    ).not.toBe(revision);
  });

  it("keeps last good deposit totals on failure while independent protocol charts continue", async () => {
    const { store, read } = await fixture();
    await refreshProtocolCharts(store, now);
    read.mockRejectedValue(new Error("projection query timed out"));
    const publications = await refreshProtocolCharts(store, now + 1000);
    expect(publications.map((item) => item.key)).toEqual([
      "protocol-charts",
      "paper-economics",
    ]);
    const delayed = await readProtocolCharts(store, now + 1000);
    expect(delayed.stale).toBe(false);
    expect(delayed.deposits).toMatchObject({
      days: rollup.days,
      updatedAt: rollup.updatedAt,
      stale: true,
      error: expect.stringContaining("delayed"),
    });
    read.mockResolvedValue(rollup);
    await refreshProtocolCharts(store, now + 2000);
    expect(
      (await readProtocolCharts(store, now + 2000)).deposits,
    ).toMatchObject({ stale: false });
    expect(
      (await readProtocolCharts(store, now + 2000)).deposits?.error,
    ).toBeUndefined();
  });

  it("preserves unknown empty data and independent projection errors without claiming fresh history", async () => {
    const { store, read } = await fixture();
    read.mockRejectedValue(new Error("temporarily unavailable"));
    await refreshProtocolCharts(store, now);
    expect((await readProtocolCharts(store, now)).deposits).toMatchObject({
      days: [],
      observedFrom: null,
      updatedAt: null,
      stale: true,
      coverage: {
        partial: true,
        projectionBackfillComplete: false,
        pending: true,
      },
    });
    read.mockResolvedValue(rollup);
    await refreshProtocolCharts(store, now + 1000);
    await store.put(
      "collector-heartbeat",
      { at: now + 1000, errors: { "position-metrics": "failed" } },
      now + 1000,
    );
    const failed = await readProtocolCharts(store, now + 1000);
    expect(failed.stale).toBe(false);
    expect(failed.deposits?.stale).toBe(true);
    await store.put("collector-heartbeat", { at: now + 1001, errors: { "wallet-indexer": "intake failed" } }, now + 1001);
    const historyDelayed = await readProtocolCharts(store, now + 1001);
    expect(historyDelayed.stale).toBe(false);
    expect(historyDelayed.deposits?.stale).toBe(true);
    expect((await readProtocolCharts(store, now + 31001)).deposits?.stale).toBe(
      true,
    );
  });

  it("reads older deployed snapshots without inventing deposit data", async () => {
    const { store } = await fixture();
    await refreshProtocolCharts(store, now);
    const saved = (await store.get<ProtocolChartsResponse>("protocol-charts"))!
      .value;
    delete saved.deposits;
    await store.put("protocol-charts", saved, now);
    expect((await readProtocolCharts(store, now)).deposits).toBeUndefined();
  });
});
