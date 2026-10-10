import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Outcome = { ok: true } | { ok: false; error: unknown };
let acquire: ReturnType<typeof deferred<boolean>>;
let stop: ReturnType<typeof deferred<void>>;
let upstreamClose: ReturnType<typeof deferred<void>>;
let storeClose: ReturnType<typeof deferred<void>>;
let imported: Promise<Outcome> | undefined;
let signals: Map<string, () => void>;
let calls: string[];
let mocks: {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  upstreamClose: ReturnType<typeof vi.fn>;
  busClose: ReturnType<typeof vi.fn>;
  storeClose: ReturnType<typeof vi.fn>;
};
let exit: ReturnType<typeof vi.spyOn<typeof process, "exit">>;

beforeEach(() => {
  vi.resetModules();
  acquire = deferred<boolean>();
  stop = deferred<void>();
  upstreamClose = deferred<void>();
  storeClose = deferred<void>();
  imported = undefined;
  calls = [];
  signals = new Map();
  mocks = {
    start: vi.fn(() => {
      calls.push("start");
      return acquire.promise;
    }),
    stop: vi.fn(() => {
      calls.push("stop");
      return stop.promise;
    }),
    upstreamClose: vi.fn(() => {
      calls.push("upstream.close");
      return upstreamClose.promise;
    }),
    busClose: vi.fn(() => {
      calls.push("bus.close");
    }),
    storeClose: vi.fn(() => {
      calls.push("store.close");
      return storeClose.promise;
    }),
  };
  vi.doMock("../src/config.js", () => ({ config: { redisUrl: undefined } }));
  vi.doMock("../src/store.js", () => ({
    createStore: vi.fn(async () => ({
      kind: "local",
      close: mocks.storeClose,
    })),
  }));
  vi.doMock("../src/collector.js", () => ({
    Collector: class {
      start = mocks.start;
      stop = mocks.stop;
    },
  }));
  vi.doMock("../src/upstream.js", () => ({
    Upstream: class {
      close = mocks.upstreamClose;
    },
  }));
  vi.doMock("../src/bus.js", () => ({
    ChangeBus: class {
      close = mocks.busClose;
    },
  }));
  const originalOnce = process.on.bind(process);
  vi.spyOn(process, "on").mockImplementation(((
    event: string,
    listener: () => void,
  ) => {
    if (event === "SIGTERM" || event === "SIGINT") {
      signals.set(event, listener);
      return process;
    }
    return originalOnce(event, listener);
  }) as typeof process.on);
  exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as typeof process.exit);
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(async () => {
  // Finish every mocked gate before restoring process.exit, including when an
  // assertion failed mid-cleanup. No real signal handlers are ever installed.
  acquire.resolve(true);
  stop.resolve(undefined);
  upstreamClose.resolve(undefined);
  storeClose.resolve(undefined);
  signals.get("SIGTERM")?.();
  if (imported) {
    await imported;
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  }
  vi.restoreAllMocks();
  for (const path of ["config", "store", "collector", "upstream", "bus"])
    vi.doUnmock(`../src/${path}.js`);
});

async function boot() {
  // Attach the rejection handler when importing: the worker intentionally
  // rethrows startup failures only after its cleanup has finished.
  imported = import("../src/worker.js").then<Outcome, Outcome>(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  );
  await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
}
async function finishCleanup() {
  stop.resolve(undefined);
  await vi.waitFor(() => expect(mocks.upstreamClose).toHaveBeenCalledTimes(1));
  expect(mocks.storeClose).not.toHaveBeenCalled();
  expect(exit).not.toHaveBeenCalled();
  upstreamClose.resolve(undefined);
  await vi.waitFor(() => expect(mocks.storeClose).toHaveBeenCalledTimes(1));
  expect(mocks.busClose).toHaveBeenCalledTimes(1);
  expect(exit).not.toHaveBeenCalled();
  storeClose.resolve(undefined);
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  expect(calls).toEqual([
    "start",
    "stop",
    "upstream.close",
    "bus.close",
    "store.close",
  ]);
}

describe("worker module shutdown sequencing", () => {
  it("waits for pending lease acquisition before SIGTERM cleanup starts", async () => {
    await boot();
    signals.get("SIGTERM")!();
    await Promise.resolve();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    acquire.resolve(true);
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledTimes(1));
    expect(mocks.upstreamClose).not.toHaveBeenCalled();
    await finishCleanup();
    expect(await imported).toEqual({ ok: true });
  });

  it("shares the same pending cleanup when SIGINT follows SIGTERM", async () => {
    await boot();
    acquire.resolve(true);
    expect(await imported).toEqual({ ok: true });
    signals.get("SIGTERM")!();
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledTimes(1));
    signals.get("SIGTERM")!();
    signals.get("SIGINT")!();
    await Promise.resolve();
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    await finishCleanup();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.upstreamClose).toHaveBeenCalledTimes(1);
    expect(mocks.storeClose).toHaveBeenCalledTimes(1);
  });

  it("finishes cleanup before rejecting startup even when a shutdown signal races the rejection", async () => {
    await boot();
    let importSettled = false;
    void imported!.then(() => {
      importSettled = true;
    });
    signals.get("SIGTERM")!();
    const failure = new Error("database lease acquisition failed");
    acquire.reject(failure);
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledTimes(1));
    signals.get("SIGTERM")!();
    signals.get("SIGINT")!();
    await Promise.resolve();
    expect(importSettled).toBe(false);
    expect(exit).not.toHaveBeenCalled();
    await finishCleanup();
    expect(await imported).toEqual({ ok: false, error: failure });
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.storeClose).toHaveBeenCalledTimes(1);
  });
});
