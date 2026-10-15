import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyticsResources } from "../apps/web/src/lib/analytics-resource";
import { ApiError } from "../apps/web/src/lib/api";
import {
  getAssetDelivery,
  publishLiveConnection,
  publishLiveEvent,
  subscribeAssetDelivery,
} from "../apps/web/src/lib/live-events";
import type { Overview, StreamMessage } from "../packages/shared/src/types";

const AT = Date.UTC(2026, 9, 14);
const paths = ["/api/assets", "/api/assets/0/market?window=15m"];
const quote = (instrument = 0, sourceAt = Date.now(), receivedAt = Date.now()) =>
  publishLiveEvent({
    type: "asset-price",
    data: {
      instrument,
      point: { time: sourceAt, priceUsd: 100 },
      receivedAt,
    },
  });
const flush = () => vi.advanceTimersByTimeAsync(0);
let resources: AnalyticsResources;
let hidden = false;
let read: ReturnType<typeof vi.fn>;
let unsubscribe: () => void;
const startResources = () => {
  resources = new AnalyticsResources({
    read,
    now: () => Date.now(),
    random: () => 0,
    hidden: () => hidden,
  });
  resources.setAssetDelivery(getAssetDelivery());
  unsubscribe = subscribeAssetDelivery((delivery) =>
    resources.setAssetDelivery(delivery),
  );
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AT);
  publishLiveConnection(false);
  hidden = false;
  read = vi.fn(async () => ({
    receivedAt: Date.now(),
    sourceAt: Date.now(),
    activityReceivedAt: Date.now(),
    stale: false,
    coverage: { tradesCapped: false },
    history: [{ time: AT, value: 10 }],
  }));
  startResources();
});
afterEach(() => {
  unsubscribe();
  resources.dispose();
  publishLiveConnection(false);
  vi.useRealTimers();
});

