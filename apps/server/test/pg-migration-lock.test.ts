import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquirePgIndexMigrationLock,
  acquirePgMigrationLock,
} from "../src/pg-migration-lock.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("concurrent index migration admission", () => {
  it("admits a whole owner migration on key zero and never admits the collector key", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ acquired: true }] });
    await acquirePgMigrationLock({ query } as never, 1000, 0);
    expect(query.mock.calls[0][0].text).toBe(
      "SELECT pg_try_advisory_lock(74481231, 0) AS acquired",
    );
    await expect(
      acquirePgMigrationLock({ query } as never, 1000, 1 as never),
    ).rejects.toThrow("Invalid migration lock key");
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("ends each unsuccessful nonblocking statement before delaying and never opens a transaction", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ acquired: false }] })
      .mockResolvedValueOnce({ rows: [{ acquired: false }] })
      .mockResolvedValueOnce({ rows: [{ acquired: true }] });
    const pending = acquirePgIndexMigrationLock({ query } as never, 1000);
    await vi.advanceTimersByTimeAsync(99);
    expect(query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(101);
    await pending;
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.map((call) => call[0].text)).toEqual(
      Array(3).fill("SELECT pg_try_advisory_lock(74481231, 2) AS acquired"),
    );
    expect(query.mock.calls.map((call) => call[0].query_timeout)).toEqual([
      1000, 900, 800,
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses one absolute deadline and leaves no timer or background query after timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const query = vi.fn().mockResolvedValue({ rows: [{ acquired: false }] });
    const pending = acquirePgIndexMigrationLock({ query } as never, 250);
    const outcome = expect(pending).rejects.toThrow("Timed out waiting");
    await vi.advanceTimersByTimeAsync(250);
    await outcome;
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.map((call) => call[0].query_timeout)).toEqual([
      250, 150, 50,
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(query).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates query failures without retrying an unknown admission outcome", async () => {
    const query = vi.fn().mockRejectedValue(new Error("connection lost"));
    await expect(
      acquirePgIndexMigrationLock({ query } as never),
    ).rejects.toThrow("connection lost");
    expect(query).toHaveBeenCalledTimes(1);
  });
});
