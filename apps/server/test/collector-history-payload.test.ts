import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Collector, protocolHistoryDigest } from "../src/collector.js";
import { createStore, type Store } from "../src/store.js";
import { Upstream } from "../src/upstream.js";
import { ChangeBus } from "../src/bus.js";
import type {
  Overview,
  ProtocolSummary,
} from "../../../packages/shared/src/types.js";

const minute = 1_800_000_000_000;
function summary(value: number, at = minute): ProtocolSummary {
  return {
    ok: true,
    source: { at, block: String(at) },
    balances: {
      tvl: String(BigInt(value) * 10n ** 18n),
      margin: "0",
      lp: "0",
      reserve: "0",
      queue: "0",
    },
    activity: { volume: "0", open: 0 },
    fees: { pending: "0", lifetime: "0" },
    paper: { supply: "0", staked: "0" },
  };
}
let store: Store;
let upstream: Upstream;
let bus: ChangeBus;
let collector: Collector;
beforeEach(async () => {
  store = await createStore({ memory: true, databaseUrl: "" });
  upstream = new Upstream(store);
  bus = new ChangeBus();
  collector = new Collector(store, upstream, bus);
});
afterEach(async () => {
  await collector.stop();
  await upstream.close();
  bus.close();
  await store.close();
  vi.restoreAllMocks();
});
// Exercise the actual persistence/publication boundary without starting any
// source sockets, timers or HTTP requests.
async function publish() {
  await collector["publish"]();
}
async function observe(value: number, at = minute) {
  await store.put("summary", summary(value, at));
  await store.sample(Math.floor(at / 60000) * 60000, value);
  await publish();
}
async function messages(type: string) {
  return (await store.events("0")).filter(
    (event) => event.message.type === type,
  );
}

