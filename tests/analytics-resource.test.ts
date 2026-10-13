import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyticsResources } from "../apps/web/src/lib/analytics-resource";
import { ApiError } from "../apps/web/src/lib/api";
import {
  decodePanelRevisions,
  getPanelDelivery,
  publishLiveConnection,
  publishLiveEvent,
  type PanelDelivery,
} from "../apps/web/src/lib/live-events";
import type { Overview } from "../packages/shared/src/types";

const AT = Date.UTC(2026, 9, 12);
const paths = [
  "/api/house",
  "/api/protocol/charts",
  "/api/paper/economics",
  "/api/liquidations/stats",
];
const keys = [
  "house",
  "protocol-charts",
  "paper-economics",
  "liquidation-stats",
] as const;
const publication = (revision = "a", stale = false): PanelDelivery => ({
  connected: true,
  observedAt: Date.now(),
  envelope: {
    version: 1,
    publishedAt: Date.now(),
    panels: Object.fromEntries(
      keys.map((key) => [
        key,
        { revision, stale, receivedAt: Date.now(), sourceAt: Date.now() },
      ]),
    ),
  },
});
const response = () => ({
  receivedAt: Date.now(),
  sourceAt: Date.now(),
  stale: false,
  houseStale: false,
  value: 10,
  panelRevision: "a",
});
let resources: AnalyticsResources;
let hidden = false;
let read: ReturnType<typeof vi.fn>;
const flush = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AT);
  hidden = false;
  read = vi.fn(async () => response());
  resources = new AnalyticsResources({
    read,
    now: () => Date.now(),
    random: () => 0,
    hidden: () => hidden,
  });
});
afterEach(() => {
  resources.dispose();
  vi.useRealTimers();
});

