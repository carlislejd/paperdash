import { describe, expect, it } from "vitest";
import { economicFingerprint } from "../src/analytics-store.js";
import { normalizeTrade } from "../src/schemas.js";

// Shape and USD units verified in a public:trades publication on 2026-10-10.
const observed = {
  seq: 48175329000031,
  ts: 1791642242000,
  wallet: "0xa56b038e765056e30d26d738497ba78fdf8df4e8",
  instrument: "ETH",
  instrumentId: 1,
  instrumentTerminal: false,
  side: "short",
  leverage: 1000,
  notionalUsd: 10000000,
  intentId: null,
  positionId: 1903,
  kind: "close",
  pnlUsd: -800.56,
};
const legacyFingerprint =
  "85bd9c4c5300ecde972c6a09b5d2c6f3a5aae8af34d0168ece1d47ba78594120";
const legacyId = "recent:48175329000031:85bd9c4c5300ecde";

describe("independent market execution-price contract", () => {
  it("keeps the verified close price in USD without scaling and preserves legacy identity", () => {
    const base = normalizeTrade(observed, "public-stream");
    const priced = normalizeTrade(
      { ...observed, entry: null, exit: 2498.45 },
      "public-stream",
    );
    expect(priced).toEqual({ ...base, priceUsd: 2498.45 });
    expect(priced.id).toBe(legacyId);
    expect(economicFingerprint(priced)).toBe(legacyFingerprint);
    expect(economicFingerprint(base)).toBe(legacyFingerprint);
  });

  it.each(["open", "close", "liq"] as const)(
    "selects the execution-side price for %s even when both prices exist",
    (kind) => {
      const trade = normalizeTrade(
        { ...observed, kind, pnlUsd: kind === "open" ? null : 4, entry: 82785.5, exit: 82787.5 },
        "public-stream",
      );
      expect(trade.priceUsd).toBe(kind === "open" ? 82785.5 : 82787.5);
      expect(trade.kind).toBe(kind);
      expect(trade.notionalUsd).toBe(10000000);
    },
  );

  it.each(["open", "close", "liq"] as const)(
    "never substitutes the opposite price or supplied priceUsd for a missing %s price",
    (kind) => {
      const opposite = kind === "open" ? { exit: 2498.45 } : { entry: 2498.45 };
      const missing = normalizeTrade(
        { ...observed, kind, pnlUsd: kind === "open" ? null : 4, ...opposite, priceUsd: 99999 },
        "public-stream",
      );
      expect(missing.priceUsd == null).toBe(true);
      const selected = kind === "open" ? "entry" : "exit";
      const explicitNull = normalizeTrade(
        { ...observed, kind, pnlUsd: kind === "open" ? null : 4, ...opposite, [selected]: null },
        "public-stream",
      );
      expect(explicitNull.priceUsd).toBeNull();
    },
  );

  it("retains valid executions when selected price metadata is malformed", () => {
    const invalid = [0, -1, NaN, Infinity, -Infinity, "2498.45", "", {}, [], true];
    for (const kind of ["open", "close", "liq"] as const) {
      const baseInput = { ...observed, kind, pnlUsd: kind === "open" ? null : 4 };
      const base = normalizeTrade(baseInput, "public-stream");
      for (const value of invalid) {
        const selected = kind === "open" ? "entry" : "exit";
        const opposite = kind === "open" ? "exit" : "entry";
        const result = normalizeTrade(
          { ...baseInput, [selected]: value, [opposite]: 2498.45 },
          "public-stream",
        );
        expect(result).toMatchObject(base);
        expect(result.priceUsd == null).toBe(true);
        expect(economicFingerprint(result)).toBe(economicFingerprint(base));
      }
    }
  });

  it("retains the usable price when only irrelevant opposite-side metadata is malformed", () => {
    expect(normalizeTrade({ ...observed, entry: {}, exit: 2498.45 }, "public-stream").priceUsd).toBe(2498.45);
    expect(normalizeTrade({ ...observed, kind: "open", pnlUsd: null, entry: 2498.45, exit: "bad" }, "public-stream").priceUsd).toBe(2498.45);
  });

  it("keeps IDs and fingerprints stable across price corrections and REST/WS representation differences", () => {
    for (const exit of [undefined, null, 2498.45, 2499.5, "malformed"]) {
      const stream = normalizeTrade({ ...observed, exit }, "public-stream");
      const recent = normalizeTrade(
        { ...observed, seq: String(observed.seq), positionId: String(observed.positionId), exit },
        "recent-api",
      );
      expect(stream.id).toBe(legacyId);
      expect(recent.id).toBe(legacyId);
      expect(economicFingerprint(stream)).toBe(legacyFingerprint);
      expect(economicFingerprint(recent)).toBe(legacyFingerprint);
    }
  });

  it("preserves distinct unsequenced observations while price enrichment leaves each observation stable", () => {
    const base = { ...observed, seq: undefined };
    const first = normalizeTrade(base, "public-stream", "observation-one");
    const enriched = normalizeTrade({ ...base, exit: 2498.45 }, "public-stream", "observation-one");
    const second = normalizeTrade({ ...base, exit: 2498.45 }, "public-stream", "observation-two");
    expect(first.id).toBe("stream:observation-one");
    expect(enriched.id).toBe(first.id);
    expect(second.id).toBe("stream:observation-two");
    expect(economicFingerprint(enriched)).toBe(economicFingerprint(first));
    expect(economicFingerprint(second)).toBe(economicFingerprint(first));
  });
});
