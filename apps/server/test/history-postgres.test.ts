import { afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createStore, type Store } from "../src/store.js";
import type { HistoryJob } from "../src/history-store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const address = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});
describe.skipIf(!databaseUrl)("PostgreSQL retained ledger integration", () => {
  it("migrates, atomically fences claims, preserves copies and checkpoints across processes, and retains source portfolio batches", async () => {
    let first = await createStore({ databaseUrl, autoMigrate: true });
    stores.push(first);
    const admin = new Pool({ connectionString: databaseUrl });
    try {
      // Only this synthetic integration-test wallet is removed, never other
      // tasks' fixtures or any runtime table outside the history subsystem.
      for (const name of [
        "wallets",
        "jobs",
        "records",
        "pages",
        "visits",
        "portfolio_batches",
        "corrections",
      ])
        await admin.query(
          `DELETE FROM paperdash_history_${name} WHERE address=$1`,
          [address],
        );
      await admin.query("DELETE FROM paperdash_history_points WHERE scope=$1", [
        address,
      ]);
      await first.history.ensureWallet(address, 10);
      const second = await createStore({ databaseUrl, autoMigrate: false });
      stores.push(second);
      const now = Date.now() + 100;
      const claims = await Promise.all([
        first.history.claimJob(now),
        second.history.claimJob(now),
      ]);
      expect(claims.every(Boolean)).toBe(true);
      expect(new Set(claims.map((j) => `${j!.address}:${j!.kind}`)).size).toBe(
        2,
      );
      let job = claims.find(
        (j) => j?.address === address && j.kind === "cashflows",
      ) as HistoryJob | undefined;
      if (!job) job = (await first.history.claimJob(now))!;
      expect(job.kind).toBe("cashflows");
      const item = {
        timestampMs: 1000,
        txHash: `0x${"3".repeat(64)}`,
        amountRaw: "90071992547409939999999",
        kind: "Deposit",
        route: null,
        recipientAmountRaw: null,
        withdrawalStatus: null,
      };
      await first.history.commitPage(
        job,
        { items: [item, item], nextCursor: "pg-resume" },
        now + 1,
        60000,
      );
      await expect(
        second.history.commitPage(
          job,
          { items: [{ ...item, amountRaw: "1" }], nextCursor: null },
          now + 2,
          60000,
        ),
      ).rejects.toThrow("lease changed");
      // Release a connection pool and reopen to prove the cursor isn't in RAM.
      await first.close();
      stores.splice(stores.indexOf(first), 1);
      first = await createStore({ databaseUrl, autoMigrate: false });
      stores.push(first);
      let resumed: HistoryJob | null = null;
      for (let i = 0; i < 6 && !resumed; i++) {
        const next = await first.history.claimJob(now + 1002);
        if (next?.address === address && next.kind === "cashflows")
          resumed = next;
      }
      expect(resumed?.state.cursor).toBe("pg-resume");
      await first.history.commitPage(
        resumed!,
        { items: [item], nextCursor: null },
        now + 1003,
        60000,
      );
      const page = await second.history.readPage<{
        id: string;
        amountRaw: string;
      }>(address, "cashflows");
      expect(page.coverage).toMatchObject({
        retainedCount: 3,
        backfillComplete: true,
        sourceComplete: null,
      });
      expect(new Set(page.items.map((r) => r.id)).size).toBe(3);
      expect(page.items.every((r) => r.amountRaw === item.amountRaw)).toBe(
        true,
      );
      // Let the already-claimed portfolio lease expire and claim it again.
      const later = now + 121000;
      let portfolio: HistoryJob | null = null;
      for (let i = 0; i < 8 && !portfolio; i++) {
        const next = await first.history.claimJob(later);
        if (next?.address === address && next.kind === "portfolio")
          portfolio = next;
      }
      expect(portfolio).not.toBeNull();
      await first.history.commitPortfolio(
        portfolio!,
        {
          fromMs: 1,
          toMs: 3,
          baseTimeMs: 1,
          intervalMs: 1,
          timeOffsetsMs: [0, 0, 1],
          columns: { equity: [1, 2, 3], pnl: [0, 0, 1] },
          gapIndices: [],
          coverage: { availableFromMs: 1, availableToMs: 3, complete: false },
          source: { asOfMs: 3, revision: "1:1", generation: "test" },
        },
        "all",
        later + 1,
        60000,
      );
      expect(
        (await second.history.readPortfolio(address))!.value.columns.equity,
      ).toEqual([1, 2, 3]);
      expect(
        (
          await admin.query(
            "SELECT count(*) AS count FROM paperdash_history_portfolio_batches WHERE address=$1",
            [address],
          )
        ).rows[0].count,
      ).toBe("1");
      expect((await first.history.stats()).wallets).toBeGreaterThanOrEqual(1);
    } finally {
      await admin.end();
    }
  }, 20000);
});
