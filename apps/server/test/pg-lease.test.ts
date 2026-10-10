import { EventEmitter } from "node:events";
import type { PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { monitorPgLease } from "../src/pg-lease.js";

afterEach(() => vi.useRealTimers());
class Lease extends EventEmitter {
  query = vi.fn(() => Promise.resolve({ rows: [{ "?column?": 1 }] }));
}

describe("held PostgreSQL lease heartbeat", () => {
  it("bounds a silent lease loss without queuing overlapping heartbeats", async () => {
    vi.useFakeTimers();
    const client = new Lease();
    client.query.mockImplementation(() => new Promise(() => {}));
    const lost = vi.fn();
    const stop = monitorPgLease(client as unknown as PoolClient, lost);
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.query).toHaveBeenCalledExactlyOnceWith("SELECT 1");
    await vi.advanceTimersByTimeAsync(14999);
    expect(lost).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(lost).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "Collector lease heartbeat deadline exceeded.",
      }),
    );
    await vi.advanceTimersByTimeAsync(60000);
    client.emit("error", new Error("late socket error"));
    client.emit("end");
    expect(lost).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledTimes(1);
    stop();
  });

  it("ignores an in-flight heartbeat rejection after intentional lease release", async () => {
    vi.useFakeTimers();
    const client = new Lease();
    let reject!: (error: Error) => void;
    client.query.mockImplementation(
      () =>
        new Promise((_resolve, rejectQuery) => {
          reject = rejectQuery;
        }),
    );
    const lost = vi.fn();
    const stop = monitorPgLease(client as unknown as PoolClient, lost);
    await vi.advanceTimersByTimeAsync(5000);
    stop();
    reject(new Error("Connection terminated"));
    await vi.advanceTimersByTimeAsync(60000);
    expect(lost).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.listenerCount("error")).toBe(0);
    expect(client.listenerCount("end")).toBe(0);
  });

  it("keeps healthy sessions checked and reports query or session failure once", async () => {
    vi.useFakeTimers();
    const client = new Lease();
    const lost = vi.fn();
    const stop = monitorPgLease(client as unknown as PoolClient, lost);
    await vi.advanceTimersByTimeAsync(10000);
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(lost).not.toHaveBeenCalled();
    client.query.mockRejectedValueOnce(new Error("query failed"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(lost).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "query failed" }),
    );
    client.emit("end");
    expect(lost).toHaveBeenCalledTimes(1);
    stop();
  });

  it("treats an unexpected session end as immediate lease loss", () => {
    vi.useFakeTimers();
    const client = new Lease();
    const lost = vi.fn();
    const stop = monitorPgLease(client as unknown as PoolClient, lost);
    client.emit("end");
    expect(lost).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "Collector lease session ended." }),
    );
    stop();
  });
});
