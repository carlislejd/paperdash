import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../src/api.js";
import { createStore, type Store } from "../src/store.js";

const stores: Store[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
});

describe("saved indexing progress freshness", () => {
  it.each([
    { age: 25000, heartbeatAge: 1000, reportingError: false, stale: false },
    { age: 90001, heartbeatAge: 1000, reportingError: false, stale: true },
    { age: 1000, heartbeatAge: 30001, reportingError: false, stale: true },
    { age: 1000, heartbeatAge: 1000, reportingError: true, stale: true },
    { age: -6000, heartbeatAge: 1000, reportingError: false, stale: true },
    { age: 1000, heartbeatAge: -6000, reportingError: false, stale: true },
  ])("reports $stale for $age ms-old progress and $heartbeatAge ms-old heartbeat", async ({ age, heartbeatAge, reportingError, stale }) => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = await createStore({ memory: true, databaseUrl: "" });
    stores.push(store);
    const progress = {
      pending: 100, activeDue: 5, backfillDue: 20,
      maintenanceDue: 70, correctionsDue: 5,
    };
    await store.put("indexing-status", progress, now - age);
    await store.put("collector-heartbeat", {
      at: now - heartbeatAge,
      errors: reportingError ? { "indexing-status": "Status persistence failed" } : {},
    });
    const scan = vi.spyOn(store.history, "stats");
    const app = await buildApi(store, undefined, undefined, { logger: false });
    try {
      const response = await app.inject("/api/indexing");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        indexing: progress, receivedAt: now - age, stale,
      });
      expect(scan).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("does not report a missing queue snapshot as fresh merely because the collector is alive", async () => {
    const store = await createStore({ memory: true, databaseUrl: "" });
    stores.push(store);
    await store.put("collector-heartbeat", { at: Date.now(), errors: {} });
    const app = await buildApi(store, undefined, undefined, { logger: false });
    try {
      expect((await app.inject("/api/indexing")).json()).toMatchObject({
        indexing: null, stale: true,
      });
    } finally {
      await app.close();
    }
  });
});
