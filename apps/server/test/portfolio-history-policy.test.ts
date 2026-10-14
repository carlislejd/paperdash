import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import {
  createHistoryStore,
  historySchemaSql,
  type HistoryDatabase,
  type HistoryStore,
  type JobState,
  type SourcePortfolio,
} from "../src/history-store.js";
import {
  boundedPortfolioGaps,
  crossesPortfolioGap,
  portfolioHistoryRange,
  portfolioLocalGaps,
} from "../src/portfolio-history-policy.js";

const address = `0x${"d".repeat(40)}`;
const day = 86_400_000;
let now: number;
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0)) await close();
});

async function fixture(postgres: boolean) {
  let db: HistoryDatabase;
  if (postgres) {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const client = await pool.connect();
    cleanups.push(async () => {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    });
    await client.query("BEGIN");
    const prefix = "portfolio_policy_";
    await client.query(historySchemaSql(prefix, true));
    const params = (sql: string) => {
      let n = 0;
      return sql.replace(/\?/g, () => `$${++n}`);
    };
    db = {
      prefix,
      async rows<T>(sql: string, values: unknown[] = []) {
        return (await client.query(params(sql), values)).rows as T[];
      },
      async batch(statements) {
        await client.query("SAVEPOINT portfolio_batch");
        try {
          for (const statement of statements) {
            const result = await client.query(
              params(statement.sql),
              statement.params,
            );
            if (
              statement.requireChanges !== undefined &&
              result.rowCount !== statement.requireChanges
            )
              throw new Error("History job lease changed");
          }
          await client.query("RELEASE SAVEPOINT portfolio_batch");
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT portfolio_batch");
          throw error;
        }
      },
    };
  } else {
    const sqlite = new DatabaseSync(":memory:");
    cleanups.push(async () => sqlite.close());
    sqlite.exec(historySchemaSql("", false));
    db = {
      prefix: "",
      async rows<T>(sql: string, params: unknown[] = []) {
        return sqlite.prepare(sql).all(...(params as never[])) as T[];
      },
      async batch(statements) {
        sqlite.exec("BEGIN");
        try {
          for (const statement of statements) {
            const result = sqlite
              .prepare(statement.sql)
              .run(...((statement.params ?? []) as never[]));
            if (
              statement.requireChanges !== undefined &&
              Number(result.changes) !== statement.requireChanges
            )
              throw new Error("History job lease changed");
          }
          sqlite.exec("COMMIT");
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    };
  }
  const history = createHistoryStore(db);
  await history.ensureWallet(address, 10);
  return { db, history };
}

function publication(
  from: number,
  to: number,
  times: number[],
  revision: number,
  complete = true,
): SourcePortfolio {
  return {
    fromMs: from,
    toMs: to + 1,
    baseTimeMs: times[0] ?? from,
    timeOffsetsMs: times.map((time) => time - (times[0] ?? from)),
    columns: {
      equity: times.map((time) => time / 10),
      pnl: times.map(() => 0),
    },
    gapIndices: [],
    coverage: { availableFromMs: from, availableToMs: to, complete },
    source: { asOfMs: to + 1, generation: "same", revision: `100:${revision}` },
  };
}
async function commit(
  history: HistoryStore,
  value: SourcePortfolio,
  range = "1d",
) {
  const job = await history.claimJob(now, 120000, "active", [
    { address, kind: "cashflows" },
    { address, kind: "trades" },
  ]);
  expect(job?.kind).toBe("portfolio");
  await history.commitPortfolio(job!, value, range, now, 1);
  now++;
  return job!;
}
async function state(history: HistoryStore) {
  return (await history.getStatus(address)).find(
    (job) => job.kind === "portfolio",
  )!.state;
}

for (const postgres of [false, true])
  describe.skipIf(postgres && !process.env.TEST_DATABASE_URL)(
    `${postgres ? "PostgreSQL" : "SQLite"} portfolio coverage repair`,
    () => {
      it("uses covered bounds rather than a quiet window's first change, and propagates source partial coverage", async () => {
        const { history } = await fixture(postgres);
        await commit(history, publication(100, 400, [100, 300], 1), "all");
        await commit(history, publication(200, 500, [450], 2));
        expect((await state(history)).portfolio).toMatchObject({
          gap: false,
          localGapAfterMs: null,
          availableToMs: 500,
        });
        expect(
          (await history.readPortfolio(address))!.value.coverage.complete,
        ).toBe(true);
        // Empty/sparse changes still cover through the declared source boundary.
        await commit(history, publication(300, 600, [], 3, false));
        expect((await state(history)).portfolio).toMatchObject({
          gap: false,
          availableToMs: 600,
          sourceComplete: false,
        });
        expect(
          (await history.readPortfolio(address))!.value.coverage.complete,
        ).toBe(false);
        expect(portfolioHistoryRange(await state(history), now)).toBe("1d");
      });

      it("retains half-open boundary samples and fences replacement plus raw batches atomically", async () => {
        const { history, db } = await fixture(postgres);
        await commit(history, publication(100, 500, [100, 300, 400], 1), "all");
        const replacement = { ...publication(100, 500, [200], 2), toMs: 400 };
        const oldJob = await commit(history, replacement);
        expect(
          (await history.readPortfolio(address))!.value.columns.equity,
        ).toEqual([20, 40]);
        await expect(
          history.commitPortfolio(
            oldJob,
            publication(100, 600, [], 3),
            "all",
            now,
            1,
          ),
        ).rejects.toThrow("lease changed");
        expect(
          (await history.readPortfolio(address))!.value.columns.equity,
        ).toEqual([20, 40]);
        expect(
          Number(
            (
              await db.rows<{ count: number }>(
                `SELECT count(*) AS count FROM ${db.prefix}history_portfolio_batches`,
              )
            )[0].count,
          ),
        ).toBe(2);
      });

      it("keeps local joins separate from source partial coverage and clears a demonstrably bridged join", async () => {
        const { history } = await fixture(postgres);
        await commit(history, publication(0, 200, [100, 200], 1), "all");
        await commit(history, publication(400, 600, [450], 2));
        expect((await state(history)).portfolio).toMatchObject({
          gap: true,
          localGapAfterMs: 200,
        });
        expect(
          (await history.readPortfolio(address))!.value.gapIndices,
        ).toEqual([2]);
        await commit(history, publication(150, 800, [175, 450, 700], 3), "1w");
        expect((await state(history)).portfolio).toMatchObject({
          gap: false,
          localGapAfterMs: null,
        });
        expect(
          (await history.readPortfolio(address))!.value.gapIndices,
        ).toEqual([]);
        expect(
          (await history.readPortfolio(address))!.value.coverage.complete,
        ).toBe(true);
        await commit(
          history,
          publication(150, 900, [175, 850], 4, false),
          "all",
        );
        expect((await state(history)).portfolio).toMatchObject({
          gap: false,
          localGapAfterMs: null,
          sourceComplete: false,
        });
        expect(
          (await history.readPortfolio(address))!.value.coverage.complete,
        ).toBe(false);
      });

      it("preserves a known join through an incomplete full read until available data actually bridges it", async () => {
        const { history } = await fixture(postgres);
        await commit(history, publication(0, 200, [100, 200], 1), "all");
        await commit(history, publication(400, 600, [450], 2));
        await commit(
          history,
          publication(400, 800, [450, 700], 3, false),
          "all",
        );
        expect((await state(history)).portfolio).toMatchObject({
          localGapAfterMs: 200,
          gap: true,
          sourceComplete: false,
        });
        expect(
          (await history.readPortfolio(address))!.value.gapIndices,
        ).toEqual([2]);
        expect(
          (await history.readPortfolio(address))!.value.columns.equity,
        ).toEqual([10, 20, 45, 70]);
        // Even an unhealed full attempt is throttled; retained evidence is not a
        // reason to download all history again on the next active refresh.
        expect(portfolioHistoryRange(await state(history), now)).toBe("1d");
        await commit(
          history,
          publication(150, 900, [175, 450, 850], 4, false),
          "all",
        );
        expect((await state(history)).portfolio).toMatchObject({
          localGapAfterMs: null,
          gap: false,
          sourceComplete: false,
        });
        expect(
          (await history.readPortfolio(address))!.value.gapIndices,
        ).toEqual([]);
      });

      it("does not shrink the retained horizon when a partial full response preserves a later tail", async () => {
        const { history } = await fixture(postgres);
        await commit(history, publication(0, 200, [100, 200], 1), "all");
        await commit(history, publication(400, 600, [450], 2));
        await commit(history, publication(800, 1000, [850], 3));
        const narrower = publication(400, 700, [450, 650], 4, false);
        narrower.source!.asOfMs = 1101;
        narrower.toMs = 1101;
        await commit(history, narrower, "all");
        expect((await state(history)).portfolio).toMatchObject({
          availableToMs: 1000,
          localGapAfterMs: 200,
        });
        expect(
          (await history.readPortfolio(address))!.value.columns.equity.at(-1),
        ).toBe(85);
        const incompleteBridge = publication(150, 700, [175, 650], 5, false);
        incompleteBridge.source!.asOfMs = 1201;
        incompleteBridge.toMs = 1201;
        await commit(history, incompleteBridge, "1w");
        expect((await state(history)).portfolio).toMatchObject({
          availableToMs: 1000,
          localGapAfterMs: 600,
          gap: true,
        });
      });

      it("keeps multiple missing intervals through ordinary overlapping refreshes and heals each independently", async () => {
        const { history } = await fixture(postgres);
        await commit(history, publication(0, 200, [100, 200], 1), "all");
        await commit(history, publication(400, 600, [450], 2));
        await commit(history, publication(800, 1000, [850], 3));
        expect(
          (await history.readPortfolio(address))!.value.gapIndices,
        ).toEqual([2, 3]);
        await commit(history, publication(800, 1100, [850, 1000], 4));
        expect((await state(history)).portfolio!.localGaps).toEqual([
          { afterMs: 200, beforeMs: 400 },
          { afterMs: 600, beforeMs: 800 },
        ]);
        expect(
          (await history.readPortfolio(address))!.value.gapIndices,
        ).toEqual([2, 3]);
        const repair = publication(150, 700, [175, 450, 650], 5);
        repair.source!.asOfMs = 1201;
        repair.toMs = 1201;
        await commit(history, repair, "1w");
        expect((await state(history)).portfolio).toMatchObject({
          localGapAfterMs: 600,
          localGaps: [{ afterMs: 600, beforeMs: 800 }],
        });
        // This conservative cut also disconnects a sample observed inside the
        // still-unbridged interval; it never draws across the unknown suffix.
        expect(
          (await history.readPortfolio(address))!.value.gapIndices,
        ).toEqual([3, 4]);
      });

      it("remembers a second gap through empty windows without manufacturing a chart sample", async () => {
        const { history } = await fixture(postgres);
        await commit(history, publication(0, 200, [100, 200], 1), "all");
        await commit(history, publication(400, 600, [450], 2));
        await commit(history, publication(800, 1000, [], 3, false));
        expect((await state(history)).portfolio!.localGaps).toEqual([
          { afterMs: 200, beforeMs: 400 },
          { afterMs: 600, beforeMs: 800 },
        ]);
        expect(
          (await history.readPortfolio(address))!.value.columns.equity,
        ).toEqual([10, 20, 45]);
        await commit(history, publication(800, 1200, [1100], 4, false));
        expect(
          (await history.readPortfolio(address))!.value.gapIndices,
        ).toEqual([2, 3]);
      });

      it("uses old covered-through clocks despite fresh receipts and persists the 24-hour repair cooldown across reopening", async () => {
        const { history, db } = await fixture(postgres);
        const old = now - 8 * day;
        await commit(
          history,
          publication(old - day, old, [old - 1000], 1, false),
          "all",
        );
        expect(portfolioHistoryRange(await state(history), now)).toBe("1d");
        now += day;
        // Success at today's receipt does not make the old source horizon current.
        await commit(history, publication(old - day, old, [], 1, false));
        expect(portfolioHistoryRange(await state(history), now)).toBe("all");
        await commit(history, publication(old - day, old, [], 1, false), "all");
        const reopened = createHistoryStore(db);
        expect(portfolioHistoryRange(await state(reopened), now)).toBe("1d");
        now += day - 2;
        expect(portfolioHistoryRange(await state(reopened), now)).toBe("1d");
        now += 2;
        expect(portfolioHistoryRange(await state(reopened), now)).toBe("all");
      });

      it("does not treat a requested prefix as available when the source is incomplete, and keeps legacy unknown gaps conservative", async () => {
        const { history, db } = await fixture(postgres);
        await commit(history, publication(100, 300, [100, 200], 1), "all");
        const partial = publication(0, 600, [450], 2, false);
        partial.coverage.availableFromMs = 400;
        await commit(history, partial);
        expect((await state(history)).portfolio).toMatchObject({
          localGapAfterMs: 300,
          gap: true,
          sourceComplete: false,
        });
        const saved = await state(history);
        delete saved.portfolio!.localGaps;
        delete saved.portfolio!.localGapAfterMs;
        delete saved.portfolio!.repairFetchedAt;
        await db.batch([
          {
            sql: `UPDATE ${db.prefix}history_jobs SET state=? WHERE address=? AND kind='portfolio'`,
            params: [JSON.stringify(saved), address],
          },
        ]);
        await commit(history, publication(0, 700, [100, 650], 3, true));
        expect((await state(history)).portfolio!.gap).toBe(true);
        await commit(history, publication(0, 800, [100, 750], 4, false), "all");
        expect((await state(history)).portfolio).toMatchObject({
          gap: false,
          sourceComplete: false,
        });
      });

      it("preserves known samples outside a partial source interval, including an empty publication's unavailable prefix and tail", async () => {
        const { history } = await fixture(postgres);
        await commit(
          history,
          publication(0, 800, [100, 300, 500, 700], 1),
          "all",
        );
        const partial = publication(0, 900, [450], 2, false);
        partial.coverage.availableFromMs = 200;
        partial.coverage.availableToMs = 600;
        await commit(history, partial);
        expect(
          (await history.readPortfolio(address))!.value.columns.equity,
        ).toEqual([10, 45, 70]);
        await commit(history, {
          ...partial,
          timeOffsetsMs: [],
          columns: { equity: [], pnl: [] },
        });
        expect(
          (await history.readPortfolio(address))!.value.columns.equity,
        ).toEqual([10, 70]);
        // A partial response without coverage bounds has no authority to retract
        // old rows merely because they are absent from this response.
        await commit(history, {
          ...partial,
          coverage: {
            complete: false,
            availableFromMs: null,
            availableToMs: null,
          },
        });
        expect(
          (await history.readPortfolio(address))!.value.columns.equity,
        ).toEqual([10, 45, 70]);
      });

      it("clips coverage to the requested window so global-looking metadata cannot hide a missing join", async () => {
        const { history } = await fixture(postgres);
        await commit(history, publication(0, 200, [100], 1), "all");
        const partial = publication(400, 600, [450], 2, false);
        partial.coverage.availableFromMs = 0;
        partial.coverage.availableToMs = 900;
        await commit(history, partial);
        expect((await state(history)).portfolio).toMatchObject({
          localGapAfterMs: 200,
          gap: true,
          availableToMs: 601,
        });
        expect(
          (await history.readPortfolio(address))!.value.columns.equity,
        ).toEqual([10, 45]);
      });
    },
  );

describe("portfolio range policy", () => {
  function checkpoint(
    overrides: Partial<NonNullable<JobState["portfolio"]>> = {},
  ): JobState {
    return {
      phase: "head",
      cursor: null,
      cycle: "saved",
      complete: true,
      pages: 1,
      failures: 0,
      lastSuccessAt: now,
      portfolio: {
        fullFetchedAt: now - 2 * day,
        sourceComplete: true,
        gap: false,
        availableToMs: now,
        range: "1d",
        ...overrides,
      },
    };
  }
  it("uses 1w after 20 covered hours, all after six days, and a local join even after newer coverage arrives", () => {
    expect(
      portfolioHistoryRange(
        checkpoint({ availableToMs: now - 21 * 3_600_000 }),
        now,
      ),
    ).toBe("1w");
    expect(
      portfolioHistoryRange(
        checkpoint({ availableToMs: now - 6 * day - 1 }),
        now,
      ),
    ).toBe("all");
    expect(
      portfolioHistoryRange(
        checkpoint({ availableToMs: now, localGapAfterMs: now - 2 * day }),
        now,
      ),
    ).toBe("1w");
    expect(
      portfolioHistoryRange(
        checkpoint({ sourceComplete: false, gap: false }),
        now,
      ),
    ).toBe("1d");
  });
  it("preserves initial/new-generation and weekly reconciliation rules, with safe legacy cooldown defaults", () => {
    expect(
      portfolioHistoryRange(
        { ...checkpoint({ fullFetchedAt: now }), complete: false },
        now,
      ),
    ).toBe("all");
    expect(
      portfolioHistoryRange(
        checkpoint({ fullFetchedAt: now - 7 * day - 1, repairFetchedAt: now }),
        now,
      ),
    ).toBe("all");
    expect(
      portfolioHistoryRange(
        checkpoint({ fullFetchedAt: now, availableToMs: now - 8 * day }),
        now,
      ),
    ).toBe("1d");
    const legacy = checkpoint();
    delete legacy.portfolio;
    expect(portfolioHistoryRange(legacy, now)).toBe("all");
  });
  it("does not let invalid or future saved repair clocks pin recent-only reads", () => {
    for (const invalid of [now + day, Infinity, NaN, -1, 1.5]) {
      expect(
        portfolioHistoryRange(checkpoint({ fullFetchedAt: invalid }), now),
      ).toBe("all");
      expect(
        portfolioHistoryRange(
          checkpoint({
            repairFetchedAt: invalid,
            availableToMs: now - 2 * day,
          }),
          now,
        ),
      ).toBe("1w");
    }
  });
  it("bounds interval state by conservatively coalescing old gaps, preserving every missing segment", () => {
    const original = Array.from({ length: 40 }, (_, i) => ({
      afterMs: i * 100,
      beforeMs: i * 100 + 50,
    }));
    const bounded = boundedPortfolioGaps(original);
    expect(bounded).toHaveLength(32);
    expect(bounded[0]).toEqual({ afterMs: 0, beforeMs: 850 });
    for (const gap of original)
      expect(crossesPortfolioGap(gap.afterMs, gap.beforeMs, bounded)).toBe(
        true,
      );
    expect(crossesPortfolioGap(3950, 4000, bounded)).toBe(false);
    // New intervals are canonical even if a stale old-reader mirror disagrees.
    const saved = checkpoint({ localGaps: [], localGapAfterMs: now - 3 * day });
    expect(portfolioHistoryRange(saved, now)).toBe("1d");
    delete saved.portfolio!.localGaps;
    expect(portfolioLocalGaps(saved.portfolio)).toEqual([
      { afterMs: now - 3 * day, beforeMs: now },
    ]);
    expect(portfolioHistoryRange(saved, now)).toBe("1w");
  });
});
