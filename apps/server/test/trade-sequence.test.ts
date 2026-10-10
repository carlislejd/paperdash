import { describe, expect, it } from "vitest";
import { normalizeTrade } from "../src/schemas.js";

const source = {
  ts: 1791605504000,
  wallet: `0x${"1".repeat(40)}`,
  instrument: "BTC",
  side: "long",
  leverage: 50,
  notionalUsd: 1000,
  kind: "open",
  pnlUsd: null,
};

describe.each(["public-stream", "recent-api"] as const)(
  "%s trade sequence compatibility",
  (provenance) => {
    it.each([0, 1, Number.MAX_SAFE_INTEGER])(
      "normalizes exact numeric sequence %s to the existing string identity",
      (seq) => {
        const numeric = normalizeTrade({ ...source, seq }, provenance);
        const string = normalizeTrade(
          { ...source, seq: String(seq) },
          provenance,
        );
        expect(numeric).toEqual(string);
        expect(numeric.id).toMatch(new RegExp(`^recent:${seq}:`));
        expect(numeric.provenance).toBe(provenance);
        expect(
          normalizeTrade(
            { ...source, seq: String(BigInt(seq) + 1n) },
            provenance,
          ).id,
        ).not.toBe(numeric.id);
      },
    );

    it("retains exact large string sequences without narrowing them to numbers", () => {
      const seq = "9".repeat(78);
      expect(normalizeTrade({ ...source, seq }, provenance).id).toMatch(
        new RegExp(`^recent:${seq}:`),
      );
      expect(() =>
        normalizeTrade({ ...source, seq: `${seq}9` }, provenance),
      ).toThrow();
    });

    it.each([
      Number.MAX_SAFE_INTEGER + 1,
      Number.MIN_SAFE_INTEGER,
      -1,
      1.5,
      NaN,
      Infinity,
      -Infinity,
      null,
      true,
      false,
      {},
      [],
      "",
      "01",
      "-1",
      "1.5",
      "1e3",
      " 1",
      "1 ",
    ])("rejects noncanonical or inexact sequence %j", (seq) => {
      expect(() => normalizeTrade({ ...source, seq }, provenance)).toThrow();
    });
  },
);

it("preserves stream arrival identity without a sequence and still requires recent sequence IDs", () => {
  expect(normalizeTrade(source, "public-stream", "arrival-1").id).toBe(
    "stream:arrival-1",
  );
  expect(normalizeTrade(source, "public-stream", "arrival-2").id).toBe(
    "stream:arrival-2",
  );
  expect(() => normalizeTrade(source, "recent-api")).toThrow("sequence ID");
});
