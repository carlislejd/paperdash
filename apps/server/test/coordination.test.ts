import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createStore, type Store } from "../src/store.js";
import {
  LocalCoordinator,
  RedisCoordinator,
  SharedCooldownError,
  type RequestCoordinator,
} from "../src/coordination.js";
import { RequestGate, Upstream, UpstreamError } from "../src/upstream.js";
import { buildApi } from "../src/api.js";
import { ChangeBus } from "../src/bus.js";

const stores: Store[] = [];
const clients: Upstream[] = [];
const coordinators: RequestCoordinator[] = [];
async function store() {
  const value = await createStore({ memory: true });
  stores.push(value);
  return value;
}
function upstream(
  s: Store,
  coordinator: RequestCoordinator,
  fetcher: typeof fetch = fetch,
) {
  const value = new Upstream(
    s,
    fetcher,
    "https://test.invalid",
    new RequestGate(3, 0),
    coordinator,
  );
  clients.push(value);
  return value;
}
afterEach(async () => {
  for (const value of clients.splice(0)) await value.close();
  for (const value of coordinators.splice(0)) value.close();
  for (const value of stores.splice(0)) await value.close();
  vi.restoreAllMocks();
});

describe("shared cache and request admission", () => {
  it("preserves the retry deadline supplied by another instance", async () => {
    const s = await store();
    const api = upstream(s, new LocalCoordinator());
    const until = Date.now() + 90000;
    await expect(
      api.cached("blocked", 1000, async () => {
        throw new UpstreamError("Shared cooldown", 429, until);
      }),
    ).rejects.toMatchObject({ retryAt: until });
    expect(
      (await s.get<{ until: number }>("cache-error:blocked"))!.value.until,
    ).toBe(until);
  });

  it("keeps a newer persisted account when an upstream replica regresses", async () => {
    const s = await store();
    const address = "0x1111111111111111111111111111111111111111";
    const current = {
      address,
      indexedThroughBlock: 100,
      indexedThroughTimestamp: 1000,
      accountRevision: 10,
      balance: "20",
      queued: "0",
      locked: "0",
      paper: { balance: "0", staked: "0" },
      lifetime: {
        depositedRaw: "20",
        withdrawnRaw: "0",
        realizedPnlRaw: "0",
        feesPaidRaw: "0",
        tradedNotionalRaw: "0",
        paperRewardsClaimedRaw: "0",
      },
      openPositions: [],
    };
    const at = Date.now() - 60000;
    await s.put(`cache:wallet:${address}`, current, at);
    const older = { ...current, accountRevision: 9, balance: "10" };
    const fetcher = vi.fn(
      async () =>
        new Response(`event: wallet\ndata: ${JSON.stringify(older)}\n\n`),
    );
    const api = upstream(s, new LocalCoordinator(), fetcher as typeof fetch);
    expect((await api.snapshot(address)).value.balance).toBe("20");
    await api.close();
    expect((await s.get(`cache:wallet:${address}`))?.receivedAt).toBe(at);
    expect(
      (await s.get<{ message: string }>(`cache-error:wallet:${address}`))!.value
        .message,
    ).toContain("older account revision");
  });

  it("coalesces across Upstream instances and reads a newer database cache", async () => {
    const s = await store();
    const coordinator = new LocalCoordinator();
    const first = upstream(s, coordinator);
    const second = upstream(s, coordinator);
    let resolve!: (v: string) => void;
    const loader = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    );
    const a = first.cached("wallet", 1000, loader);
    const b = second.cached("wallet", 1000, loader);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    resolve("saved once");
    expect((await a).value).toBe("saved once");
    expect((await b).value).toBe("saved once");
    await s.put("cache:wallet", "refreshed elsewhere", Date.now() + 1);
    expect((await first.cached("wallet", 1000, loader)).value).toBe(
      "refreshed elsewhere",
    );
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("shares failed-load backoff so another instance does not retry immediately", async () => {
    const s = await store();
    const coordinator = new LocalCoordinator();
    const first = upstream(s, coordinator);
    const second = upstream(s, coordinator);
    const loader = vi.fn(async () => {
      throw new Error("Source unavailable");
    });
    await expect(first.cached("down", 1000, loader)).rejects.toThrow(
      "Source unavailable",
    );
    await expect(second.cached("down", 1000, loader)).rejects.toThrow(
      "Source unavailable",
    );
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("reacquires the shared request budget for every HTTP retry", async () => {
    const coordinator = new LocalCoordinator();
    const acquire = vi.spyOn(coordinator, "acquire");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 500 }))
      .mockResolvedValueOnce(Response.json({ value: 2 }));
    const api = upstream(await store(), coordinator, fetcher as typeof fetch);
    expect(await api.request("/test", z.object({ value: z.number() }))).toEqual(
      { value: 2 },
    );
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("stops requests on all instances after one receives Retry-After", async () => {
    const s = await store();
    const coordinator = new LocalCoordinator();
    const limited = vi.fn(
      async () =>
        new Response("{}", { status: 429, headers: { "Retry-After": "90" } }),
    );
    const untouched = vi.fn(async () => Response.json({ value: 1 }));
    const a = upstream(s, coordinator, limited as typeof fetch);
    const b = upstream(s, coordinator, untouched as typeof fetch);
    const schema = z.object({ value: z.number() });
    await expect(a.request("/test", schema)).rejects.toMatchObject({
      status: 429,
    });
    await expect(b.request("/test", schema)).rejects.toMatchObject({
      status: 429,
    });
    expect(untouched).not.toHaveBeenCalled();
  });

  it("serves retained history without calling a source endpoint", async () => {
    const s = await store();
    const fetcher = vi.fn(async () => {
      throw new Error("History reads must be local");
    });
    const api = upstream(s, new LocalCoordinator(), fetcher as typeof fetch);
    const page = await api.history(
      "0x1111111111111111111111111111111111111111",
      "cashflows",
    );
    expect(page.value.items).toEqual([]);
    expect(page.value.coverage?.indexing).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects malformed local history cursors without contacting the source", async () => {
    const s = await store();
    const fetcher = vi.fn(async () => Response.json({}));
    const api = upstream(s, new LocalCoordinator(), fetcher as typeof fetch);
    const bus = new ChangeBus();
    const app = await buildApi(s, api, bus, { logger: false });
    try {
      const response = await app.inject({
        url: "/api/wallets/0x1111111111111111111111111111111111111111/cashflows?cursor=not-a-local-cursor",
      });
      expect(response.statusCode).toBe(400);
      expect(fetcher).not.toHaveBeenCalled();
      const indexing = await app.inject({ url: "/api/indexing" });
      expect(indexing.json()).toMatchObject({ indexing: null, stale: true });
    } finally {
      await app.close();
      bus.close();
    }
  });

  it("expires queued work instead of performing it after the caller has waited too long", async () => {
    const gate = new RequestGate(1, 0, 2, 50);
    let release!: () => void;
    const first = gate.run(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    const obsolete = vi.fn(async () => 1);
    await expect(gate.run(obsolete)).rejects.toMatchObject({ status: 503 });
    release();
    await first;
    expect(obsolete).not.toHaveBeenCalled();
  });
});

// CI runs these against real Redis, not a mock Lua interpreter. Separate client
// connections exercise the same coordination used by independent API replicas.
describe.skipIf(!process.env.TEST_REDIS_URL)(
  "Redis coordination integration",
  () => {
    function pair(options = { concurrency: 1, spacing: 100, wait: 1000 }) {
      const namespace = `test:${randomUUID()}`;
      const a = new RedisCoordinator(
        process.env.TEST_REDIS_URL!,
        namespace,
        options,
      );
      const b = new RedisCoordinator(
        process.env.TEST_REDIS_URL!,
        namespace,
        options,
      );
      coordinators.push(a, b);
      return [a, b] as const;
    }
    it("enforces concurrency and start spacing between independent clients", async () => {
      const [a, b] = pair();
      const started = Date.now();
      const releaseA = await a.acquire();
      let admitted = false;
      const waiting = b.acquire().then((release) => {
        admitted = true;
        return release;
      });
      await new Promise((r) => setTimeout(r, 120));
      expect(admitted).toBe(false);
      await releaseA();
      const releaseB = await waiting;
      expect(Date.now() - started).toBeGreaterThanOrEqual(100);
      await releaseB();
      const at = Date.now();
      const releaseC = await a.acquire();
      expect(Date.now() - at).toBeGreaterThanOrEqual(80);
      await releaseC();
    });
    it("shares cooldown and cache lease ownership", async () => {
      const [a, b] = pair();
      const lease = await a.lock("wallet");
      expect(lease).not.toBeNull();
      expect(await b.lock("wallet")).toBeNull();
      await lease!.assertOwned();
      await lease!.release();
      const next = await b.lock("wallet");
      expect(next).not.toBeNull();
      await expect(lease!.assertOwned()).rejects.toThrow("expired");
      await next!.release();
      await a.defer(60000);
      await expect(b.acquire()).rejects.toBeInstanceOf(SharedCooldownError);
    });
    it("fails closed when Redis is unavailable", async () => {
      const [a] = pair();
      const release = await a.acquire();
      await release();
      a.close();
      await expect(a.acquire()).rejects.toThrow("fetching is paused");
      await expect(a.lock("wallet")).rejects.toThrow("fetching is paused");
    });
    it("coalesces an actual cache refresh across two Redis clients", async () => {
      const [a, b] = pair();
      const s = await store();
      const first = upstream(s, a);
      const second = upstream(s, b);
      const loader = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 150));
        return "one refresh";
      });
      const result = await Promise.all([
        first.cached("same", 1000, loader),
        second.cached("same", 1000, loader),
      ]);
      expect(result.map((r) => r.value)).toEqual([
        "one refresh",
        "one refresh",
      ]);
      expect(loader).toHaveBeenCalledTimes(1);
    });
  },
);
