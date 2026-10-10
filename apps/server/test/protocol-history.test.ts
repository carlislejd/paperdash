import { expect, it } from "vitest";
import { createStore } from "../src/store.js";
import { retainProtocolHistory } from "../src/collector.js";

it("retains the historical baseline, upserts corrections, and refuses regressing source replicas", async () => {
  const store = await createStore({ memory: true });
  try {
    const initial = {
      startMs: 1000,
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
      { time: 1000, value: 1 },
      { time: 61000, value: 2 },
    ]);
    await retainProtocolHistory(store, {
      ...initial,
      startMs: 61000,
      columns: { tvl: [3, 4] },
      source: { ...initial.source, revision: "3", asOfMs: 200000 },
    });
    expect(await store.history.protocolPoints()).toEqual([
      { time: 1000, value: 1 },
      { time: 61000, value: 3 },
      { time: 121000, value: 4 },
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
