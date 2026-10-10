import { expect, it, vi } from "vitest";
import { waitForCollectorLease } from "../src/collector-lifecycle.js";

it("keeps a replacement standing by, then starts when the old lease is released", async () => {
  let oldOwner = true;
  let feeds = 0;
  let attempts = 0;
  let observedStandby!: () => void;
  const standby = new Promise<void>((resolve) => {
    observedStandby = resolve;
  });
  const start = vi.fn(async () => {
    if (++attempts === 4) observedStandby();
    if (oldOwner) return false;
    feeds++;
    return true;
  });
  const onWaiting = vi.fn();
  const result = waitForCollectorLease(
    { start },
    new AbortController().signal,
    { onWaiting, intervalMs: 5 },
  );
  await standby;
  expect(feeds).toBe(0);
  expect(start).toHaveBeenCalledTimes(4);
  expect(onWaiting).toHaveBeenCalledTimes(1);
  oldOwner = false;
  expect(await result).toBe(true);
  expect(feeds).toBe(1);
  expect(start).toHaveBeenCalledTimes(5);
});

it("can terminate a standby promptly without another acquisition attempt", async () => {
  const shutdown = new AbortController();
  const start = vi.fn(async () => false);
  const result = waitForCollectorLease({ start }, shutdown.signal, {
    intervalMs: 60000,
    onWaiting: () => shutdown.abort(),
  });
  expect(await result).toBe(false);
  expect(start).toHaveBeenCalledTimes(1);
});

it("waits for an in-flight acquisition before allowing shutdown to release it", async () => {
  const shutdown = new AbortController();
  let finish!: (acquired: boolean) => void;
  const start = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  let settled = false;
  const result = waitForCollectorLease({ start }, shutdown.signal).then(
    (value) => {
      settled = true;
      return value;
    },
  );
  shutdown.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  finish(true);
  expect(await result).toBe(false);
  expect(start).toHaveBeenCalledTimes(1);
});

it("does not disguise database errors as lease contention", async () => {
  const start = vi.fn(async () => {
    throw new Error("Database unavailable");
  });
  await expect(
    waitForCollectorLease({ start }, new AbortController().signal),
  ).rejects.toThrow("Database unavailable");
  expect(start).toHaveBeenCalledTimes(1);
});
