import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelRevisions, StreamMessage } from "../../../packages/shared/src/types.js";
import {
  PanelPublisher,
  snapshotPanelRevision,
  validPanelRevisions,
  type PanelPublication,
} from "../src/panel-revisions.js";
import { refreshProtocolCharts } from "../src/protocol-charts.js";

const publishers: PanelPublisher[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
});
afterEach(async () => {
  await Promise.all(publishers.splice(0).map((publisher) => publisher.stop()));
  vi.useRealTimers();
});
function fixture() {
  const manifests: PanelRevisions[] = [];
  const store = {
    put: vi.fn(async (_key: string, value: unknown, _at?: number) => {
      manifests.push(structuredClone(value as PanelRevisions));
    }),
    event: vi.fn(async (_message: StreamMessage) => "1"),
  };
  const notify = vi.fn();
  const report = vi.fn();
  const publisher = new PanelPublisher(store, notify, report, () => Date.now());
  publisher.health(new Map(), true);
  publisher.start();
  publishers.push(publisher);
  return { publisher, store, manifests, notify, report };
}
function publication(overrides: Partial<PanelPublication> = {}): PanelPublication {
  return {
    key: "house",
    revision: snapshotPanelRevision({ fundsRaw: "1000000000000000000", sourceAt: 99000 }),
    receivedAt: 100000,
    sourceAt: 99000,
    stale: false,
    freshUntil: 115000,
    ...overrides,
  };
}

