import { afterEach, expect, it, vi } from "vitest";
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of ["config", "store", "collector", "upstream", "bus", "api"])
    vi.doUnmock(`../src/${path}.js`);
});
it.each([true, false])(
  "waits for one complete API cleanup across repeated signals (startup pending=%s)",
  async (duringStartup) => {
    vi.resetModules();
    const start = deferred<boolean>(),
      appClose = deferred<void>(),
      upstreamClose = deferred<void>(),
      storeClose = deferred<void>();
    const signals = new Map<string, () => void>(),
      calls: string[] = [];
    const listen = vi.fn(async () => {
      calls.push("listen");
    });
    const mocks = {
      start: vi.fn(() => {
        calls.push("start");
        return start.promise;
      }),
      appClose: vi.fn(() => {
        calls.push("app.close");
        return appClose.promise;
      }),
      stop: vi.fn(async () => {
        calls.push("collector.stop");
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
    vi.doMock("../src/config.js", () => ({
      config: { embedded: true, host: "127.0.0.1", port: 0 },
    }));
    vi.doMock("../src/store.js", () => ({
      createStore: async () => ({ close: mocks.storeClose }),
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
    vi.doMock("../src/api.js", () => ({
      buildApi: async () => ({
        close: mocks.appClose,
        listen,
        log: { warn: vi.fn() },
      }),
    }));
    const once = process.on.bind(process);
    vi.spyOn(process, "on").mockImplementation(((
      event: string,
      fn: () => void,
    ) => {
      if (event === "SIGTERM" || event === "SIGINT") {
        signals.set(event, fn);
        return process;
      }
      return once(event, fn);
    }) as typeof process.on);
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as typeof process.exit);
    const imported = import("../src/index.js").then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
    try {
      await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
      if (!duringStartup) {
        start.resolve(true);
        expect(await imported).toEqual({ ok: true });
      }
      signals.get("SIGTERM")!();
      signals.get("SIGTERM")!();
      signals.get("SIGINT")!();
      if (duringStartup) {
        await Promise.resolve();
        expect(mocks.appClose).not.toHaveBeenCalled();
        start.resolve(true);
      }
      await vi.waitFor(() => expect(mocks.appClose).toHaveBeenCalledTimes(1));
      expect(exit).not.toHaveBeenCalled();
      expect(mocks.stop).not.toHaveBeenCalled();
      appClose.resolve(undefined);
      await vi.waitFor(() =>
        expect(mocks.upstreamClose).toHaveBeenCalledTimes(1),
      );
      expect(mocks.stop).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();
      upstreamClose.resolve(undefined);
      await vi.waitFor(() => expect(mocks.storeClose).toHaveBeenCalledTimes(1));
      expect(exit).not.toHaveBeenCalled();
      storeClose.resolve(undefined);
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
      expect(await imported).toEqual({ ok: true });
      expect(listen).toHaveBeenCalledTimes(duringStartup ? 0 : 1);
      expect(calls.slice(-5)).toEqual([
        "app.close",
        "collector.stop",
        "upstream.close",
        "bus.close",
        "store.close",
      ]);
    } finally {
      start.resolve(true);
      appClose.resolve(undefined);
      upstreamClose.resolve(undefined);
      storeClose.resolve(undefined);
      signals.get("SIGTERM")?.();
      await imported;
      await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    }
  },
);
