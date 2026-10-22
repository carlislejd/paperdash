import { describe, expect, it } from "vitest";
import { savedActivityDelayed, savedActivityHealth } from "../src/activity-health.js";

const now = 1_800_000_000_000;
const gapHeartbeat = (gapAt: number) => ({
  at: now,
  errors: { "trade-ingestion-gap": "retained gap" },
  tradeIntake: { gap: { at: gapAt, kind: "malformed" }, error: null },
});

describe("current activity delay and retained gap evidence", () => {
  it("keeps a new or recurring malformed publication delayed with an otherwise healthy connection", () => {
    for (const gapAt of [now, now - 30000, now + 1, NaN, -1]) {
      expect(savedActivityHealth(gapHeartbeat(gapAt), "connected", now)).toEqual({
        delayed: true, historyGap: true,
      });
    }
    const heartbeat = gapHeartbeat(now - 30001);
    expect(savedActivityHealth(heartbeat, "connected", now)).toEqual({ delayed: false, historyGap: true });
    // The legacy boolean remains conservative for every existing consumer.
    expect(savedActivityDelayed(heartbeat, "connected", now)).toBe(true);
    expect(savedActivityHealth({ at: now, errors: heartbeat.errors }, "connected", now).delayed).toBe(true);
  });

  it("does not mark paused, retrying, invalid-clock or missing collectors current", () => {
    const heartbeat = gapHeartbeat(now - 60000);
    for (const state of [{ admissionPaused: true }, { retrying: true }, { error: "pending projection" }]) {
      expect(savedActivityHealth({ ...heartbeat, tradeIntake: { ...heartbeat.tradeIntake, ...state } }, "connected", now).delayed).toBe(true);
    }
    for (const at of [NaN, -1, now - 30001, now + 30001])
      expect(savedActivityHealth({ at, errors: {} }, "connected", now).delayed).toBe(true);
    expect(savedActivityHealth(null, "connected", now).delayed).toBe(true);
    expect(savedActivityHealth({ at: now }, "disconnected", now).delayed).toBe(true);
  });
});
