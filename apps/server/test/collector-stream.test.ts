import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEmitter } from "node:events";
import type { Overview } from "../../../packages/shared/src/types.js";
import { Collector, type StreamDiagnostics } from "../src/collector.js";
import { createStore, type Store } from "../src/store.js";
import { Upstream } from "../src/upstream.js";
import { ChangeBus } from "../src/bus.js";

interface MockSubscription extends EventEmitter {
  state: "unsubscribed" | "subscribing" | "subscribed";
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
}
interface MockClient extends EventEmitter {
  state: "disconnected" | "connecting" | "connected";
  subscription: MockSubscription;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}
const clients = vi.hoisted(() => [] as MockClient[]);
vi.mock("../src/market-feed.js", () => ({
  MarketFeed: class {
    start() {}
    async stop() {}
  },
}));
vi.mock("centrifuge", async () => {
  const { EventEmitter } = await import("node:events");
  class Subscription extends EventEmitter {
    state = "unsubscribed";
    subscribe = vi.fn(() => {
      this.state = "subscribing";
      this.emit("subscribing", { code: 0, reason: "subscribe called" });
    });
    unsubscribe = vi.fn(() => {
      this.state = "unsubscribed";
      this.emit("unsubscribed", { code: 0, reason: "unsubscribe called" });
    });
  }
  return {
    Centrifuge: class extends EventEmitter {
      state = "disconnected";
      subscription = new Subscription();
      constructor() {
        super();
        clients.push(this as unknown as MockClient);
      }
      newSubscription() {
        return this.subscription;
      }
      connect = vi.fn(() => {
        this.state = "connecting";
        this.emit("connecting", { code: 0, reason: "connect called" });
      });
      disconnect = vi.fn(() => {
        this.state = "disconnected";
        this.subscription.state = "subscribing";
        this.subscription.emit("subscribing", {
          code: 1,
          reason: "transport closed",
        });
        this.emit("disconnected", { code: 0, reason: "disconnect called" });
      });
    },
  };
});

