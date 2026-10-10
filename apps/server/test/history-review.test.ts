import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "../src/store.js";
import type { HistoryJob, JobStatus } from "../src/history-store.js";

const address = "0x1111111111111111111111111111111111111111";
const stores: Store[] = [];
let now: number;

beforeEach(() => {
  now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  vi.restoreAllMocks();
});

async function memory() {
  const store = await createStore({ memory: true, databaseUrl: "" });
  stores.push(store);
  return store;
}

// Hold unrelated jobs under long leases to isolate the public scheduling API.
// No test edits the underlying database or manufactures checkpoint state.
async function take(
  store: Store,
  matches: (job: HistoryJob) => boolean,
  lane: "active" | "fair" = "fair",
): Promise<HistoryJob | null> {
  for (let i = 0; i < 20; i++) {
    const job = await store.history.claimJob(now, 86_400_000, lane);
    if (!job || matches(job)) return job;
  }
  throw new Error("Unexpected number of unrelated history jobs");
}

async function mainCashflows(store: Store) {
  const job = await take(
    store,
    (job) => job.kind === "cashflows" && !job.correctionId,
  );
  expect(job).not.toBeNull();
  return job!;
}

async function mainStatus(store: Store): Promise<JobStatus> {
  const status = (await store.history.getStatus(address)).find(
    (job) => job.kind === "cashflows",
  );
  expect(status).toBeDefined();
  return status!;
}

function deposit(timestampMs: number) {
  return {
    timestampMs,
    txHash: `0x${timestampMs.toString(16).padStart(64, "0")}`,
    amountRaw: "1000000000000000000",
    kind: "Deposit",
    recipientAmountRaw: null,
    route: "hyperevm",
    withdrawalStatus: null,
  };
}

