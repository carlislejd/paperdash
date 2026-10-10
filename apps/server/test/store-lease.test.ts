import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pool = vi.hoisted(() => ({
  on: vi.fn(),
  query: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
}));
vi.mock("pg", async (importOriginal) => ({
  ...(await importOriginal<typeof import("pg")>()),
  Pool: vi.fn(function () {
    return pool;
  }),
}));

import { createStore, type Store } from "../src/store.js";

class LeaseClient extends EventEmitter {
  query = vi.fn(async () => ({ rows: [{ acquired: true }] }));
  release = vi.fn();
}
let store: Store | undefined;
let client: LeaseClient;
beforeEach(async () => {
  vi.clearAllMocks();
  client = new LeaseClient();
  pool.query.mockResolvedValue({
    rows: [{ available: true, valid: true, expected: true }],
  });
  pool.connect.mockResolvedValue(client);
  pool.end.mockResolvedValue(undefined);
  store = await createStore({
    databaseUrl: "postgres://lease.test/fixture",
    autoMigrate: false,
  });
});
afterEach(async () => {
  await store?.close();
  store = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PostgreSQL collector lease ownership", () => {
  it("destroys the checked-out session when acquisition fails and permits pool shutdown", async () => {
    const failure = new Error("Acquisition query timed out");
    client.query.mockRejectedValueOnce(failure);
    await expect(store!.lease()).rejects.toBe(failure);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.listenerCount("error")).toBe(0);
    await store!.close();
    store = undefined;
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("returns a contended client to the pool without installing a fatal listener", async () => {
    client.query.mockResolvedValueOnce({ rows: [{ acquired: false }] });
    expect(await store!.lease()).toBeNull();
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
    expect(client.listenerCount("error")).toBe(0);
  });

  it("exits immediately with failure when the held lease connection is lost", async () => {
    await store!.lease();
    const fatal = new Error("intercepted process exit");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw fatal;
    });
    const kill = vi.spyOn(process, "kill");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      client.emit("error", new Error("connection terminated")),
    ).toThrow(fatal);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(kill).not.toHaveBeenCalled();
    expect(client.release).not.toHaveBeenCalled();
  });

  it("fail-stops if the held lease silently stops answering its heartbeat", async () => {
    vi.useFakeTimers();
    await store!.lease();
    client.query.mockImplementation(() => new Promise(() => {}));
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(19999);
    expect(client.query).toHaveBeenCalledTimes(2); // acquisition plus one heartbeat
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(client.release).not.toHaveBeenCalled(); // never graceful-drain uncertain ownership
    await vi.advanceTimersByTimeAsync(60000);
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("removes the fatal listener before normal release and releases only once", async () => {
    const release = await store!.lease();
    expect(client.listenerCount("error")).toBe(1);
    client.release.mockImplementation(() => {
      expect(client.listenerCount("error")).toBe(0);
    });
    await release!();
    await release!();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    await store!.close();
    store = undefined;
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("removes the fatal listener before store close destroys the held session", async () => {
    const release = await store!.lease();
    client.release.mockImplementation(() => {
      expect(client.listenerCount("error")).toBe(0);
    });
    await store!.close();
    store = undefined;
    await release!();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });
});