let store: Store;
let upstream: Upstream;
let bus: ChangeBus;
let collector: Collector;
let client: MockClient;
let unblocks: (() => void)[];
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  clients.length = 0;
  unblocks = [];
  store = await createStore({ memory: true, databaseUrl: "" });
  upstream = new Upstream(store);
  vi.spyOn(upstream, "request").mockImplementation(
    async <T>(path: string) => source(path) as T,
  );
  bus = new ChangeBus();
  collector = new Collector(store, upstream, bus);
  await collector.start();
  client = clients[0];
  await flush();
});
afterEach(async () => {
  for (const unblock of unblocks) unblock();
  await collector.stop();
  await upstream.close();
  bus.close();
  await store.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function source(path: string): unknown {
  if (path === "/query/protocol/summary")
    return {
      ok: true,
      source: { block: "1", at: Date.now() },
      balances: { tvl: "1", margin: "0", lp: "0", reserve: "0", queue: "0" },
      activity: { volume: "0", open: 0 },
      fees: { pending: "0", lifetime: "0" },
      paper: { supply: "0", staked: "0" },
    };
  if (path === "/state/house/current")
    return {
      ok: true,
      historyGeneration: "fixture",
      historyRevision: "fixture",
      sourceAsOfMs: Date.now(),
      head: [Date.now(), 0, 0, 0, 0, 0, 0, 0],
    };
  if (path === "/query/protocol/history?interval=1m")
    return {
      startMs: Date.now() - 60000,
      intervalMs: 60000,
      source: { asOfMs: Date.now(), revision: "1", generation: "fixture" },
      columns: { tvl: [0] },
    };
  if (path === "/query/protocol/trades/recent") return { ok: true, events: [] };
  if (path.startsWith("/state/leaderboard/accounts?"))
    return {
      ok: true,
      accounts: [],
      count: 0,
      pageInfo: { page: 0, totalPages: 1 },
      summary: {
        uniqueAccounts: 0,
        trackedBalance: "0",
        trackedQueued: "0",
        trackedOpenNotional: "0",
        trackedPaper: "0",
      },
    };
  throw new Error(`Unexpected fixture request: ${path}`);
}
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}
async function subscribed() {
  client.state = "connected";
  client.emit("connected", {
    client: "private-client-id",
    data: { token: "context-secret" },
  });
  client.subscription.state = "subscribed";
  client.subscription.emit("subscribed", {
    recoverable: false,
    wasRecovering: false,
    data: { token: "context-secret" },
  });
  await flush();
}
async function diagnostic() {
  return (await store.get<StreamDiagnostics>("stream-diagnostics"))!.value;
}
async function streamState() {
  return (await store.get<Overview>("overview"))!.value.status;
}
async function streamError() {
  return (await store.get<{ errors: Record<string, string> }>(
    "collector-heartbeat",
  ))!.value.errors.stream;
}
function publication() {
  return {
    data: [
      {
        ts: Date.now(),
        wallet: `0x${"1".repeat(40)}`,
        instrument: "BTC",
        side: "long",
        leverage: 2,
        notionalUsd: 10,
        kind: "open",
        pnlUsd: null,
      },
    ],
  };
}
function blockDiagnostic(event: string) {
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  unblocks.push(unblock);
  const original = store.put.bind(store);
  let blocked = false;
  const writes: string[] = [];
  vi.spyOn(store, "put").mockImplementation(async (key, value, receivedAt) => {
    if (key === "stream-diagnostics") {
      const name = (value as StreamDiagnostics).event;
      writes.push(name);
      if (name === event && !blocked) {
        blocked = true;
        await gate;
      }
    }
    return original(key, value, receivedAt);
  });
  return { unblock, writes };
}

describe("collector stream lifecycle diagnostics", () => {
  it("persists a terminal client refusal without reconnecting or leaking context/reason credentials", async () => {
    await subscribed();
    const lastSubscribedAt = Date.now();
    vi.setSystemTime(lastSubscribedAt + 1);
    client.state = "disconnected";
    client.subscription.state = "subscribing";
    client.emit("disconnected", {
      code: 3503,
      reason: `force disconnect\r\n token=reason-secret\t${"x".repeat(400)}`,
      data: { token: "context-secret" },
    });
    await flush();
    const saved = await diagnostic();
    expect(saved).toMatchObject({
      event: "disconnected",
      code: 3503,
      clientState: "disconnected",
      subscriptionState: "subscribing",
      lastSubscribedAt,
    });
    expect(saved.reason).toContain("token=[redacted]");
    expect(saved.reason.length).toBeLessThanOrEqual(240);
    expect(saved.reason).not.toMatch(/[\r\n\t]/);
    expect(JSON.stringify(saved)).not.toMatch(
      /context-secret|reason-secret|private-client-id/,
    );
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toMatch(
      /context-secret|reason-secret|private-client-id/,
    );
    expect(await streamState()).toMatchObject({
      stream: "disconnected",
      message: expect.stringContaining("Trade connection is disconnected."),
    });
    expect(await streamError()).toBe("Trade connection is disconnected.");
    await vi.advanceTimersByTimeAsync(60000);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.subscription.subscribe).toHaveBeenCalledTimes(1);
  });

  it("records terminal unsubscribe while the WebSocket itself remains connected", async () => {
    await subscribed();
    client.subscription.state = "unsubscribed";
    client.subscription.emit("unsubscribed", {
      code: 103,
      reason: "permission denied",
    });
    await flush();
    expect(await diagnostic()).toMatchObject({
      event: "unsubscribed",
      clientState: "connected",
      subscriptionState: "unsubscribed",
      code: 103,
      reason: "permission denied",
    });
    expect((await streamState()).stream).toBe("disconnected");
    expect(await streamError()).toBe("Trade connection is unavailable.");
    expect(client.subscription.subscribe).toHaveBeenCalledTimes(1);
  });

  it.each(["subscribed", "subscribing"] as const)(
    "uses actual subscription state during a transient %s error and clears the outage on recovery",
    async (state) => {
      await subscribed();
      client.subscription.state = state;
      client.subscription.emit("error", {
        type: "refresh",
        error: {
          code: 100,
          message: "temporary upstream failure",
          temporary: true,
        },
      });
      await flush();
      expect(await diagnostic()).toMatchObject({
        event: "subscription-error",
        code: 100,
        clientState: "connected",
        subscriptionState: state,
      });
      expect((await streamState()).stream).toBe(
        state === "subscribed" ? "connected" : "connecting",
      );
      expect(await streamError()).toContain("temporarily unavailable");
      vi.setSystemTime(Date.now() + 1);
      await subscribed();
      expect(await diagnostic()).toMatchObject({
        event: "subscribed",
        lastSubscribedAt: Date.now(),
      });
      expect((await streamState()).stream).toBe("connected");
      expect(await streamError()).toBeUndefined();
    },
  );

  it("serializes delayed diagnostic writes so an old disconnect cannot overwrite recovery", async () => {
    await subscribed();
    const blocked = blockDiagnostic("disconnected");
    client.state = "disconnected";
    client.subscription.state = "subscribing";
    client.emit("disconnected", { code: 100, reason: "upstream failure" });
    await flush();
    vi.setSystemTime(Date.now() + 1);
    await subscribed();
    expect(blocked.writes).toEqual(["disconnected"]);
    blocked.unblock();
    await flush();
    expect(blocked.writes).toEqual(["disconnected", "connected", "subscribed"]);
    expect(await diagnostic()).toMatchObject({
      event: "subscribed",
      at: Date.now(),
      lastSubscribedAt: Date.now(),
    });
    expect((await streamState()).stream).toBe("connected");
    expect(await streamError()).toBeUndefined();
  });

  it("clears a transient error only after valid persisted traffic on a healthy subscription", async () => {
    await subscribed();
    client.subscription.emit("error", {
      type: "refresh",
      error: { code: 100, message: "temporary refresh failure" },
    });
    client.subscription.emit("publication", { data: [] });
    await flush();
    expect((await diagnostic()).event).toBe("publication-error");
    expect(await streamError()).toBeTruthy();
    expect(await store.trades()).toEqual([]);
    client.subscription.emit("publication", publication());
    await flush();
    expect(await store.trades()).toHaveLength(1);
    expect((await diagnostic()).event).toBe("publication-recovered");
    expect(await streamError()).toBeUndefined();

    // A late publication after a terminal event is not evidence of recovery.
    client.state = "disconnected";
    client.emit("disconnected", { code: 3503, reason: "force disconnect" });
    client.subscription.emit("publication", publication());
    await flush();
    expect((await diagnostic()).event).toBe("disconnected");
    expect((await streamState()).stream).toBe("disconnected");
    expect(await streamError()).toContain("is disconnected");
  });

  it("does not let an older pending publication clear a newer healthy-state error", async () => {
    await subscribed();
    client.subscription.emit("error", {
      type: "refresh",
      error: { code: 100, message: "first refresh failure" },
    });
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    unblocks.push(unblock);
    const original = store.recordTrade.bind(store);
    vi.spyOn(store, "recordTrade").mockImplementation(async (trade) => {
      await gate;
      return original(trade);
    });
    client.subscription.emit("publication", publication());
    await flush();
    client.subscription.emit("error", {
      type: "refresh",
      error: { code: 100, message: "newer refresh failure" },
    });
    unblock();
    await flush();
    expect(await store.trades()).toHaveLength(1);
    expect(await diagnostic()).toMatchObject({
      event: "subscription-error",
      reason: "newer refresh failure",
    });
    expect(await streamError()).toBeTruthy();
  });

  it("ignores intentional shutdown lifecycle events and drains diagnostic persistence before stop resolves", async () => {
    await subscribed();
    const blocked = blockDiagnostic("subscription-error");
    client.subscription.emit("error", {
      type: "refresh",
      error: { code: 100, message: "temporary upstream failure" },
    });
    await flush();
    let stopped = false;
    const closing = collector.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    expect(blocked.writes).toEqual(["subscription-error"]);
    blocked.unblock();
    await closing;
    expect(await diagnostic()).toMatchObject({
      event: "subscription-error",
      code: 100,
      clientState: "connected",
      subscriptionState: "subscribed",
    });
    expect(await streamError()).toBe(
      "Trade connection is temporarily unavailable.",
    );
    const saved = await diagnostic();
    client.subscription.emit("unsubscribed", {
      code: 0,
      reason: "unsubscribe called",
    });
    client.emit("disconnected", { code: 0, reason: "disconnect called" });
    await flush();
    expect(await diagnostic()).toEqual(saved);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an unexpected recovery contract halted and ignores recovered publications", async () => {
    client.state = "connected";
    client.subscription.state = "subscribed";
    client.subscription.emit("subscribed", {
      recoverable: true,
      wasRecovering: true,
    });
    await flush();
    expect(client.subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(await diagnostic()).toMatchObject({
      event: "recovery-rejected",
      subscriptionState: "unsubscribed",
      reason: "Unexpected trade stream recovery contract.",
      lastSubscribedAt: null,
    });
    expect((await streamState()).stream).toBe("disconnected");
    expect(await streamError()).toBe("Trade connection is unavailable.");
    client.subscription.emit("publication", publication());
    await subscribed();
    expect(await store.trades()).toEqual([]);
    expect((await diagnostic()).event).toBe("recovery-rejected");
    expect((await streamState()).stream).toBe("disconnected");
  });
});