describe("shared panel publication hints", () => {
  it("coalesces post-commit publications and heartbeats without changing observation clocks", async () => {
    const { publisher, store, manifests, notify } = fixture();
    publisher.committed(publication());
    publisher.committed(publication({ key: "paper-economics" }));
    publisher.committed(publication({ revision: "new-content" }));
    expect(store.put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.put).toHaveBeenCalledTimes(1);
    expect(store.event).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(Object.keys(manifests[0].panels).sort()).toEqual(["house", "paper-economics"]);
    await vi.advanceTimersByTimeAsync(10000);
    expect(manifests).toHaveLength(2);
    expect(manifests[1].publishedAt).toBe(111000);
    expect(manifests[1].panels.house).toEqual(manifests[0].panels.house);
  });

  it("keeps source and dependency failures stale until a successful publication", async () => {
    const { publisher, manifests } = fixture();
    publisher.committed(publication());
    await publisher.flush();
    const originalRevision = manifests.at(-1)!.panels.house!.revision;
    publisher.health(new Map([["asset-market", "source unavailable"]]), true);
    await publisher.flush();
    expect(manifests.at(-1)!.panels.house!.stale).toBe(true);
    const failedRevision = manifests.at(-1)!.panels.house!.revision;
    publisher.health(new Map(), true);
    await publisher.flush();
    expect(manifests.at(-1)!.panels.house!.revision).toBe(failedRevision);
    publisher.committed(publication({ receivedAt: 100100 }));
    await publisher.flush();
    expect(manifests.at(-1)!.panels.house!.stale).toBe(false);
    expect(manifests.at(-1)!.panels.house!.revision).toBe(originalRevision);
    vi.setSystemTime(116000);
    await publisher.flush();
    expect(manifests.at(-1)!.panels.house).toMatchObject({
      receivedAt: 100100, sourceAt: 99000, stale: true,
    });
  });

  it("does not treat liquidation observation timestamps as a source clock or hide stream outages", async () => {
    const { publisher, manifests } = fixture();
    publisher.committed(publication({ key: "liquidation-stats", sourceAt: null }));
    await publisher.flush();
    publisher.health(new Map(), false);
    await publisher.flush();
    expect(manifests.at(-1)!.panels["liquidation-stats"]).toMatchObject({ sourceAt: null, stale: true });
    publisher.health(new Map(), true);
    await publisher.flush();
    expect(manifests.at(-1)!.panels["liquidation-stats"]!.stale).toBe(true);
  });

  it("keeps House health independent from PAPER summary failures", async () => {
    const { publisher, manifests } = fixture();
    publisher.committed(publication());
    publisher.committed(publication({ key: "paper-economics" }));
    publisher.health(new Map([["summary", "summary unavailable"]]), true);
    await publisher.flush();
    expect(manifests.at(-1)!.panels.house!.stale).toBe(false);
    expect(manifests.at(-1)!.panels["paper-economics"]!.stale).toBe(true);
  });

  it("bounds slow persistence to one in-flight flush and one coalesced successor", async () => {
    const { publisher, store, manifests } = fixture();
    let release!: () => void;
    store.put.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    publisher.committed(publication());
    const first = publisher.flush();
    await Promise.resolve();
    for (let i = 0; i < 100; i++) {
      publisher.committed(publication({ receivedAt: 100000 + i, revision: `funds:${i}` }));
      expect(publisher.flush()).toBe(first);
    }
    await vi.advanceTimersByTimeAsync(20000);
    expect(store.put).toHaveBeenCalledTimes(1);
    release();
    await first;
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.put).toHaveBeenCalledTimes(2);
    expect(manifests[0].panels.house!.receivedAt).toBe(100099);
  });

  it("does not notify after a failed durable write and safely retries the hint", async () => {
    const { publisher, store, notify, report } = fixture();
    publisher.committed(publication());
    store.put.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(publisher.flush()).rejects.toThrow("database unavailable");
    expect(store.event).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(expect.any(Error));
    store.event.mockRejectedValueOnce(new Error("event write failed"));
    await expect(publisher.flush()).rejects.toThrow("event write failed");
    expect(notify).not.toHaveBeenCalled();
    await publisher.flush();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenLastCalledWith(null);
  });

  it("waits for both chart snapshots and reads deposit totals once before returning descriptors", async () => {
    let release!: () => void;
    const store = {
      get: vi.fn(async () => null),
      history: { protocolChartRows: vi.fn(async () => []) },
      depositMetrics: { read: vi.fn(async () => ({
        days: [], observedFrom: null, updatedAt: null,
        projectionBackfillComplete: true, pending: false, excludedRecords: 0,
      })) },
      put: vi.fn(async (key: string, _value: unknown, _at?: number) => {
        if (key === "paper-economics") await new Promise<void>((resolve) => { release = resolve; });
      }),
    };
    let returned = false;
    const pending = refreshProtocolCharts(store as never, 100000).then((value) => {
      returned = true;
      return value;
    });
    await vi.waitFor(() => expect(store.put).toHaveBeenCalledTimes(2));
    expect(returned).toBe(false);
    release();
    const publications = await pending;
    expect(publications.map((entry) => entry.key)).toEqual(["protocol-charts", "paper-economics"]);
    for (const [index, publication] of publications.entries()) {
      expect(store.put.mock.calls[index][1]).toMatchObject({ panelRevision: publication.revision });
    }
    expect(store.get.mock.calls).toEqual([["summary"], ["onchain-paper"], ["staking-reward-history"], ["staking-reward-history-days"]]);
    expect(store.history.protocolChartRows).toHaveBeenCalledTimes(2);
    expect(store.depositMetrics.read).toHaveBeenCalledTimes(1);
  });

  it("rejects old/unknown capability and invalid timestamps, and ignores regressing publications", async () => {
    const { publisher, manifests } = fixture();
    publisher.committed(publication());
    publisher.committed(publication({ receivedAt: 90000, revision: "old" }));
    await publisher.flush();
    const manifest = manifests[0];
    expect(manifest.panels.house!.receivedAt).toBe(100000);
    expect(validPanelRevisions(manifest)).toBe(true);
    expect(validPanelRevisions({ ...manifest, version: 2 })).toBe(false);
    expect(validPanelRevisions({ ...manifest, panels: { arbitrary: manifest.panels.house } })).toBe(false);
    expect(validPanelRevisions({ ...manifest, publishedAt: NaN })).toBe(false);
    expect(validPanelRevisions({ ...manifest, panels: { house: null } })).toBe(false);
  });

  it("drains an existing write on shutdown and schedules no further heartbeat", async () => {
    const { publisher, store } = fixture();
    let release!: () => void;
    store.put.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    publisher.committed(publication());
    const writing = publisher.flush();
    await Promise.resolve();
    let stopped = false;
    const stopping = publisher.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await Promise.all([writing, stopping]);
    publisher.committed(publication({ receivedAt: 120000 }));
    await vi.advanceTimersByTimeAsync(60000);
    expect(store.put).toHaveBeenCalledTimes(1);
  });
});
