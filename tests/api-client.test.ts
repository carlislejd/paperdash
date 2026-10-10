import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchJson } from "../apps/web/src/lib/api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("browser API client", () => {
  it("preserves Headers instances and adds JSON negotiation", async () => {
    const request = vi.fn(async (_path: string, options: RequestInit) => {
      const headers = new Headers(options.headers);
      expect(headers.get("X-Request-Id")).toBe("test");
      expect(headers.get("Accept")).toBe("application/json");
      return new Response('{"ok":true}', { status: 200 });
    });
    vi.stubGlobal("fetch", request);
    await expect(
      fetchJson("/api/overview", {
        headers: new Headers({ "X-Request-Id": "test" }),
      }),
    ).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retains rate-limit status and Retry-After without automatic retries", async () => {
    const request = vi.fn(
      async () =>
        new Response('{"message":"Please wait"}', {
          status: 429,
          headers: { "Retry-After": "30" },
        }),
    );
    vi.stubGlobal("fetch", request);
    await expect(fetchJson("/api/accounts")).rejects.toMatchObject({
      name: "ApiError",
      status: 429,
      retryAfterMs: 30_000,
      message: "Please wait",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("provides readable errors for broken JSON and offline requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("<html>unavailable</html>", { status: 200 }),
      ),
    );
    await expect(fetchJson("/api/overview")).rejects.toThrow(
      "unreadable response",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(fetchJson("/api/overview")).rejects.toBeInstanceOf(ApiError);
    await expect(fetchJson("/api/overview")).rejects.toThrow(
      "Check your connection",
    );
  });

  it("cancels stalled requests and preserves caller cancellation", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_path: string, options: RequestInit) =>
          new Promise((_, reject) => {
            const signal = options.signal!;
            if (signal.aborted) reject(signal.reason);
            else
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
          }),
      ),
    );
    const timedOut = expect(fetchJson("/api/wallets/example")).rejects.toThrow(
      "timed out",
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await timedOut;
    const controller = new AbortController();
    const aborted = expect(
      fetchJson("/api/wallets/example", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await aborted;
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("honors busy cooldown without repeating the request, while unrelated cached panels remain available", async () => {
  vi.useFakeTimers();
  const request = vi.fn(async (path: string) =>
    path.endsWith("/api/busy-fixture")
      ? new Response('{"error":"Refresh is busy"}', {
          status: 503,
          headers: { "Retry-After": "60" },
        })
      : new Response('{"ok":true}'),
  );
  vi.stubGlobal("fetch", request);
  await expect(fetchJson("/api/busy-fixture")).rejects.toMatchObject({
    status: 503,
    retryAfterMs: 60000,
    message: "Refresh is busy",
  });
  await expect(fetchJson("/api/busy-fixture")).rejects.toMatchObject({
    status: 503,
    retryAfterMs: expect.any(Number),
  });
  expect(request).toHaveBeenCalledTimes(1);
  await expect(fetchJson("/api/unrelated-fixture")).resolves.toEqual({
    ok: true,
  });
  expect(request).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(70000);
  await expect(fetchJson("/api/busy-fixture")).rejects.toMatchObject({
    status: 503,
  });
  expect(request).toHaveBeenCalledTimes(3);
});
