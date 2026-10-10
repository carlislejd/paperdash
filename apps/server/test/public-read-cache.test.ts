import { describe, expect, it, vi } from "vitest";
import {
  PublicReadCache,
  ReadCapacityError,
} from "../src/public-read-cache.js";

const options = { ttl: 1000, maxEntries: 3, maxBytes: 1024, maxPending: 2 };
describe("bounded public read cache", () => {
  it("coalesces simultaneous viewers and re-evaluates freshness after one second", async () => {
    let now = 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const cache = new PublicReadCache(options);
    const loader = vi.fn(async () => ({ receivedAt: 900, stale: now > 1500 }));
    try {
      const results = await Promise.all(
        Array.from({ length: 1000 }, () => cache.read("overview", loader)),
      );
      expect(loader).toHaveBeenCalledTimes(1);
      expect(results.every((value) => value === results[0])).toBe(true);
      now = 1999;
      expect((await cache.read("overview", loader)).stale).toBe(false);
      now = 2001;
      expect(await cache.read("overview", loader)).toEqual({
        receivedAt: 900,
        stale: true,
      });
      expect(loader).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });
  it("bounds distinct work while allowing same-key joins and existing cache hits", async () => {
    const cache = new PublicReadCache(options);
    await cache.read("saved", async () => "saved");
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const first = cache.read("one", () => pending);
    const second = cache.read("two", () => pending);
    const join = cache.read("one", async () => "wrong");
    await expect(
      cache.read("three", async () => "wrong"),
    ).rejects.toBeInstanceOf(ReadCapacityError);
    expect(await cache.read("saved", async () => "wrong")).toBe("saved");
    release("finished");
    expect(await Promise.all([first, second, join])).toEqual([
      "finished",
      "finished",
      "finished",
    ]);
    expect(cache.pendingCount).toBe(0);
  });
  it("evicts LRU entries by byte and entry bounds without caching failures", async () => {
    const cache = new PublicReadCache({ ...options, maxBytes: 15 });
    const loader = vi.fn(async () => "12345");
    await cache.read("a", loader);
    await cache.read("b", loader);
    await cache.read("a", loader);
    await cache.read("c", loader);
    expect(cache.size).toBe(2);
    await cache.read("b", loader);
    expect(loader).toHaveBeenCalledTimes(4);
    await expect(
      cache.read("broken", async () => {
        throw new Error("DB down");
      }),
    ).rejects.toThrow("DB down");
    expect(cache.pendingCount).toBe(0);
    expect(await cache.read("broken", async () => "ok")).toBe("ok");
    await cache.read("large", async () => "x".repeat(100));
    expect(cache.size).toBeLessThanOrEqual(2);
  });
});