describe("live TVL history payload suppression", () => {
  it("holds publication until a new summary and its active-minute sample are coherent", async () => {
    vi.spyOn(Date, "now").mockReturnValue(minute + 10000);
    await observe(100);
    const originalSample = store.sample.bind(store);
    let entered!: () => void;
    const writingSample = new Promise<void>((resolve) => (entered = resolve));
    let resume!: () => void;
    const pausedSample = new Promise<void>((resolve) => (resume = resolve));
    vi.spyOn(store, "sample").mockImplementationOnce(async (time, value) => {
      entered();
      await pausedSample;
      await originalSample(time, value);
    });
    const samplesRead = vi.spyOn(store, "samples");
    const update = collector["retainSummary"](summary(120, minute + 2000));
    await writingSample;
    expect(
      (await store.get<ProtocolSummary>("summary"))!.value.balances.tvl,
    ).toBe(String(120n * 10n ** 18n));
    const publication = publish();
    try {
      // Yield while the publication is queued, without depending on a timer.
      expect(await messages("history")).toHaveLength(1);
      expect(samplesRead).not.toHaveBeenCalled();
    } finally {
      resume();
      await Promise.all([update, publication]);
    }
    expect(await messages("history")).toHaveLength(1);
    expect(await messages("metrics")).toHaveLength(2);
    const saved = (await store.get<Overview>("overview"))!.value;
    expect(saved.summary!.balances.tvl).toBe(String(120n * 10n ** 18n));
    expect(saved.history.at(-1)).toEqual({ time: minute, value: 120 });
  });
  it("rejects regressing summaries and allows recovery after a failed sample write", async () => {
    vi.spyOn(Date, "now").mockReturnValue(minute + 10000);
    await observe(100);
    await expect(
      collector["retainSummary"](summary(90, minute - 1)),
    ).rejects.toThrow("moved backward");
    expect((await store.samples()).at(-1)?.value).toBe(100);
    vi.spyOn(store, "sample").mockRejectedValueOnce(
      new Error("Sample write failed"),
    );
    await expect(
      collector["retainSummary"](summary(120, minute + 1000)),
    ).rejects.toThrow("Sample write failed");
    // Genuine failed persistence remains significant; the chain is not wedged
    // and the existing mismatch digest still sends the retained history.
    await publish();
    expect(await messages("history")).toHaveLength(2);
    await collector["retainSummary"](summary(130, minute + 2000));
    await publish();
    expect(
      (await store.get<Overview>("overview"))!.value.history.at(-1),
    ).toEqual({
      time: minute,
      value: 130,
    });
  });
  it("retains the latest minute sample and full snapshot while sending metrics rather than duplicate 300-point histories", async () => {
    for (let i = 299; i > 0; i--)
      await store.sample(minute - i * 60000, 1000 + i);
    for (let i = 0; i < 10; i++) await observe(2000 + i, minute + i * 2000);
    expect(await messages("metrics")).toHaveLength(10);
    const histories = await messages("history");
    expect(histories).toHaveLength(1);
    const saved = (await store.get<Overview>("overview"))!.value;
    expect(saved.history).toHaveLength(300);
    expect(saved.history.at(-1)).toEqual({ time: minute, value: 2009 });
    expect((await store.samples()).at(-1)).toEqual({
      time: minute,
      value: 2009,
    });
    expect(saved.history[0]).toEqual({
      time: minute - 299 * 60000,
      value: 1299,
    });
  });
  it("suppresses only the active endpoint of downsampled full-day history", async () => {
    await store.history.retainProtocol(
      Array.from({ length: 1440 }, (_, i) => ({
        time: minute - (1439 - i) * 60000,
        value: 1000 + i,
      })),
    );
    await observe(2500);
    const initial = (await store.get<Overview>("overview"))!.value;
    expect(initial.history).toHaveLength(300);
    await observe(2600, minute + 2000);
    expect(await messages("history")).toHaveLength(1);
    const updated = (await store.get<Overview>("overview"))!.value;
    expect(updated.history.slice(0, -1)).toEqual(initial.history.slice(0, -1));
    expect(updated.history.at(-1)).toEqual({ time: minute, value: 2600 });
    const corrected = { time: minute - 700 * 60000, value: 1 };
    await store.history.retainProtocol([corrected]);
    await publish();
    expect(await messages("history")).toHaveLength(2);
    expect(
      (await store.get<Overview>("overview"))!.value.history,
    ).toContainEqual(corrected);
    await observe(2700, minute + 60000);
    expect(await messages("history")).toHaveLength(3);
    expect(
      (await store.get<Overview>("overview"))!.value.history.at(-1),
    ).toEqual({ time: minute + 60000, value: 2700 });
  });
  it("immediately sends full history on minute transitions, historical corrections and coverage changes", async () => {
    await store.sample(minute - 60000, 90);
    await observe(100);
    await observe(110, minute + 60000);
    expect(await messages("history")).toHaveLength(2);
    await store.sample(minute, 95);
    await publish();
    expect(await messages("history")).toHaveLength(3);
    await store.history.retainProtocol([{ time: minute - 60000, value: 90 }]);
    await publish();
    expect(await messages("history")).toHaveLength(4);
    expect((await store.get<Overview>("overview"))!.value.historyCoverage).toBe(
      "upstream",
    );
  });
  it("keeps old, future and mismatching tail changes significant", () => {
    const before = {
      history: [{ time: minute, value: 100 }],
      historyCoverage: "observed" as const,
    };
    const after = { ...before, history: [{ time: minute, value: 101 }] };
    expect(protocolHistoryDigest(before, summary(100))).toBe(
      protocolHistoryDigest(after, summary(101)),
    );
    for (const source of [
      summary(999),
      summary(100, minute - 60000),
      summary(100, minute + 60000),
    ])
      expect(protocolHistoryDigest(before, source)).not.toBe(
        protocolHistoryDigest(after, source),
      );
    expect(protocolHistoryDigest(before, summary(100))).not.toBe(
      protocolHistoryDigest(
        { ...before, historyCoverage: "upstream" },
        summary(100),
      ),
    );
    expect(protocolHistoryDigest(before, summary(100))).not.toBe(
      protocolHistoryDigest(
        { ...before, history: [{ time: minute - 1, value: 100 }] },
        summary(100),
      ),
    );
    expect(protocolHistoryDigest(before, summary(100))).toBe(
      protocolHistoryDigest(
        { ...before, history: [{ time: minute, value: 0 }] },
        summary(0),
      ),
    );
  });
  it("uses the complete history digest for missing or malformed summary data", () => {
    const before = {
      history: [{ time: minute, value: 100 }],
      historyCoverage: "observed" as const,
    };
    const after = { ...before, history: [{ time: minute, value: 101 }] };
    for (const invalid of [
      null,
      {},
      { ...summary(100), ok: false },
      { ...summary(100), source: { at: NaN, block: "1" } },
      { ...summary(100), balances: { tvl: "invalid" } },
    ])
      expect(
        protocolHistoryDigest(before, invalid as ProtocolSummary | null),
      ).not.toBe(
        protocolHistoryDigest(after, invalid as ProtocolSummary | null),
      );
  });
});
