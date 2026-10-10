import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventHub, type StreamTopic } from "../src/event-hub.js";
import { ChangeBus } from "../src/bus.js";
import { emptyOverview } from "../src/collector.js";
import type { Store, StreamRecord } from "../src/store.js";

class Response extends EventEmitter {
  writableLength = 0;
  destroyed = false;
  chunks: string[] = [];
  write(text: string) {
    this.chunks.push(text);
    return true;
  }
  end() {
    this.destroyed = true;
    this.emit("close");
  }
  destroy() {
    this.end();
  }
  messages() {
    return this.chunks.flatMap((text) =>
      text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6))),
    );
  }
  ids() {
    return this.chunks.flatMap((text) =>
      text
        .split("\n")
        .filter((line) => line.startsWith("id: "))
        .map((line) => line.slice(4)),
    );
  }
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.restoreAllMocks();
});
function fixture(bootstrapTtl = 1000) {
  const records: StreamRecord[] = [];
  let eventCursor = "0";
  const store = {
    kind: "local",
    get: vi.fn(async () => ({
      value: { ...emptyOverview("local"), eventCursor },
      receivedAt: Date.now(),
    })),
    eventBounds: vi.fn(async () => ({
      oldest: records[0]?.id ?? null,
      latest: records.at(-1)?.id ?? null,
    })),
    events: vi.fn(async (after: string) =>
      records.filter((r) => BigInt(r.id) > BigInt(after)).slice(0, 1000),
    ),
  } as unknown as Store;
  const bus = new ChangeBus();
  const hub = new EventHub(store, bus, {
    bootstrapTtl,
    maxBufferedBytes: 64 * 1024,
  });
  cleanups.push(() => {
    hub.close();
    bus.close();
  });
  const add = async (topics?: StreamTopic[]) => {
    const response = new Response();
    await hub.add(
      response as unknown as ServerResponse,
      "999999999",
      topics ? new Set(topics) : undefined,
    );
    return response;
  };
  return {
    records,
    store,
    bus,
    hub,
    add,
    setCursor: (value: string) => {
      eventCursor = value;
    },
  };
}
function trade(
  id: string,
  instrument = 0,
  kind: "open" | "liq" = "open",
): StreamRecord {
  return {
    id,
    message: {
      type: "trade",
      data: {
        id: `trade:${id}`,
        digest: id,
        ts: Date.now(),
        wallet: `0x${"1".repeat(40)}`,
        instrument,
        symbol: instrument ? "ETH" : "BTC",
        side: "long",
        kind,
        leverage: 1000,
        notionalUsd: 10000000000,
        pnlUsd: null,
        provenance: "public-stream",
      },
    },
  };
}
describe("shared SSE fanout", () => {
  it("declares retention that advances during the initial snapshot replay", async () => {
    const { records, store, bus, add, setCursor } = fixture();
    records.push(trade("100"));
    setCursor("100");
    const original = store.events;
    vi.spyOn(store, "events").mockImplementationOnce(async (after) => {
      records.splice(0, records.length, trade("500"), trade("501"));
      return original(after);
    });
    const response = await add();
    expect(response.ids()).toEqual(["499", "500", "501"]);
    expect(response.messages()[0].data.status.message).toMatch(
      /replay expired/i,
    );
    records.push(trade("502"));
    bus.notify();
    await vi.waitFor(() => expect(response.ids()).toContain("502"));
    expect(response.ids()).toEqual(["499", "500", "501", "502"]);
    expect(response.destroyed).toBe(false);
  });
  it("signals a replay gap when retention advances between bounds and the tail read", async () => {
    const { records, store, bus, add, setCursor } = fixture();
    records.push(trade("100"));
    setCursor("100");
    const response = await add();
    const original = store.events;
    vi.spyOn(store, "events").mockImplementationOnce(async (after) => {
      records.splice(0, records.length, trade("500"), trade("501"));
      return original(after);
    });
    bus.notify();
    await vi.waitFor(() => expect(response.destroyed).toBe(true));
    expect(response.ids()).toEqual(["100"]);
    expect(response.messages().at(-1)).toMatchObject({
      type: "status",
      data: { stale: true, stream: "disconnected" },
    });
    expect(response.messages().at(-1).data.message).toMatch(/replay expired/i);
  });
  it("allows an allocated sequence hole when the retained prefix has not expired", async () => {
    const { records, bus, add, setCursor } = fixture();
    records.push(trade("100"));
    setCursor("100");
    const response = await add();
    records.push(trade("102"));
    bus.notify();
    await vi.waitFor(() => expect(response.ids()).toContain("102"));
    expect(response.ids()).toEqual(["100", "102"]);
    expect(response.destroyed).toBe(false);
    expect(
      response.messages().filter((message) => message.type === "status"),
    ).toEqual([]);
  });
  it("starts a cold hub at the saved watermark without resending its already-delivered bootstrap", async () => {
    const { records, bus, add, setCursor } = fixture();
    records.push(trade("100"), trade("101"), trade("102"));
    setCursor("100");
    const response = await add();
    expect(response.ids()).toEqual(["100", "101", "102"]);
    records.push(trade("103"));
    bus.notify();
    await vi.waitFor(() => expect(response.ids()).toContain("103"));
    expect(response.ids()).toEqual(["100", "101", "102", "103"]);
    expect(
      response.messages().filter((message) => message.type === "overview"),
    ).toHaveLength(1);
  });
  it("does not reset a fresh client after an idle hub's retained log has advanced", async () => {
    const { records, bus, add, setCursor } = fixture(0);
    records.push(trade("100"), trade("101"));
    setCursor("100");
    const old = await add();
    old.end();
    records.splice(0, records.length, trade("500"), trade("501"), trade("502"));
    setCursor("501");
    const fresh = await add(["overview", "trades"]);
    records.push(trade("503"));
    bus.notify();
    await vi.waitFor(() => expect(fresh.ids()).toContain("503"));
    expect(fresh.ids()).toEqual(["501", "502", "503"]);
    expect(fresh.destroyed).toBe(false);
  });
  it("closes only clients with an actual expired replay gap and keeps caught-up clients ordered", async () => {
    const { records, bus, add, setCursor } = fixture(0);
    records.push(trade("100"), trade("101"));
    setCursor("100");
    const lagging = await add();
    records.splice(0, records.length, trade("500"), trade("501"), trade("502"));
    setCursor("501");
    const fresh = await add();
    bus.notify();
    await vi.waitFor(() => expect(lagging.destroyed).toBe(true));
    expect(lagging.ids()).toEqual(["100", "101"]);
    expect(lagging.messages().at(-1)).toMatchObject({
      type: "status",
      data: { stale: true, stream: "disconnected" },
    });
    expect(lagging.messages().at(-1).data.message).toMatch(/replay expired/i);
    const reconnected = await add();
    records.push(trade("503"));
    bus.notify();
    await vi.waitFor(() => expect(reconnected.ids()).toContain("503"));
    expect(fresh.destroyed).toBe(false);
    expect(fresh.ids()).toEqual(["501", "502", "503"]);
    expect(reconnected.ids()).toEqual(["501", "502", "503"]);
  });
  it("shares cold initialization with a tail requested while the first snapshot is pending", async () => {
    const { store, records, bus, add, setCursor } = fixture();
    records.push(trade("100"), trade("101"));
    setCursor("100");
    let release!: () => void;
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = store.get;
    vi.spyOn(store, "get").mockImplementation(async (...args) => {
      const result = await original(...args);
      await pause;
      return result;
    });
    const joining = add();
    bus.notify();
    release();
    const response = await joining;
    records.push(trade("102"));
    bus.notify();
    await vi.waitFor(() => expect(response.ids()).toContain("102"));
    expect(response.ids()).toEqual(["100", "101", "102"]);
    expect(store.get).toHaveBeenCalledTimes(1);
  });
  it("bootstraps 2000 viewers with one snapshot read and one replay read", async () => {
    const { store, hub, add } = fixture();
    const clients = await Promise.all(
      Array.from({ length: 2000 }, () => add()),
    );
    expect(hub.size).toBe(2000);
    expect(store.get).toHaveBeenCalledTimes(1);
    expect(store.eventBounds).toHaveBeenCalledTimes(1);
    expect(store.events).toHaveBeenCalledTimes(1);
    expect(clients.every((c) => c.messages()[0].type === "overview")).toBe(
      true,
    );
  });
  it("encodes publications once, filters topics, and closes slow viewers without blocking healthy ones", async () => {
    const { records, bus, add } = fixture();
    const all = await add();
    const overview = await add(["overview"]);
    const btc = await add(["asset:0"]);
    const liqs = await add(["liquidations"]);
    const slow = await add();
    slow.writableLength = 65 * 1024;
    const record = trade("1");
    const encode = vi.fn(() => 10000000000);
    Object.defineProperty(record.message.data, "notionalUsd", {
      enumerable: true,
      get: encode,
    });
    records.push(record, trade("2", 1), trade("3", 0, "liq"));
    bus.notify();
    await vi.waitFor(() =>
      expect(all.messages().filter((m) => m.type === "trade")).toHaveLength(3),
    );
    expect(encode).toHaveBeenCalledTimes(1);
    expect(overview.messages().filter((m) => m.type === "trade")).toHaveLength(
      0,
    );
    expect(
      btc
        .messages()
        .filter((m) => m.type === "trade")
        .map((m) => m.data.id),
    ).toEqual(["trade:1", "trade:3"]);
    expect(
      liqs
        .messages()
        .filter((m) => m.type === "trade")
        .map((m) => m.data.id),
    ).toEqual(["trade:3"]);
    expect(slow.destroyed).toBe(true);
    bus.notify();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(all.messages().filter((m) => m.type === "trade")).toHaveLength(3);
  });
  it("shares the reconnect snapshot and catches events arriving while bootstrap is pending", async () => {
    const { store, records, bus, add } = fixture();
    let release!: () => void;
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = store.get;
    vi.spyOn(store, "get").mockImplementation(async (...args) => {
      const value = await original(...args);
      await pause;
      return value;
    });
    const joins = Array.from({ length: 100 }, () => add());
    records.push(trade("1"));
    bus.notify();
    release();
    const responses = await Promise.all(joins);
    records.push(trade("2"));
    bus.notify();
    await vi.waitFor(() =>
      expect(
        responses[0].messages().filter((m) => m.type === "trade"),
      ).toHaveLength(2),
    );
    expect(
      responses.every(
        (r) =>
          r
            .messages()
            .filter((m) => m.type === "trade")
            .map((m) => m.data.id)
            .join() === "trade:1,trade:2",
      ),
    ).toBe(true);
  });
  it("does not write a delayed bootstrap after intentional shutdown", async () => {
    const { store, hub, add } = fixture();
    let release!: () => void;
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = store.get;
    vi.spyOn(store, "get").mockImplementation(async (...args) => {
      await pause;
      return original(...args);
    });
    const joining = add();
    hub.close();
    release();
    const response = await joining;
    expect(response.destroyed).toBe(true);
    expect(response.chunks).toEqual([]);
    expect(hub.size).toBe(0);
  });
  it("retries a failed database tail and never duplicates already delivered events", async () => {
    const { store, records, bus, add } = fixture();
    const response = await add();
    const original = store.events;
    vi.spyOn(store, "events")
      .mockRejectedValueOnce(new Error("temporary DB outage"))
      .mockImplementation(original);
    records.push(trade("1"));
    bus.notify();
    await new Promise((resolve) => setTimeout(resolve, 5));
    bus.notify();
    await vi.waitFor(() =>
      expect(
        response.messages().filter((m) => m.type === "trade"),
      ).toHaveLength(1),
    );
    bus.notify();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(response.messages().filter((m) => m.type === "trade")).toHaveLength(
      1,
    );
  });
});