describe("independent durable history regressions", () => {
  it("updates an older pending page without collapsing copies or moving its backfill checkpoint", async () => {
    const store = await memory();
    await store.history.ensureWallet(address);
    const pending = {
      ...deposit(1000),
      kind: "Withdrawal",
      withdrawalStatus: "in_transit",
    };

    await store.history.commitPage(
      await mainCashflows(store),
      {
        items: [pending, { ...pending }],
        nextCursor: "older-page",
      },
      now,
      60_000,
    );
    now += 1001;
    await store.history.commitPage(
      await mainCashflows(store),
      {
        items: [{ ...pending }],
        nextCursor: "unread-tail",
      },
      now,
      60_000,
    );
    const before = await mainStatus(store);
    const original = await store.history.readPage<{
      id: string;
      withdrawalStatus: string;
    }>(address, "cashflows");
    expect(original.items).toHaveLength(3);
    expect(new Set(original.items.map((item) => item.id)).size).toBe(3);

    now += 300_001;
    const correction = await take(
      store,
      (job) =>
        job.state.purpose === "pending" && job.state.cursor === "older-page",
    );
    expect(correction).not.toBeNull();
    await store.history.commitPage(
      correction!,
      {
        items: [
          {
            ...pending,
            withdrawalStatus: "settled",
            recipientAmountRaw: pending.amountRaw,
          },
        ],
        nextCursor: "unread-tail",
      },
      now,
      60_000,
    );

    const retained = await store.history.readPage<{
      id: string;
      withdrawalStatus: string;
    }>(address, "cashflows");
    expect(retained.items.map((item) => item.id).sort()).toEqual(
      original.items.map((item) => item.id).sort(),
    );
    expect(
      retained.items.filter((item) => item.withdrawalStatus === "settled"),
    ).toHaveLength(1);
    expect(
      retained.items.filter((item) => item.withdrawalStatus === "in_transit"),
    ).toHaveLength(2);
    expect((await mainStatus(store)).state).toEqual(before.state);
    expect((await mainStatus(store)).nextRun).toBe(before.nextRun);
  });

  it("restarts incremental head passes while retaining the unfinished deep-backfill cursor", async () => {
    const store = await memory();
    await store.history.ensureWallet(address, 10);
    await store.history.commitPage(
      await mainCashflows(store),
      {
        items: [deposit(100)],
        nextCursor: "older-one",
      },
      now,
      60_000,
    );
    now += 1001;
    await store.history.commitPage(
      await mainCashflows(store),
      {
        items: [deposit(90)],
        nextCursor: "older-two",
      },
      now,
      60_000,
    );
    const before = await mainStatus(store);

    now += 60_001;
    const firstHead = await take(
      store,
      (job) => job.kind === "cashflows" && job.state.purpose === "head",
    );
    expect(firstHead?.state.cursor).toBeNull();
    await store.history.commitPage(
      firstHead!,
      {
        items: [deposit(110)],
        nextCursor: "incremental-next",
      },
      now,
      60_000,
    );
    expect((await mainStatus(store)).state).toEqual(before.state);

    now += 1001;
    const nextHead = await take(
      store,
      (job) => job.kind === "cashflows" && job.state.purpose === "head",
    );
    expect(nextHead?.state.cursor).toBe("incremental-next");
    await store.history.commitPage(
      nextHead!,
      {
        items: [deposit(100), deposit(90)],
        nextCursor: "source-older-cursor",
      },
      now,
      60_000,
    );
    expect((await mainStatus(store)).state).toEqual(before.state);
    expect((await mainStatus(store)).state.cursor).toBe("older-two");
    expect(
      (await store.history.readPage(address, "cashflows")).items,
    ).toHaveLength(3);

    now += 60_001;
    const restarted = await take(
      store,
      (job) => job.kind === "cashflows" && job.state.purpose === "head",
    );
    expect(restarted?.state.cursor).toBeNull();
    expect((await mainStatus(store)).state).toEqual(before.state);
  });

  it("promotes a cold wallet's independent head refresh when a visitor opens it", async () => {
    const store = await memory();
    await store.history.ensureWallet(address);
    await store.history.commitPage(
      await mainCashflows(store),
      {
        items: [deposit(100)],
        nextCursor: "large-unread-backfill",
      },
      now,
      6 * 3_600_000,
    );
    now += 60_001;
    await store.history.ensureWallet(address, 10);

    const head = await take(
      store,
      (job) => job.kind === "cashflows" && job.state.purpose === "head",
      "active",
    );
    expect(head).not.toBeNull();
    expect(head?.state.cursor).toBeNull();
    expect((await mainStatus(store)).state.cursor).toBe(
      "large-unread-backfill",
    );
  });

  it("keeps an unresolved pending target visible after cursor rejection or a changed page", async () => {
    const store = await memory();
    await store.history.ensureWallet(address);
    await store.history.commitPage(await mainCashflows(store), {
      items: [deposit(2000)], nextCursor: "pending-page",
    }, now, 60_000);
    now += 1001;
    const pending = { ...deposit(1000), kind: "Withdrawal", withdrawalStatus: "in_transit" };
    await store.history.commitPage(await mainCashflows(store), {
      items: [pending], nextCursor: null,
    }, now, 60_000);
    const before = (await mainStatus(store)).state;

    now += 300_001;
    const rejected = await take(store, (job) => job.state.purpose === "pending");
    expect(rejected?.state.cursor).toBe("pending-page");
    await store.history.failJob(rejected!, "Source rejected old cursor (HTTP400)", now, undefined, true);
    expect((await store.history.readPage(address, "cashflows")).coverage.error).toContain("HTTP400");

    now += 30_001;
    const changed = await take(store, (job) => job.state.purpose === "pending");
    expect(changed?.state.cursor).toBe("pending-page");
    await store.history.commitPage(changed!, { items: [], nextCursor: null }, now, 60_000);
    expect((await store.history.readPage(address, "cashflows")).coverage.error).toContain("reconciliation is unresolved");
    expect((await store.history.stats()).pendingCorrections).toBe(1);
    expect((await mainStatus(store)).state).toEqual(before);

    now += 3_600_001;
    const resolved = await take(store, (job) => job.state.purpose === "pending");
    expect(resolved?.state.cursor).toBe("pending-page");
    await store.history.commitPage(resolved!, {
      items: [{ ...pending, withdrawalStatus: "settled" }], nextCursor: null,
    }, now, 60_000);
    const retained = await store.history.readPage<{ withdrawalStatus: string | null }>(address, "cashflows");
    expect(retained.items).toHaveLength(2);
    expect(retained.items.filter((item) => item.withdrawalStatus === "settled")).toHaveLength(1);
    expect(retained.coverage.error).toBeUndefined();
    expect((await store.history.stats()).pendingCorrections).toBe(0);
  });
});