describe("asset snapshot reconciliation", () => {
  it("reduces two snapshot downloads from 26 to 8 in a minute while retaining authoritative history and coverage", async () => {
    for (const path of paths)
      resources.subscribe(path, () => {}, { liveAsset: 0 });
    await flush();
    await vi.advanceTimersByTimeAsync(60000);
    expect(read).toHaveBeenCalledTimes(26);
    unsubscribe();
    resources.dispose();
    read.mockClear();
    publishLiveConnection(true, "overview,asset:0");
    quote();
    startResources();
    for (const path of paths)
      resources.subscribe(path, () => {}, { liveAsset: 0 });
    await flush();
    const initial = resources.get(paths[1]).data;
    await vi.advanceTimersByTimeAsync(10000);
    quote();
    expect(resources.get(paths[1]).data).toBe(initial);
    read.mockImplementation(async () => ({
      receivedAt: Date.now(),
      sourceAt: Date.now(),
      activityReceivedAt: Date.now(),
      stale: false,
      coverage: { tradesCapped: true },
      history: [{ time: AT, value: 11 }],
    }));
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(10000);
      quote();
    }
    expect(read).toHaveBeenCalledTimes(8);
    expect(resources.diagnostics()).toMatchObject({
      requests: 8,
      recoveryRequests: 6,
      pollingRequests: 0,
    });
    expect(resources.get(paths[1]).data).toMatchObject({
      coverage: { tradesCapped: true },
      history: [{ time: AT, value: 11 }],
    });
  });

  it("polls promptly on disconnect and only slows again after this connection receives a fresh relevant quote", async () => {
    publishLiveConnection(true, "overview,asset:0");
    quote();
    resources.subscribe(paths[1], () => {}, { liveAsset: 0 });
    await flush();
    await vi.advanceTimersByTimeAsync(6000);
    expect(read).toHaveBeenCalledTimes(1);
    publishLiveConnection(false);
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    publishLiveConnection(true, "overview,asset:0");
    publishLiveEvent({ type: "overview", data: {} as Overview });
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(3);
    quote();
    await vi.advanceTimersByTimeAsync(10000);
    quote();
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10000);
    quote();
    await vi.advanceTimersByTimeAsync(10000);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("expires a silent asset feed even while unrelated asset quotes and panel heartbeats arrive", async () => {
    publishLiveConnection(true, "overview,asset:0,asset:1");
    quote();
    resources.subscribe(paths[1], () => {}, { liveAsset: 0 });
    await flush();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(5000);
      quote(1);
      publishLiveEvent({
        type: "panel-revisions",
        data: { version: 1, publishedAt: Date.now(), panels: {} },
      });
    }
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("clears prior asset health when topics change and keeps query-window snapshots independent", async () => {
    publishLiveConnection(true, "overview,asset:0");
    quote();
    resources.subscribe(paths[1], () => {}, { liveAsset: 0 });
    await flush();
    await vi.advanceTimersByTimeAsync(6000);
    publishLiveConnection(true, "overview,asset:1");
    quote(1);
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(getAssetDelivery().quotes[0]).toBeUndefined();
    quote(0); // A replay for a topic this connection did not request is no proof.
    expect(getAssetDelivery().quotes[0]).toBeUndefined();
    resources.subscribe("/api/assets/1/market?window=5m", () => {}, {
      liveAsset: 1,
    });
    resources.subscribe("/api/assets/1/market?window=1h", () => {}, {
      liveAsset: 1,
    });
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(5);
    expect(resources.diagnostics().resources.map(({ mode }) => mode)).toEqual([
      "poll",
      "events",
      "events",
    ]);
  });

  it("does not suppress polling for non-live consumers or unrelated endpoints", async () => {
    publishLiveConnection(true, "overview,asset:0");
    quote();
    resources.subscribe(paths[0], () => {}, { liveAsset: 0 });
    const stopPlain = resources.subscribe(paths[0], () => {});
    resources.subscribe("/api/leaderboard", () => {}, { liveAsset: 0 });
    resources.subscribe("/api/assets/1/market?window=15m", () => {}, {
      liveAsset: 0,
    });
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(6);
    stopPlain();
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(8);
  });

  it("keeps retry deadlines stronger than live recovery, refresh, remount and visibility", async () => {
    publishLiveConnection(true, "overview,asset:0");
    quote();
    let stop = resources.subscribe(paths[0], () => {}, { liveAsset: 0 });
    await flush();
    const initial = resources.get(paths[0]).data;
    read.mockRejectedValueOnce(new ApiError("Cooling down", 429, 30000));
    resources.refresh(paths[0]);
    await flush();
    expect(resources.get(paths[0])).toMatchObject({
      data: { ...(initial as Record<string, unknown>), stale: true },
      error: "Cooling down",
    });
    publishLiveConnection(false);
    publishLiveConnection(true, "overview,asset:0");
    quote();
    resources.refresh(paths[0]);
    stop();
    stop = resources.subscribe(paths[0], () => {}, { liveAsset: 0 });
    hidden = true;
    resources.visibilityChanged();
    await vi.advanceTimersByTimeAsync(10000);
    hidden = false;
    resources.visibilityChanged();
    quote();
    await vi.advanceTimersByTimeAsync(19999);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(3);
    expect(resources.get(paths[0]).error).toBe("");
    stop();
  });

  it("pauses hidden downloads and reconciles on resume after the lease expires", async () => {
    publishLiveConnection(true, "overview,asset:0");
    quote();
    resources.subscribe(paths[1], () => {}, { liveAsset: 0 });
    await flush();
    hidden = true;
    resources.visibilityChanged();
    await vi.advanceTimersByTimeAsync(60000);
    expect(read).toHaveBeenCalledTimes(1);
    hidden = false;
    resources.visibilityChanged();
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    quote();
    await vi.advanceTimersByTimeAsync(10000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not treat replay receipt as a fresh source or let malformed prices establish live health", async () => {
    publishLiveConnection(true, "overview,asset:0");
    quote(0, AT - 30000);
    resources.subscribe(paths[1], () => {}, { liveAsset: 0 });
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(2);
    quote();
    const healthy = getAssetDelivery();
    publishLiveEvent({
      type: "asset-price",
      data: { instrument: 0, point: { time: Date.now(), priceUsd: -1 } },
    } as StreamMessage);
    quote(0, Date.now() + 30001);
    quote(0, Date.now(), Date.now() + 30001);
    quote(0, AT - 30000);
    expect(getAssetDelivery()).toBe(healthy);
    await vi.advanceTimersByTimeAsync(20001);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("refreshes healthy open interest before expiry and restores fast polling when backend clocks stall despite fresh prices", async () => {
    publishLiveConnection(true, "overview,asset:0");
    quote();
    resources.subscribe(paths[0], () => {}, { liveAsset: 0 });
    await flush();
    expect(resources.get(paths[0]).data).toMatchObject({ stale: false });
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(10000);
      quote();
      expect(resources.get(paths[0]).data).toMatchObject({ stale: false });
    }
    expect(read).toHaveBeenCalledTimes(3);
    expect(resources.get(paths[0]).data).toMatchObject({
      receivedAt: AT + 30000,
      sourceAt: AT + 30000,
      activityReceivedAt: AT + 30000,
      stale: false,
    });
    read.mockImplementation(async () => ({
      receivedAt: Date.now(),
      sourceAt: AT,
      activityReceivedAt: AT,
      stale: false,
    }));
    resources.refresh(paths[0]);
    await flush();
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(5000);
      quote();
      expect(resources.get(paths[0]).data).toMatchObject({
        sourceAt: AT,
        activityReceivedAt: AT,
        stale: true,
      });
    }
    expect(read).toHaveBeenCalledTimes(6);
    expect(resources.diagnostics().resources[0].mode).toBe("poll");
  });

  it("leaves headroom for an already-aged asset snapshot and keeps server stale errors on fast polling", async () => {
    read.mockResolvedValueOnce({
      receivedAt: AT - 10000,
      sourceAt: AT,
      activityReceivedAt: AT,
      stale: false,
    });
    publishLiveConnection(true, "overview,asset:0");
    quote();
    resources.subscribe(paths[0], () => {}, { liveAsset: 0 });
    await flush();
    await vi.advanceTimersByTimeAsync(8999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    read.mockImplementation(async () => ({
      receivedAt: Date.now(),
      sourceAt: Date.now(),
      activityReceivedAt: Date.now(),
      stale: true,
      error: "Trade activity snapshot is delayed.",
    }));
    resources.refresh(paths[0]);
    await flush();
    quote();
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(4);
    expect(resources.diagnostics().resources[0].mode).toBe("poll");
  });
});
