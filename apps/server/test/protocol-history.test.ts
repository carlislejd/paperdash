import { expect, it, vi } from "vitest";
import { createStore } from "../src/store.js";
import { retainProtocolHistory } from "../src/collector.js";

it("retains the historical baseline, upserts corrections, and refuses regressing source replicas", async () => {
  const store = await createStore({ memory: true });
  try {
    const initial = {
      startMs: 0,
      intervalMs: 60000,
      source: { asOfMs: 100000, revision: "2", generation: "a" },
      columns: { tvl: [1, 2] },
    };
    await retainProtocolHistory(store, initial);
    await expect(
      retainProtocolHistory(store, {
        ...initial,
        columns: { tvl: [9, 9] },
        source: { ...initial.source, revision: "1", asOfMs: 200000 },
      }),
    ).rejects.toThrow("moved backward");
    expect(await store.history.protocolPoints()).toEqual([
      { time: 0, value: 1 },
      { time: 60000, value: 2 },
    ]);
    await retainProtocolHistory(store, {
      ...initial,
      startMs: 60000,
      columns: { tvl: [3, 4] },
      source: { ...initial.source, revision: "3", asOfMs: 200000 },
    });
    expect(await store.history.protocolPoints()).toEqual([
      { time: 0, value: 1 },
      { time: 60000, value: 3 },
      { time: 120000, value: 4 },
    ]);
    await expect(
      retainProtocolHistory(store, {
        ...initial,
        source: { asOfMs: 50000, revision: "1", generation: "b" },
      }),
    ).rejects.toThrow("moved backward");
  } finally {
    await store.close();
  }
});

it("compares revisions within their interval while retaining the global source-clock guard and minute TVL", async () => {
  const store = await createStore({ memory: true, databaseUrl: "" });
  try {
    const minute = {
      startMs: 60000,
      intervalMs: 60000,
      source: { asOfMs: 7200000, revision: "100", generation: "a" },
      columns: { tvl: [1, 2] },
    };
    await retainProtocolHistory(store, minute);
    const read = vi.spyOn(store, "get");
    const hourly = {
      startMs: 0,
      intervalMs: 3600000,
      source: { asOfMs: 10800000, revision: "1", generation: "a" },
      columns: { tvl: [3, 4, 5] },
    };
    await retainProtocolHistory(store, hourly);
    expect(read.mock.calls).toEqual([["protocol-history"]]);
    expect((await store.get("protocol-history"))?.value).toMatchObject({
      intervalMs: 3600000,
    });
    expect(await store.history.protocolPoints()).toEqual([
      { time: 0, value: 3 },
      { time: 60000, value: 1 },
      { time: 120000, value: 2 },
      { time: 3600000, value: 4 },
      { time: 7200000, value: 5 },
    ]);
    await expect(
      retainProtocolHistory(store, {
        ...hourly,
        source: { ...hourly.source, asOfMs: 10800001, revision: "0" },
      }),
    ).rejects.toThrow("moved backward");
    await expect(
      retainProtocolHistory(store, {
        ...minute,
        source: { ...minute.source, asOfMs: 10800000 - 1, revision: "1000" },
      }),
    ).rejects.toThrow("moved backward");
    expect((await store.get("protocol-history"))?.value).toMatchObject({
      source: hourly.source,
    });
  } finally {
    vi.restoreAllMocks();
    await store.close();
  }
});

it("recovers a legacy interval only from a matching raw publication", async () => {
  const source = { asOfMs: 7200000, revision: "100", generation: "a" };
  for (const variant of [
    "matching-minute",
    "matching-hour",
    "mismatched",
    "missing",
  ] as const) {
    const store = await createStore({ memory: true, databaseUrl: "" });
    try {
      await store.put("protocol-history", { points: [], source });
      if (variant !== "missing")
        await store.put("protocol-history-raw", {
          startMs: 0,
          intervalMs: variant === "matching-minute" ? 60000 : 3600000,
          source:
            variant === "mismatched"
              ? { ...source, asOfMs: source.asOfMs - 1 }
              : source,
          columns: { tvl: [] },
        });
      const incoming = {
        startMs: 0,
        intervalMs: 3600000,
        source: { ...source, asOfMs: 10800000, revision: "1" },
        columns: { tvl: [1, 2, 3] },
      };
      if (variant === "matching-hour")
        await expect(retainProtocolHistory(store, incoming)).rejects.toThrow(
          "moved backward",
        );
      else {
        await retainProtocolHistory(store, incoming);
        expect((await store.get("protocol-history"))?.value).toMatchObject({
          intervalMs: 3600000,
          source: incoming.source,
        });
      }
    } finally {
      await store.close();
    }
  }
});
