import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HistoryIndexer, type HistoryLoader } from "../src/history.js";
import type {
  HistoryJob,
  HistoryStore,
  JobKind,
} from "../src/history-store.js";
import { LocalCoordinator } from "../src/coordination.js";
import { RequestGate, Upstream, UpstreamError } from "../src/upstream.js";
import type { Store } from "../src/store.js";

const at = 1_800_000_000_000;
const page = { items: [], nextCursor: null };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function job(id: number, kind: JobKind = "cashflows"): HistoryJob {
  return {
    address: `0x${id.toString(16).padStart(40, "0")}`,
    kind,
    token: `lease-${id}-${kind}`,
    priority: 0,
    nextRun: at,
    lockedUntil: at + 120000,
    state: {
      phase: "backfill",
      cursor: null,
      cycle: `cycle-${id}`,
      complete: false,
      pages: 0,
      failures: 0,
      lastSuccessAt: null,
    },
  };
}
function harness(jobs: HistoryJob[]) {
  const available = [...jobs];
  const claimJob = vi.fn<HistoryStore["claimJob"]>(
    async (_now, _lease, _lane, excluded = []) => {
      const index = available.findIndex(
        (candidate) =>
          !excluded.some(
            (busy) =>
              busy.address === candidate.address &&
              busy.kind === candidate.kind,
          ),
      );
      return index < 0 ? null : available.splice(index, 1)[0];
    },
  );
  const commitPage = vi.fn<HistoryStore["commitPage"]>(async () => {});
  const commitPortfolio = vi.fn<HistoryStore["commitPortfolio"]>(
    async () => {},
  );
  const failJob = vi.fn<HistoryStore["failJob"]>(async () => {});
  const store = {
    claimJob,
    commitPage,
    commitPortfolio,
    failJob,
  } as unknown as HistoryStore;
  return { store, claimJob, commitPage, commitPortfolio, failJob };
}
function loadWith(read: (path: string) => Promise<unknown>): HistoryLoader {
  return async (path, schema) => schema.parse(await read(path));
}