describe("shared snapshot refresh", () => {
  it("shares concurrent and StrictMode consumers and preserves warm-cache expiry", async () => {
    const first = resources.subscribe(paths[0], () => {});
    first();
    const second = resources.subscribe(paths[0], () => {});
    const third = resources.subscribe(paths[0], () => {});
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    second();
    third();
    await vi.advanceTimersByTimeAsync(2000);
    resources.subscribe(paths[0], () => {});
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reduces four unchanged panel downloads from 28 to 8 over 30 seconds with heartbeats", async () => {
    for (const path of paths) resources.subscribe(path, () => {});
    await flush();
    await vi.advanceTimersByTimeAsync(30000);
    expect(read).toHaveBeenCalledTimes(28);
    resources.dispose();
    read.mockClear();
    resources = new AnalyticsResources({
      read,
      now: () => Date.now(),
      random: () => 0,
      hidden: () => hidden,
    });
    resources.setDelivery(publication());
    for (const path of paths) resources.subscribe(path, () => {});
    await flush();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(10000);
      resources.setDelivery(publication());
    }
    expect(read).toHaveBeenCalledTimes(8);
    expect(resources.diagnostics()).toMatchObject({
      requests: 8,
      recoveryRequests: 4,
    });
  });

  it("coalesces changing revisions without starvation and retains invalidation during a fetch", async () => {
    resources.setDelivery(publication());
    resources.subscribe(paths[0], () => {});
    await flush();
    let resolve!: (value: unknown) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      resources.setDelivery(publication(String(i)));
    }
    expect(read).toHaveBeenCalledTimes(2);
    resources.setDelivery(publication("newer-during-request"));
    resolve(response());
    await flush();
    await vi.advanceTimersByTimeAsync(4999);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(3);
    resources.setDelivery(publication("newer-during-request"));
    await flush();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("falls back on expiry, disconnect and old-server reconnect, leaving unsupported URLs on their cadence", async () => {
    resources.setDelivery(publication());
    resources.subscribe(paths[0], () => {});
    resources.subscribe("/api/assets", () => {});
    await flush();
    await vi.advanceTimersByTimeAsync(20000);
    expect(read.mock.calls.filter(([path]) => path === paths[0])).toHaveLength(
      1,
    );
    expect(
      read.mock.calls.filter(([path]) => path === "/api/assets"),
    ).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(read.mock.calls.filter(([path]) => path === paths[0])).toHaveLength(
      2,
    );
    resources.setDelivery(publication("b"));
    resources.setDelivery({ connected: false, envelope: null, observedAt: 0 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(read.mock.calls.filter(([path]) => path === paths[0])).toHaveLength(
      3,
    );
    resources.setDelivery({ connected: true, envelope: null, observedAt: 0 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(read.mock.calls.filter(([path]) => path === paths[0])).toHaveLength(
      4,
    );
  });

  it("does not let revisions, manual refresh, remount or visibility bypass Retry-After", async () => {
    resources.setDelivery(publication());
    let unsubscribe = resources.subscribe(paths[0], () => {});
    await flush();
    read.mockRejectedValueOnce(new ApiError("Source cooling down", 429, 30000));
    resources.refresh(paths[0]);
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(resources.get(paths[0])).toMatchObject({
      data: { value: 10, stale: true, houseStale: true },
      error: "Source cooling down",
    });
    resources.setDelivery(publication("b"));
    resources.refresh(paths[0]);
    unsubscribe();
    unsubscribe = resources.subscribe(paths[0], () => {});
    hidden = true;
    resources.visibilityChanged();
    await vi.advanceTimersByTimeAsync(10000);
    hidden = false;
    resources.visibilityChanged();
    await vi.advanceTimersByTimeAsync(19999);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it("ages original source values, applies stale hints immediately, and never uses a heartbeat as a value clock", async () => {
    resources.setDelivery(publication());
    resources.subscribe(paths[0], () => {});
    await flush();
    const old = response();
    read.mockResolvedValue(old);
    await vi.advanceTimersByTimeAsync(1000);
    resources.setDelivery(publication("b", true));
    expect(resources.get(paths[0])).toMatchObject({
      data: { sourceAt: AT, receivedAt: AT, stale: true, houseStale: true },
    });
    for (let i = 0; i < 7; i++) {
      await vi.advanceTimersByTimeAsync(10000);
      resources.setDelivery(publication("b", false));
    }
    expect(resources.get(paths[0])).toMatchObject({
      data: { sourceAt: AT, receivedAt: AT, stale: true, houseStale: true },
    });
    expect(resources.diagnostics().resources[0].sourceAgeMs).toBe(71000);
  });

  it("suspends hidden requests and aborts unused navigation requests without overwriting another path", async () => {
    let signal!: AbortSignal, resolve!: (value: unknown) => void;
    read.mockImplementationOnce(
      (_path: string, options: { signal: AbortSignal }) => {
        signal = options.signal;
        return new Promise((r) => {
          resolve = r;
        });
      },
    );
    const unsubscribe = resources.subscribe(paths[0], () => {});
    await flush();
    unsubscribe();
    await flush();
    expect(signal.aborted).toBe(true);
    resources.subscribe(paths[1], () => {});
    await flush();
    resolve({ value: "wrong page" });
    await flush();
    expect(resources.get(paths[1])).toMatchObject({ data: { value: 10 } });
    hidden = true;
    resources.visibilityChanged();
    await vi.advanceTimersByTimeAsync(30000);
    expect(read).toHaveBeenCalledTimes(2);
    hidden = false;
    resources.visibilityChanged();
    await flush();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("bounds unused query snapshots without evicting active subscriptions", async () => {
    resources.subscribe(paths[0], () => {});
    await flush();
    for (let i = 0; i < 30; i++) {
      const stop = resources.subscribe(`/api/leaderboard?page=${i}`, () => {});
      await flush();
      stop();
      await flush();
    }
    expect(resources.get(paths[0]).data).not.toBeNull();
    expect(resources.get("/api/leaderboard?page=0").data).toBeNull();
    expect(resources.get("/api/leaderboard?page=29").data).not.toBeNull();
  });
});

it("keeps an old edge response delayed until the exact revision is returned, with bounded follow-up", async () => {
  resources.setDelivery(publication());
  resources.subscribe(paths[0], () => {});
  await flush();
  await vi.advanceTimersByTimeAsync(5000);
  resources.setDelivery(publication("b"));
  await flush();
  expect(read).toHaveBeenCalledTimes(2);
  expect(resources.get(paths[0])).toMatchObject({
    data: { stale: true, houseStale: true, panelRevision: "a" },
  });
  await vi.advanceTimersByTimeAsync(5000);
  expect(read).toHaveBeenCalledTimes(3);
  for (let i = 0; i < 2; i++) {
    resources.setDelivery(publication("b"));
    await vi.advanceTimersByTimeAsync(10000);
  }
  expect(read).toHaveBeenCalledTimes(3);
  read.mockResolvedValue({ ...response(), panelRevision: "b" });
  resources.setDelivery(publication("b"));
  await vi.advanceTimersByTimeAsync(10000);
  expect(read).toHaveBeenCalledTimes(4);
  expect(resources.get(paths[0])).toMatchObject({
    data: { stale: false, panelRevision: "b" },
  });
});

it("refreshes a same-content health transition and preserves independent House health", async () => {
  read.mockResolvedValue({ ...response(), stale: true, houseStale: false });
  resources.setDelivery(publication());
  resources.subscribe(paths[0], () => {});
  await flush();
  expect(resources.get(paths[0])).toMatchObject({
    data: { stale: true, houseStale: false },
  });
  await vi.advanceTimersByTimeAsync(5000);
  resources.setDelivery(publication("a", true));
  await flush();
  expect(read).toHaveBeenCalledTimes(2);
  expect(resources.get(paths[0])).toMatchObject({ data: { houseStale: true } });
  await vi.advanceTimersByTimeAsync(5000);
  resources.setDelivery(publication("a", false));
  await flush();
  expect(read).toHaveBeenCalledTimes(3);
  expect(resources.get(paths[0])).toMatchObject({
    data: { houseStale: false },
  });
});

it("unchanged heartbeats and age checks preserve snapshot identity and do not rerender unrelated panels", async () => {
  const listener = vi.fn();
  resources.setDelivery(publication());
  resources.subscribe(paths[0], listener);
  await flush();
  const snapshot = resources.get(paths[0]);
  listener.mockClear();
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(5000);
    const delivery = publication();
    delivery.envelope!.panels["paper-economics"]!.revision = String(i);
    resources.setDelivery(delivery);
  }
  expect(resources.get(paths[0])).toBe(snapshot);
  expect(listener).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(1);
});

it("staggers visible-tab recovery and keeps the retry deadline as the stronger bound", async () => {
  let random = 0;
  resources.dispose();
  resources = new AnalyticsResources({
    read,
    now: () => Date.now(),
    random: () => random,
    hidden: () => hidden,
  });
  resources.subscribe(paths[0], () => {});
  await flush();
  hidden = true;
  resources.visibilityChanged();
  await vi.advanceTimersByTimeAsync(10000);
  random = 0.5;
  hidden = false;
  resources.visibilityChanged();
  await vi.advanceTimersByTimeAsync(374);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
});

it("recovers from a stale hint after disconnecting to an old server without clearing body or source-age staleness", async () => {
  resources.setDelivery(publication("a", true));
  resources.subscribe(paths[0], () => {});
  await flush();
  expect(resources.get(paths[0])).toMatchObject({ data: { houseStale: true } });
  resources.setDelivery({ connected: false, envelope: null, observedAt: 0 });
  resources.setDelivery({ connected: true, envelope: null, observedAt: 0 });
  await vi.advanceTimersByTimeAsync(5000);
  expect(resources.get(paths[0])).toMatchObject({
    data: { stale: false, houseStale: false },
  });
  read.mockResolvedValue({ ...response(), sourceAt: AT - 120000 });
  await vi.advanceTimersByTimeAsync(5000);
  expect(resources.get(paths[0])).toMatchObject({
    data: { stale: true, houseStale: true },
  });
});

it("preserves a bootstrap revision arriving during the initial polling request", async () => {
  let resolve!: (value: unknown) => void;
  read.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  resources.subscribe(paths[0], () => {});
  await flush();
  resources.setDelivery(publication("b"));
  resolve(response());
  await flush();
  expect(resources.get(paths[0])).toMatchObject({ data: { stale: true } });
  read.mockResolvedValue({ ...response(), panelRevision: "b" });
  await vi.advanceTimersByTimeAsync(5000);
  expect(read).toHaveBeenCalledTimes(2);
  expect(resources.get(paths[0])).toMatchObject({
    data: { stale: false, panelRevision: "b" },
  });
});

it("coalesces legacy liquidation bursts at the five-second floor despite poll jitter without bypassing failure cooldown", async () => {
  resources.dispose();
  resources = new AnalyticsResources({
    read,
    now: () => Date.now(),
    random: () => 1,
    hidden: () => hidden,
  });
  const path = "/api/liquidations?instrument=0";
  resources.subscribe(path, () => {}, {
    liveLiquidations: true,
    instrument: 0,
  });
  resources.subscribe(path, () => {}, {
    liveLiquidations: true,
    instrument: 0,
  });
  await flush();
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  resources.trade(1, "liq");
  resources.trade(0, "close");
  expect(resources.diagnostics().notificationRequests).toBe(0);
  for (let i = 0; i < 100; i++) resources.trade(0, "liq");
  await vi.advanceTimersByTimeAsync(3999);
  expect(read).toHaveBeenCalledTimes(1);
  read.mockRejectedValueOnce(new ApiError("Source delayed", 503, 30000));
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
  expect(resources.diagnostics().notificationRequests).toBe(1);
  for (let i = 0; i < 100; i++) resources.trade(0, "liq");
  await vi.advanceTimersByTimeAsync(31999);
  expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(3);
  expect(resources.get(path).error).toBe("");
});

it("ignores legacy liquidation notifications while a request is pending or the tab is hidden", async () => {
  resources.dispose();
  resources = new AnalyticsResources({
    read,
    now: () => Date.now(),
    random: () => 1,
    hidden: () => hidden,
  });
  let resolve!: (value: unknown) => void;
  read.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  resources.subscribe("/api/liquidations", () => {}, {
    liveLiquidations: true,
    instrument: 0,
  });
  await flush();
  for (let i = 0; i < 100; i++) resources.trade(0, "liq");
  await vi.advanceTimersByTimeAsync(1000);
  resolve(response());
  await flush();
  resources.trade(1, "liq");
  resources.trade(0, "open");
  await vi.advanceTimersByTimeAsync(4000);
  expect(read).toHaveBeenCalledTimes(1);
  hidden = true;
  resources.trade(0, "liq");
  hidden = false;
  await vi.advanceTimersByTimeAsync(1999);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
  expect(resources.diagnostics().notificationRequests).toBe(0);
});

it("validates capability envelopes and never accepts resource URLs or malformed hints", () => {
  expect(
    decodePanelRevisions({ version: 2, publishedAt: AT, panels: {} }),
  ).toBeNull();
  expect(
    decodePanelRevisions({ version: 1, publishedAt: NaN, panels: {} }),
  ).toBeNull();
  expect(
    decodePanelRevisions({
      version: 1,
      publishedAt: AT,
      panels: {
        "https://evil.example": { revision: "r" },
        house: { revision: "r", receivedAt: -1, sourceAt: AT, stale: false },
      },
    }),
  ).toEqual({ version: 1, publishedAt: AT, panels: {} });
});

it("accepts the server's top-level bootstrap manifest and forgets it on an old-server reconnect", () => {
  publishLiveConnection(true);
  const panels = publication().envelope!;
  publishLiveEvent({ type: "overview", data: {} as Overview, panels });
  expect(getPanelDelivery()).toMatchObject({
    connected: true,
    envelope: panels,
  });
  publishLiveConnection(false);
  publishLiveConnection(true);
  publishLiveEvent({ type: "overview", data: {} as Overview });
  expect(getPanelDelivery().envelope).toBeNull();
  publishLiveConnection(false);
});