describe("bounded history scheduling", () => {
  it("runs at most two distinct jobs per chunk, waits before refill, and prevents overlapping ticks", async () => {
    const h = harness(Array.from({ length: 7 }, (_, i) => job(i + 1)));
    const pending = Array.from({ length: 6 }, () => deferred<typeof page>());
    let active = 0,
      maximum = 0,
      started = 0;
    const loader = vi.fn(async () => {
      const i = started++;
      maximum = Math.max(maximum, ++active);
      try {
        return await pending[i].promise;
      } finally {
        active--;
      }
    });
    const indexer = new HistoryIndexer(h.store, loadWith(loader), () => at);
    const tick = indexer.tick({ maxRequests: 6, sourceConcurrency: 10 });
    try {
      await vi.waitFor(() => expect(started).toBe(2));
      expect(await indexer.tick({ maxRequests: 6 })).toBe(0);
      pending[0].resolve(page);
      await vi.waitFor(() => expect(h.commitPage).toHaveBeenCalledTimes(1));
      expect(started).toBe(2);
      pending[1].resolve(page);
      await vi.waitFor(() => expect(started).toBe(4));
      pending[2].resolve(page);
      pending[3].resolve(page);
      await vi.waitFor(() => expect(started).toBe(6));
    } finally {
      for (const item of pending) item.resolve(page);
    }
    expect(await tick).toBe(6);
    expect(maximum).toBe(2);
    expect(h.claimJob).toHaveBeenCalledTimes(6);
    expect(h.commitPage).toHaveBeenCalledTimes(6);
    expect(h.commitPage.mock.calls.every((args) => args[4]?.adaptive)).toBe(
      true,
    );
    expect(h.claimJob.mock.calls.map((args) => args[2])).toEqual([
      "active-head",
      "backfill",
      "active",
      "retry",
      "active-head",
      "backfill",
    ]);
  });

  it("excludes a primary ledger's correction job until its parallel chunk finishes", async () => {
    const primary = job(1);
    const correction = { ...job(1), correctionId: "head:wallet:cashflows" };
    const other = job(2);
    const h = harness([primary, correction, other]);
    const first = deferred<typeof page>();
    const second = deferred<typeof page>();
    const loader = vi.fn(async (path: string) =>
      path.includes(other.address) ? second.promise : first.promise,
    );
    const indexer = new HistoryIndexer(h.store, loadWith(loader), () => at);
    const tick = indexer.tick();
    try {
      await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
      expect(h.claimJob.mock.calls[1][3]).toEqual([
        { address: primary.address, kind: "cashflows" },
      ]);
      expect(loader.mock.calls.map(([path]) => path.split("/")[3])).toEqual([
        primary.address,
        other.address,
      ]);
    } finally {
      first.resolve(page);
      second.resolve(page);
    }
    expect(await tick).toBe(2);
    expect(await indexer.tick({ maxRequests: 1 })).toBe(1);
    expect(h.commitPage.mock.calls[2][0].correctionId).toBe(
      correction.correctionId,
    );
  });

  it("reserves retry turns across default two-job ticks without spending turns on empty or stopped claims", async () => {
    const h = harness(Array.from({ length: 16 }, (_, i) => job(i + 1)));
    h.claimJob.mockResolvedValueOnce(null);
    const loader = vi.fn(async () => page);
    const indexer = new HistoryIndexer(h.store, loadWith(loader), () => at);
    expect(await indexer.tick({ maxRequests: 1 })).toBe(0);
    for (let i = 0; i < 8; i++) {
      expect(await indexer.tick({ shouldStop: () => true })).toBe(0);
      expect(await indexer.tick()).toBe(2);
      expect(loader).toHaveBeenCalledTimes((i + 1) * 2);
    }
    const pattern = [
      "active-head",
      "backfill",
      "active",
      "retry",
      "active-head",
      "backfill",
      "active",
      "fair",
    ];
    expect(h.claimJob.mock.calls.map((args) => args[2])).toEqual([
      "active-head", // Empty claim keeps the first actual turn available.
      ...pattern,
      ...pattern,
    ]);
    expect(h.commitPage).toHaveBeenCalledTimes(16);
  });

  it("drains its sibling before exposing a failure to persist a job error", async () => {
    const h = harness([job(1), job(2), job(3)]);
    const second = deferred<typeof page>();
    h.commitPage.mockRejectedValueOnce(new Error("Commit failed"));
    h.failJob.mockRejectedValueOnce(new Error("Error checkpoint failed"));
    const loader = vi.fn(async (path: string) =>
      path.includes(job(2).address) ? second.promise : page,
    );
    const indexer = new HistoryIndexer(h.store, loadWith(loader), () => at);
    let settled = false;
    const tick = indexer.tick({ maxRequests: 6 });
    const result = tick
      .then(
        () => null,
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(h.failJob).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    expect(await indexer.tick()).toBe(0);
    second.resolve(page);
    expect(await result).toEqual(new Error("Error checkpoint failed"));
    expect(h.commitPage).toHaveBeenCalledTimes(2);
    expect(h.claimJob).toHaveBeenCalledTimes(2);
    expect(await indexer.tick({ maxRequests: 1 })).toBe(1);
  });

  it("finishes an already claimed job if acquiring its sibling fails", async () => {
    const h = harness([job(1), job(2)]);
    h.claimJob
      .mockResolvedValueOnce(job(1))
      .mockRejectedValueOnce(new Error("Claim failed"));
    const completion = deferred<typeof page>();
    const loader = vi.fn(async () => completion.promise);
    const indexer = new HistoryIndexer(h.store, loadWith(loader), () => at);
    const result = indexer.tick().then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    expect(await indexer.tick()).toBe(0);
    completion.resolve(page);
    expect(await result).toEqual(new Error("Claim failed"));
    expect(h.commitPage).toHaveBeenCalledTimes(1);
  });

  it("checks shutdown before each claim while finishing already claimed work", async () => {
    const h = harness([job(2)]);
    const claimed = deferred<HistoryJob>();
    h.claimJob.mockImplementationOnce(() => claimed.promise);
    let stopping = false;
    const indexer = new HistoryIndexer(
      h.store,
      loadWith(async () => page),
      () => at,
    );
    const tick = indexer.tick({ maxRequests: 6, shouldStop: () => stopping });
    await vi.waitFor(() => expect(h.claimJob).toHaveBeenCalledTimes(1));
    stopping = true;
    claimed.resolve(job(1));
    expect(await tick).toBe(1);
    expect(h.claimJob).toHaveBeenCalledTimes(1);
    expect(h.commitPage).toHaveBeenCalledTimes(1);
    expect(await indexer.tick({ shouldStop: () => stopping })).toBe(0);
  });

  it("stops further claims through a shared429 deadline without abandoning its admitted sibling", async () => {
    const h = harness([job(1), job(2), job(3)]);
    let now = at;
    const second = deferred<typeof page>();
    const loader = vi.fn(async (path: string) => {
      if (path.includes(job(1).address))
        throw new UpstreamError("Shared cooldown", 429, at + 90000);
      return path.includes(job(2).address) ? second.promise : page;
    });
    const indexer = new HistoryIndexer(h.store, loadWith(loader), () => now);
    const tick = indexer.tick({ maxRequests: 6 });
    await vi.waitFor(() => expect(h.failJob).toHaveBeenCalledTimes(1));
    expect(h.failJob.mock.calls[0][3]).toBe(at + 90000);
    second.resolve(page);
    expect(await tick).toBe(2);
    expect(h.commitPage).toHaveBeenCalledTimes(1);
    now += 89999;
    expect(await indexer.tick()).toBe(0);
    expect(h.claimJob).toHaveBeenCalledTimes(2);
    now++;
    expect(await indexer.tick({ maxRequests: 1 })).toBe(1);
  });

  it.each([1, 2])(
    "keeps history serial when total upstream concurrency is %s",
    async (sourceConcurrency) => {
      const h = harness([job(1), job(2)]);
      const first = deferred<typeof page>();
      const loader = vi
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValue(page);
      const indexer = new HistoryIndexer(h.store, loadWith(loader), () => at);
      const tick = indexer.tick({ sourceConcurrency });
      await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
      expect(h.claimJob).toHaveBeenCalledTimes(1);
      first.resolve(page);
      expect(await tick).toBe(2);
    },
  );

  it("leaves an existing source slot available for a foreground read while two history loads wait", async () => {
    const h = harness([job(1), job(2)]);
    const pending = deferred<Response>();
    let activeHistory = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/foreground"))
        return Response.json({ value: 1 });
      activeHistory++;
      await pending.promise;
      activeHistory--;
      return Response.json(page);
    });
    const upstream = new Upstream(
      {} as Store,
      fetcher as typeof fetch,
      "https://test.invalid",
      new RequestGate(3, 0),
      new LocalCoordinator(),
    );
    const indexer = new HistoryIndexer(
      h.store,
      (path, schema) => upstream.request(path, schema),
      () => at,
    );
    const tick = indexer.tick({ sourceConcurrency: 3 });
    try {
      await vi.waitFor(() => expect(activeHistory).toBe(2));
      expect(
        await upstream.request("/foreground", z.object({ value: z.number() })),
      ).toEqual({ value: 1 });
      expect(activeHistory).toBe(2);
    } finally {
      pending.resolve(Response.json(page));
      await tick;
      await upstream.close();
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
