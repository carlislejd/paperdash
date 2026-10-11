import { randomUUID } from "node:crypto";
import type {
  HistoryPage,
  PortfolioHistory,
  ProtocolChartMetric,
} from "../../../packages/shared/src/types.js";
import { addressSchema, digest } from "./schemas.js";
import { enqueuePositionMetrics } from "./position-metrics-store.js";

export type LedgerKind = "cashflows" | "trades";
export type JobKind = LedgerKind | "portfolio";
export interface HistoryCoverage {
  backfillComplete: boolean;
  sourceComplete: boolean | null;
  identity: "source-fields-and-occurrence";
  identityAmbiguous: boolean;
  retainedCount: number;
  retainedCountCapped?: boolean;
  indexing: boolean;
  lastIndexedAt: number | null;
  error?: string;
}
export interface RetainedHistoryPage<T> extends HistoryPage<T> {
  receivedAt: number | null;
  stale: boolean;
  coverage: HistoryCoverage;
}
export interface JobState {
  phase: "backfill" | "head";
  cursor: string | null;
  cycle: string;
  complete: boolean;
  pages: number;
  failures: number;
  lastSuccessAt: number | null;
  error?: string;
  purpose?: "head" | "pending";
  jobKind?: LedgerKind;
  targets?: string[];
  carryTime?: number;
  occurrences?: Record<string, number>;
  portfolio?: {
    fullFetchedAt: number;
    sourceComplete: boolean;
    gap: boolean;
    availableToMs: number | null;
    range: string;
    source?: { asOfMs: number; revision: string; generation: string };
  };
}
export interface HistoryJob {
  address: string;
  kind: JobKind;
  token: string;
  state: JobState;
  priority: number;
  nextRun: number;
  lockedUntil: number;
  correctionId?: string;
}
export interface SourcePortfolio extends PortfolioHistory {
  fromMs?: number;
  toMs?: number;
  intervalMs?: number;
  source?: { asOfMs: number; revision: string; generation: string };
}
export interface JobStatus {
  kind: JobKind;
  state: JobState;
  nextRun: number;
  lockedUntil: number;
}
export interface Statement {
  sql: string;
  params?: unknown[];
  requireChanges?: number;
}
export interface HistoryDatabase {
  prefix: string;
  rows<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** All statements commit together, with optional fenced row-count guards. */
  batch(statements: Statement[]): Promise<void>;
}
export interface HistoryStore {
  ensureWallet(address: string, priority?: number): Promise<void>;
  discoverWallets(addresses: string[], priority?: number): Promise<void>;
  claimJob(
    now?: number,
    leaseMs?: number,
    lane?: "active" | "fair",
  ): Promise<HistoryJob | null>;
  commitPage(
    job: HistoryJob,
    page: HistoryPage<Record<string, unknown>>,
    at: number,
    refreshMs: number,
  ): Promise<void>;
  commitPortfolio(
    job: HistoryJob,
    value: SourcePortfolio,
    range: string,
    at: number,
    refreshMs: number,
  ): Promise<void>;
  failJob(
    job: HistoryJob,
    error: string,
    at: number,
    retryAt?: number,
    resetCursor?: boolean,
  ): Promise<void>;
  readPage<T>(
    address: string,
    kind: LedgerKind,
    cursor?: string,
    limit?: number,
  ): Promise<RetainedHistoryPage<T>>;
  readPortfolio(address: string): Promise<{
    value: PortfolioHistory;
    receivedAt: number;
    coverage: HistoryCoverage;
  } | null>;
  getStatus(address: string): Promise<JobStatus[]>;
  stats(): Promise<{
    wallets: number;
    jobs: number;
    pending: number;
    failed: number;
    oldestDueAt: number | null;
    backfillComplete: number;
    pendingCorrections: number;
  }>;
  retainProtocol(
    points: { time: number; value: number }[],
    at?: number,
  ): Promise<void>;
  protocolPoints(limit?: number): Promise<{ time: number; value: number }[]>;
  retainProtocolCharts(
    source: "summary" | "history",
    rows: ProtocolChartObservation[],
  ): Promise<void>;
  protocolChartRows(
    source: "summary" | "history",
    limit?: number,
  ): Promise<ProtocolChartObservation[]>;
}
export interface ProtocolChartObservation {
  time: number;
  endpointAt: number;
  sourceAt: number;
  generation: string;
  complete: boolean;
  values: Partial<Record<ProtocolChartMetric, number | null>>;
  volumeRaw?: string;
  /** Exact 18-decimal summary fields; absent from old numeric history rows. */
  paperSupplyRaw?: string;
  paperStakedRaw?: string;
  allocatedRewardsRaw?: string;
}

export function historySchemaSql(prefix: string, postgres: boolean): string {
  const json = postgres ? "jsonb" : "TEXT";
  const int = postgres ? "bigint" : "INTEGER";
  return `
CREATE TABLE IF NOT EXISTS ${prefix}history_wallets(address TEXT PRIMARY KEY,priority INTEGER NOT NULL,active_until ${int} NOT NULL,last_seen ${int} NOT NULL);
CREATE TABLE IF NOT EXISTS ${prefix}history_jobs(address TEXT NOT NULL,kind TEXT NOT NULL,state ${json} NOT NULL,next_run ${int} NOT NULL,locked_until ${int} NOT NULL DEFAULT 0,token TEXT,updated_at ${int} NOT NULL,PRIMARY KEY(address,kind));
CREATE INDEX IF NOT EXISTS ${prefix}history_jobs_due ON ${prefix}history_jobs(next_run,locked_until);
CREATE TABLE IF NOT EXISTS ${prefix}history_records(address TEXT NOT NULL,kind TEXT NOT NULL,record_key TEXT NOT NULL,source_at ${int} NOT NULL,payload ${json} NOT NULL,payload_hash TEXT NOT NULL,ambiguous INTEGER NOT NULL,received_at ${int} NOT NULL,PRIMARY KEY(address,kind,record_key));
CREATE INDEX IF NOT EXISTS ${prefix}history_records_page ON ${prefix}history_records(address,kind,source_at DESC,record_key DESC);
CREATE TABLE IF NOT EXISTS ${prefix}history_pages(id TEXT PRIMARY KEY,address TEXT NOT NULL,kind TEXT NOT NULL,cursor TEXT,payload ${json} NOT NULL,received_at ${int} NOT NULL);
CREATE TABLE IF NOT EXISTS ${prefix}history_visits(address TEXT NOT NULL,kind TEXT NOT NULL,cycle TEXT NOT NULL,cursor_hash TEXT NOT NULL,PRIMARY KEY(address,kind,cycle,cursor_hash));
CREATE TABLE IF NOT EXISTS ${prefix}history_points(scope TEXT NOT NULL,time ${int} NOT NULL,payload ${json} NOT NULL,received_at ${int} NOT NULL,PRIMARY KEY(scope,time));
CREATE TABLE IF NOT EXISTS ${prefix}history_portfolio_batches(id TEXT PRIMARY KEY,address TEXT NOT NULL,range_name TEXT NOT NULL,payload ${json} NOT NULL,received_at ${int} NOT NULL);
CREATE TABLE IF NOT EXISTS ${prefix}history_corrections(id TEXT PRIMARY KEY,address TEXT NOT NULL,state ${json} NOT NULL,next_run ${int} NOT NULL,locked_until ${int} NOT NULL DEFAULT 0,token TEXT,updated_at ${int} NOT NULL);
CREATE INDEX IF NOT EXISTS ${prefix}history_corrections_due ON ${prefix}history_corrections(next_run,locked_until);
`;
}
const parsed = <T>(v: unknown): T =>
  (typeof v === "string" ? JSON.parse(v) : v) as T;
const freshState = (): JobState => ({
  phase: "backfill",
  cursor: null,
  cycle: randomUUID(),
  complete: false,
  pages: 0,
  failures: 0,
  lastSuccessAt: null,
});
function localCursor(time: number, key: string): string {
  return `pd1.${Buffer.from(JSON.stringify([time, key])).toString("base64url")}`;
}
export class HistoryCursorError extends Error {}
function decodeCursor(cursor: string): [number, string] {
  try {
    if (!/^pd1\.[\w-]+$/.test(cursor) || cursor.length > 512) throw new Error();
    const value = JSON.parse(
      Buffer.from(cursor.slice(4), "base64url").toString("utf8"),
    );
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      !Number.isSafeInteger(value[0]) ||
      value[0] < 0 ||
      typeof value[1] !== "string" ||
      !/^[a-f0-9]{64}:\d+$/.test(value[1])
    )
      throw new Error();
    return value as [number, string];
  } catch {
    throw new HistoryCursorError("Invalid retained-history cursor");
  }
}

/** IDs describe source observations, not verified chain logs. A tx hash alone
 * cannot identify batched cashflows. Ordinals carry across page boundaries;
 * original page variants remain available for later canonical reconciliation. */
function identify(job: HistoryJob, items: Record<string, unknown>[]) {
  let time = job.state.carryTime;
  let counts = { ...job.state.occurrences };
  const rows = items.map((item) => {
    const at = Number(item.timestampMs);
    if (
      !Number.isSafeInteger(at) ||
      at < 0 ||
      (time !== undefined && at > time)
    )
      throw new Error("History is not in descending timestamp order");
    if (at !== time) {
      counts = {};
      time = at;
    }
    const base = digest(
      job.kind === "cashflows"
        ? [job.address, item.txHash, item.kind, item.timestampMs]
        : [job.address, item.positionId],
    );
    const occurrence = (counts[base] ?? 0) + 1;
    counts[base] = occurrence;
    return {
      key: `${base}:${occurrence}`,
      at,
      payload: item,
      hash: digest(item),
      ambiguous: job.kind === "cashflows" || occurrence > 1,
    };
  });
  return { rows, carryTime: time, occurrences: counts };
}

export function createHistoryStore(db: HistoryDatabase): HistoryStore {
  const t = (name: string) => `${db.prefix}history_${name}`;
  async function status(address: string): Promise<JobStatus[]> {
    return (
      await db.rows<{
        kind: JobKind;
        state: unknown;
        next_run: number | string;
        locked_until: number | string;
      }>(
        `SELECT kind,state,next_run,locked_until FROM ${t("jobs")} WHERE address=?`,
        [address],
      )
    ).map((r) => ({
      kind: r.kind,
      state: parsed<JobState>(r.state),
      nextRun: Number(r.next_run),
      lockedUntil: Number(r.locked_until),
    }));
  }
  function checkpoint(
    job: HistoryJob,
    state: JobState,
    at: number,
    nextRun: number,
  ): Statement {
    if (job.correctionId)
      return {
        sql: `UPDATE ${t("corrections")} SET state=?,next_run=?,locked_until=0,token=NULL,updated_at=? WHERE id=? AND token=? AND locked_until>?`,
        params: [
          JSON.stringify(state),
          nextRun,
          at,
          job.correctionId,
          job.token,
          at,
        ],
        requireChanges: 1,
      };
    return {
      sql: `UPDATE ${t("jobs")} SET state=?,next_run=?,locked_until=0,token=NULL,updated_at=? WHERE address=? AND kind=? AND token=? AND locked_until>?`,
      params: [
        JSON.stringify(state),
        nextRun,
        at,
        job.address,
        job.kind,
        job.token,
        at,
      ],
      requireChanges: 1,
    };
  }
  function point(
    scope: string,
    time: number,
    payload: unknown,
    at: number,
  ): Statement {
    return {
      sql: `INSERT INTO ${t("points")} (scope,time,payload,received_at) VALUES(?,?,?,?) ON CONFLICT(scope,time) DO UPDATE SET payload=excluded.payload,received_at=excluded.received_at WHERE ${t("points")}.received_at<=excluded.received_at`,
      params: [scope, time, JSON.stringify(payload), at],
    };
  }
  function coverage(
    state: JobState | undefined,
    count: number,
    ambiguous: boolean,
  ): HistoryCoverage {
    return {
      backfillComplete: state?.complete ?? false,
      sourceComplete: state?.portfolio?.sourceComplete ?? null,
      identity: "source-fields-and-occurrence",
      identityAmbiguous: ambiguous,
      retainedCount: count,
      indexing: !state?.complete || state.cursor !== null,
      lastIndexedAt: state?.lastSuccessAt ?? null,
      ...(state?.error ? { error: state.error } : {}),
    };
  }
  const api: HistoryStore = {
    async ensureWallet(address, priority = 0) {
      await api.discoverWallets([address], priority);
    },
    async discoverWallets(addresses, priority = 0) {
      const at = Date.now();
      priority = Math.max(0, Math.min(20, Math.floor(priority)));
      const statements: Statement[] = [];
      for (const address of [
        ...new Set(addresses.map((a) => addressSchema.parse(a))),
      ]) {
        statements.push({
          sql: `INSERT INTO ${t("wallets")} VALUES(?,?,?,?) ON CONFLICT(address) DO UPDATE SET priority=CASE WHEN ${t("wallets")}.active_until>? AND ${t("wallets")}.priority>excluded.priority THEN ${t("wallets")}.priority ELSE excluded.priority END,active_until=CASE WHEN ${t("wallets")}.active_until>excluded.active_until THEN ${t("wallets")}.active_until ELSE excluded.active_until END,last_seen=excluded.last_seen`,
          params: [address, priority, priority > 0 ? at + 600000 : 0, at, at],
        });
        for (const kind of ["cashflows", "trades", "portfolio"] as const) {
          statements.push({
            sql: `INSERT INTO ${t("jobs")} (address,kind,state,next_run,locked_until,updated_at) VALUES(?,?,?,?,0,?) ON CONFLICT(address,kind) DO NOTHING`,
            params: [address, kind, JSON.stringify(freshState()), at, at],
          });
          if (priority > 0)
            statements.push({
              sql: `UPDATE ${t("jobs")} SET next_run=? WHERE address=? AND kind=? AND next_run>? AND updated_at<? AND locked_until<=? AND ${db.prefix ? "(state->>'failures')::integer" : "json_extract(state,'$.failures')"}=0`,
              params: [
                at,
                address,
                kind,
                at,
                at - (kind === "portfolio" ? 300000 : 60000),
                at,
              ],
            });
        }
        if (priority > 0)
          statements.push({
            sql: `UPDATE ${t("corrections")} SET next_run=? WHERE address=? AND id LIKE 'head:%' AND next_run>? AND updated_at<? AND locked_until<=? AND ${db.prefix ? "(state->>'failures')::integer" : "json_extract(state,'$.failures')"}=0`,
            params: [at, address, at, at - 60000, at],
          });
      }
      if (statements.length) await db.batch(statements);
    },
    async claimJob(now = Date.now(), leaseMs = 120000, lane = "fair") {
      // The indexer alternates an active lane with a oldest-due lane, so a large
      // initial inventory cannot starve viewed wallets or stop deep backfills.
      const candidates = await db.rows<{
        address: string;
        kind: JobKind;
        state: unknown;
        next_run: string | number;
        priority: number;
      }>(
        `SELECT j.address,j.kind,j.state,j.next_run,CASE WHEN w.active_until>? THEN w.priority ELSE 0 END AS priority FROM ${t("jobs")} j JOIN ${t("wallets")} w ON w.address=j.address WHERE j.next_run<=? AND j.locked_until<=? ${lane === "active" ? "AND w.active_until>? AND w.priority>0" : ""} ORDER BY j.next_run,j.address,j.kind LIMIT 8`,
        [now, now, now, ...(lane === "active" ? [now] : [])],
      );
      const corrections = await db.rows<{
        id: string;
        address: string;
        state: unknown;
        next_run: number | string;
      }>(
        `SELECT c.id,c.address,c.state,c.next_run FROM ${t("corrections")} c JOIN ${t("wallets")} w ON w.address=c.address WHERE c.next_run<=? AND c.locked_until<=? ${lane === "active" ? "AND w.active_until>? AND w.priority>0" : ""} ORDER BY c.next_run LIMIT 2`,
        [now, now, ...(lane === "active" ? [now] : [])],
      );
      const jobs = [
        ...candidates.map((r) => ({
          ...r,
          correctionId: undefined as string | undefined,
        })),
        ...corrections.map((r) => ({
          ...r,
          correctionId: r.id,
          kind: parsed<JobState>(r.state).jobKind ?? "cashflows",
          priority: lane === "active" ? 10 : 0,
        })),
      ].sort((a, b) => Number(a.next_run) - Number(b.next_run));
      for (const row of jobs) {
        const token = randomUUID();
        try {
          await db.batch([
            row.correctionId
              ? {
                  sql: `UPDATE ${t("corrections")} SET token=?,locked_until=? WHERE id=? AND next_run<=? AND locked_until<=?`,
                  params: [token, now + leaseMs, row.correctionId, now, now],
                  requireChanges: 1,
                }
              : {
                  sql: `UPDATE ${t("jobs")} SET token=?,locked_until=? WHERE address=? AND kind=? AND next_run<=? AND locked_until<=?`,
                  params: [
                    token,
                    now + leaseMs,
                    row.address,
                    row.kind,
                    now,
                    now,
                  ],
                  requireChanges: 1,
                },
          ]);
          return {
            address: row.address,
            kind: row.kind,
            token,
            state: parsed<JobState>(row.state),
            priority: Number(row.priority),
            nextRun: Number(row.next_run),
            lockedUntil: now + leaseMs,
            correctionId: row.correctionId,
          };
        } catch (error) {
          if (!(
            error instanceof Error &&
            error.message === "History job lease changed"
          ))
            throw error;
        }
      }
      return lane === "active" ? api.claimJob(now, leaseMs, "fair") : null;
    },
    async commitPage(job, page, at, refreshMs) {
      if (job.kind === "portfolio")
        throw new Error("Wrong job kind for ledger page");
      const pendingCorrection = Boolean(
        job.correctionId && job.state.purpose !== "head",
      );
      if (
        !pendingCorrection &&
        page.nextCursor &&
        (page.nextCursor === job.state.cursor ||
          (
            await db.rows(
              `SELECT 1 FROM ${t("visits")} WHERE address=? AND kind=? AND cycle=? AND cursor_hash=?`,
              [job.address, job.kind, job.state.cycle, digest(page.nextCursor)],
            )
          ).length)
      )
        throw new Error("Upstream history repeated a cursor");
      const identified = identify(job, page.items);
      const existing = identified.rows.length
        ? await db.rows<{ record_key: string }>(
            `SELECT record_key FROM ${t("records")} WHERE address=? AND kind=? AND record_key IN (${identified.rows.map(() => "?").join(",")})`,
            [job.address, job.kind, ...identified.rows.map((r) => r.key)],
          )
        : [];
      const known = new Set(existing.map((r) => r.record_key));
      const lastTime = identified.rows.at(-1)?.at;
      // Finish the overlapping timestamp group before stopping. Identical
      // cashflows may straddle pages; stopping at the first match loses copies.
      const overlap =
        job.state.phase === "head" &&
        identified.rows.some(
          (r) => known.has(r.key) && lastTime !== undefined && r.at > lastTime,
        );
      const done = page.nextCursor === null || overlap;
      const tracked = new Set(job.state.targets ?? []);
      const pendingRows = identified.rows.filter(
        ({ payload: r }) =>
          r.kind === "Withdrawal" &&
          r.withdrawalStatus != null &&
          r.withdrawalStatus !== "settled" &&
          r.withdrawalStatus !== "failed",
      );
      // Resolve only observations explicitly returned in a terminal state.
      // Missing targets remain unresolved; newly pending rows join the task.
      for (const row of identified.rows)
        if (
          row.payload.withdrawalStatus === "settled" ||
          row.payload.withdrawalStatus === "failed"
        )
          tracked.delete(row.key);
      for (const row of pendingRows) tracked.add(row.key);
      const missingTargets =
        pendingCorrection &&
        [...tracked].some((key) => !identified.rows.some((r) => r.key === key));
      const state: JobState = {
        ...job.state,
        cursor: done ? null : page.nextCursor,
        complete: job.state.complete || page.nextCursor === null,
        phase: done ? "head" : job.state.phase,
        cycle: done ? randomUUID() : job.state.cycle,
        pages: job.state.pages + 1,
        failures: 0,
        lastSuccessAt: at,
        error: undefined,
        carryTime: done ? undefined : identified.carryTime,
        occurrences: done ? undefined : identified.occurrences,
      };
      const statements: Statement[] = [
        checkpoint(
          job,
          pendingCorrection
            ? {
                ...job.state,
                failures: missingTargets ? job.state.failures + 1 : 0,
                error: missingTargets
                  ? "Pending withdrawal page no longer contains every tracked observation; reconciliation is unresolved."
                  : undefined,
                lastSuccessAt: at,
                targets: [...tracked],
              }
            : state,
          at,
          pendingCorrection
            ? at + (missingTargets ? 3600000 : 300000)
            : done
              ? at + refreshMs
              : at + 1000,
        ),
      ];
      for (const row of identified.rows) {
        statements.push({
          sql: `INSERT INTO ${t("records")} VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(address,kind,record_key) DO UPDATE SET source_at=excluded.source_at,payload=excluded.payload,payload_hash=excluded.payload_hash,ambiguous=excluded.ambiguous,received_at=excluded.received_at WHERE ${t("records")}.received_at<=excluded.received_at`,
          params: [
            job.address,
            job.kind,
            row.key,
            row.at,
            JSON.stringify(row.payload),
            row.hash,
            row.ambiguous ? 1 : 0,
            at,
          ],
        });
        if (job.kind === "trades")
          statements.push(
            enqueuePositionMetrics(db.prefix, job.address, row.key),
          );
      }
      statements.push({
        sql: `INSERT INTO ${t("pages")} VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
        params: [
          digest([job.address, job.kind, job.state.cursor, page]),
          job.address,
          job.kind,
          job.state.cursor,
          JSON.stringify(page),
          at,
        ],
      });
      if (!pendingCorrection) {
        if (done)
          statements.push({
            sql: `DELETE FROM ${t("visits")} WHERE address=? AND kind=? AND cycle=?`,
            params: [job.address, job.kind, job.state.cycle],
          });
        else
          statements.push({
            sql: `INSERT INTO ${t("visits")} VALUES(?,?,?,?) ON CONFLICT DO NOTHING`,
            params: [
              job.address,
              job.kind,
              job.state.cycle,
              digest(job.state.cursor),
            ],
          });
      }
      if (!job.correctionId) {
        const headId = `head:${job.address}:${job.kind}`;
        if (!done && !job.state.complete)
          statements.push({
            sql: `INSERT INTO ${t("corrections")} (id,address,state,next_run,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
            params: [
              headId,
              job.address,
              JSON.stringify({
                ...freshState(),
                phase: "head",
                purpose: "head",
                jobKind: job.kind,
              }),
              at + refreshMs,
              at,
            ],
          });
        if (done)
          statements.push({
            sql: `DELETE FROM ${t("corrections")} WHERE id=?`,
            params: [headId],
          });
      }
      if (job.kind === "cashflows") {
        const pending = pendingRows.length > 0;
        const correctionId = pendingCorrection
          ? job.correctionId!
          : digest([job.address, job.state.cursor]);
        if (pending && !pendingCorrection)
          statements.push({
            sql: `INSERT INTO ${t("corrections")} (id,address,state,next_run,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
            params: [
              correctionId,
              job.address,
              JSON.stringify({
                ...job.state,
                purpose: "pending",
                jobKind: "cashflows",
                targets: pendingRows.map((r) => r.key),
              }),
              at + 300000,
              at,
            ],
          });
        if (tracked.size === 0 && pendingCorrection)
          statements.push({
            sql: `DELETE FROM ${t("corrections")} WHERE id=?`,
            params: [correctionId],
          });
      }
      await db.batch(statements);
    },
    async commitPortfolio(job, value, range, at, refreshMs) {
      if (job.kind !== "portfolio")
        throw new Error("Wrong job kind for portfolio");
      const prior = job.state.portfolio;
      const source = value.source;
      const previousSource = prior?.source;
      const generationChanged =
        source &&
        previousSource &&
        source.generation !== previousSource.generation;
      if (source && previousSource && !generationChanged) {
        const newer = source.revision.split(":").map(BigInt),
          older = previousSource.revision.split(":").map(BigInt);
        if (
          source.asOfMs < previousSource.asOfMs ||
          newer[0] < older[0] ||
          newer[1] < older[1]
        )
          throw new Error("Portfolio source revision moved backward");
      }
      const first = value.timeOffsetsMs.length
        ? value.baseTimeMs + value.timeOffsetsMs[0]
        : null;
      const last = value.timeOffsetsMs.length
        ? value.baseTimeMs + value.timeOffsetsMs.at(-1)!
        : null;
      const full = range === "all";
      const state: JobState = {
        ...job.state,
        complete: full || (job.state.complete && !generationChanged),
        phase: "head",
        pages: job.state.pages + 1,
        lastSuccessAt: at,
        failures: 0,
        error: undefined,
        portfolio: {
          fullFetchedAt: full ? at : (prior?.fullFetchedAt ?? 0),
          sourceComplete: full
            ? value.coverage.complete
            : (prior?.sourceComplete ?? false),
          gap: full
            ? !value.coverage.complete
            : Boolean(generationChanged) ||
              (prior?.gap ?? true) ||
              (prior?.availableToMs != null &&
                first !== null &&
                first > prior.availableToMs),
          availableToMs:
            value.coverage.availableToMs ??
            last ??
            prior?.availableToMs ??
            null,
          range,
          source,
        },
      };
      const gaps = new Set(value.gapIndices);
      const statements: Statement[] = [
        checkpoint(
          job,
          state,
          at,
          generationChanged && !full ? at + 1000 : at + refreshMs,
        ),
      ];
      statements.push({
        sql: `INSERT INTO ${t("portfolio_batches")} VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
        params: [
          digest([job.address, range, value]),
          job.address,
          range,
          JSON.stringify(value),
          at,
        ],
      });
      // Projection replacement is safe because every source batch above remains
      // durable, including removed/corrected points and repeated timestamps.
      if (generationChanged)
        statements.push({
          sql: `DELETE FROM ${t("points")} WHERE scope=?`,
          params: [job.address],
        });
      else if (
        (value.fromMs ?? first) !== null &&
        (value.toMs ?? last) !== null
      )
        statements.push({
          sql: `DELETE FROM ${t("points")} WHERE scope=? AND time>=? AND time<=?`,
          params: [job.address, value.fromMs ?? first, value.toMs ?? last],
        });
      const groups = new Map<
        number,
        { equity: number; pnl: number; gap: boolean }[]
      >();
      value.timeOffsetsMs.forEach((offset, i) => {
        const time = value.baseTimeMs + offset;
        const samples = groups.get(time) ?? [];
        samples.push({
          equity: value.columns.equity[i],
          pnl: value.columns.pnl[i],
          gap: gaps.has(i),
        });
        groups.set(time, samples);
      });
      for (const [time, samples] of groups)
        statements.push(point(job.address, time, { samples }, at));
      await db.batch(statements);
    },
    async failJob(job, error, at, retryAt, resetCursor = false) {
      const failures = job.state.failures + 1;
      const state = {
        ...job.state,
        failures,
        error: error.slice(0, 500),
        ...(resetCursor && job.state.purpose !== "pending"
          ? {
              cursor: null,
              phase: "backfill" as const,
              complete: false,
              cycle: randomUUID(),
              carryTime: undefined,
              occurrences: undefined,
            }
          : {}),
      };
      try {
        await db.batch([
          checkpoint(
            job,
            state,
            at,
            Math.max(
              retryAt ?? 0,
              at + Math.min(3600000, 30000 * 2 ** Math.min(failures - 1, 7)),
            ),
          ),
        ]);
      } catch (e) {
        if (!(e instanceof Error && e.message === "History job lease changed"))
          throw e;
      }
    },
    async readPage<T>(
      address: string,
      kind: LedgerKind,
      cursor?: string,
      limit = 75,
    ): Promise<RetainedHistoryPage<T>> {
      address = addressSchema.parse(address);
      limit = Math.max(1, Math.min(200, limit));
      const after = cursor ? decodeCursor(cursor) : null;
      const rows = await db.rows<{
        record_key: string;
        payload: unknown;
        source_at: string | number;
      }>(
        `SELECT record_key,payload,source_at FROM ${t("records")} WHERE address=? AND kind=? ${after ? "AND (source_at<? OR (source_at=? AND record_key<?))" : ""} ORDER BY source_at DESC,record_key DESC LIMIT ?`,
        [
          address,
          kind,
          ...(after ? [after[0], after[0], after[1]] : []),
          limit + 1,
        ],
      );
      const counts = await db.rows<{
        count: string | number;
        ambiguous: string | number | null;
      }>(
        `SELECT count(*) AS count,max(ambiguous) AS ambiguous FROM (SELECT ambiguous FROM ${t("records")} WHERE address=? AND kind=? LIMIT 10001) bounded`,
        [address, kind],
      );
      const state = (await status(address)).find((j) => j.kind === kind)?.state;
      const errors = await db.rows<{ state: unknown }>(
        `SELECT state FROM ${t("corrections")} WHERE address=? AND ${db.prefix ? "(state->>'failures')::integer" : "json_extract(state,'$.failures')"}>0 ORDER BY updated_at DESC LIMIT 5`,
        [address],
      );
      const coverageState = errors.length
        ? {
            ...(state ?? freshState()),
            error: [
              state?.error,
              ...errors.map((r) => parsed<JobState>(r.state).error),
            ]
              .filter(Boolean)
              .join(" "),
          }
        : state;
      const page = rows.slice(0, limit);
      return {
        items: page.map(
          (r) =>
            ({
              ...parsed<Record<string, unknown>>(r.payload),
              id: r.record_key,
            }) as T,
        ),
        nextCursor:
          rows.length > limit
            ? localCursor(
                Number(page.at(-1)!.source_at),
                page.at(-1)!.record_key,
              )
            : null,
        receivedAt: state?.lastSuccessAt ?? null,
        stale:
          !state?.lastSuccessAt || Date.now() - state.lastSuccessAt > 300000,
        coverage: {
          ...coverage(
            coverageState,
            Number(counts[0].count),
            Number(counts[0].ambiguous ?? 0) > 0 ||
              Number(counts[0].count) === 10001,
          ),
          retainedCountCapped: Number(counts[0].count) === 10001,
        },
      };
    },
    async readPortfolio(address) {
      address = addressSchema.parse(address);
      const state = (await status(address)).find(
        (j) => j.kind === "portfolio",
      )?.state;
      if (!state?.lastSuccessAt) return null;
      const rows = (
        await db.rows<{ time: string | number; payload: unknown }>(
          `SELECT time,payload FROM ${t("points")} WHERE scope=? ORDER BY time DESC LIMIT 10000`,
          [address],
        )
      ).reverse();
      const [{ count }] = await db.rows<{ count: string | number }>(
        `SELECT count(*) AS count FROM (SELECT 1 FROM ${t("points")} WHERE scope=? LIMIT 10001) bounded`,
        [address],
      );
      const points = rows.flatMap((r) =>
        parsed<{ samples: { equity: number; pnl: number; gap: boolean }[] }>(
          r.payload,
        ).samples.map((p) => ({ time: Number(r.time), ...p })),
      );
      const baseTimeMs = points[0]?.time ?? 0;
      return {
        receivedAt: state.lastSuccessAt,
        coverage: {
          ...coverage(state, Number(count), false),
          retainedCountCapped: Number(count) === 10001,
        },
        value: {
          baseTimeMs,
          timeOffsetsMs: points.map((p) => p.time - baseTimeMs),
          columns: {
            equity: points.map((p) => p.equity),
            pnl: points.map((p) => p.pnl),
          },
          gapIndices: points.flatMap((p, i) => (p.gap ? [i] : [])),
          coverage: {
            availableFromMs: points[0]?.time ?? null,
            availableToMs: points.at(-1)?.time ?? null,
            complete: Boolean(
              state.portfolio?.sourceComplete &&
              !state.portfolio?.gap &&
              Number(count) <= 10000,
            ),
          },
        },
      };
    },
    getStatus: status,
    async stats() {
      const at = Date.now();
      const [wallets] = await db.rows<{ count: string | number }>(
        `SELECT count(*) AS count FROM ${t("wallets")}`,
      );
      const [jobs] = await db.rows<{
        count: string | number;
        pending: string | number;
        oldest: string | number | null;
      }>(
        `SELECT count(*) AS count,sum(CASE WHEN next_run<=? THEN 1 ELSE 0 END) AS pending,min(CASE WHEN next_run<=? THEN next_run ELSE NULL END) AS oldest FROM ${t("jobs")}`,
        [at, at],
      );
      // Error counters live in status JSON; no unbounded JSON scan on readiness.
      const failureExpr = db.prefix
        ? "(state->>'failures')::integer"
        : "json_extract(state,'$.failures')";
      const completeExpr = db.prefix
        ? "(state->>'complete')::boolean=true"
        : "json_extract(state,'$.complete')=1";
      const purposeExpr = db.prefix
        ? "state->>'purpose'"
        : "json_extract(state,'$.purpose')";
      const [failed] = await db.rows<{ count: string | number }>(
        `SELECT count(*) AS count FROM ${t("jobs")} WHERE ${failureExpr}>0`,
      );
      const [complete] = await db.rows<{ count: string | number }>(
        `SELECT count(*) AS count FROM ${t("jobs")} WHERE ${completeExpr}`,
      );
      const [corrections] = await db.rows<{
        count: string | number;
        pending: string | number;
        failed: string | number;
        unresolved: string | number;
      }>(
        `SELECT count(*) AS count,sum(CASE WHEN next_run<=? THEN 1 ELSE 0 END) AS pending,sum(CASE WHEN ${failureExpr}>0 THEN 1 ELSE 0 END) AS failed,sum(CASE WHEN ${purposeExpr}='pending' THEN 1 ELSE 0 END) AS unresolved FROM ${t("corrections")}`,
        [at],
      );
      return {
        wallets: Number(wallets.count),
        jobs: Number(jobs.count) + Number(corrections.count),
        pending: Number(jobs.pending ?? 0) + Number(corrections.pending ?? 0),
        failed: Number(failed.count) + Number(corrections.failed ?? 0),
        oldestDueAt: jobs.oldest === null ? null : Number(jobs.oldest),
        backfillComplete: Number(complete.count),
        pendingCorrections: Number(corrections.unresolved ?? 0),
      };
    },
    async retainProtocol(points, at = Date.now()) {
      if (points.length)
        await db.batch(
          points.map((p) =>
            point("protocol:tvl", p.time, { value: p.value }, at),
          ),
        );
    },
    async protocolPoints(limit = 1440) {
      return (
        await db.rows<{ time: string | number; payload: unknown }>(
          `SELECT time,payload FROM ${t("points")} WHERE scope='protocol:tvl' ORDER BY time DESC LIMIT ?`,
          [Math.max(1, Math.min(10000, limit))],
        )
      )
        .reverse()
        .map((r) => ({
          time: Number(r.time),
          value: parsed<{ value: number }>(r.payload).value,
        }));
    },
    async retainProtocolCharts(source, rows) {
      if (!["summary", "history"].includes(source) || rows.length > 170)
        throw new Error("Invalid protocol chart batch");
      for (const row of rows)
        if (
          !Number.isSafeInteger(row.time) ||
          row.time < 0 ||
          row.time % 3600000 ||
          !Number.isSafeInteger(row.sourceAt) ||
          row.sourceAt < row.time ||
          !Number.isSafeInteger(row.endpointAt) ||
          row.endpointAt < row.time ||
          row.endpointAt > row.sourceAt ||
          row.endpointAt >= row.time + 3600000 ||
          typeof row.generation !== "string" ||
          row.generation.length > 256 ||
          [
            row.paperSupplyRaw,
            row.paperStakedRaw,
            row.allocatedRewardsRaw,
          ].some(
            (raw) =>
              raw !== undefined &&
              (typeof raw !== "string" ||
                raw.length > 78 ||
                !/^(0|[1-9]\d*)$/.test(raw)),
          ) ||
          Object.values(row.values).some(
            (v) => v !== null && (!Number.isFinite(v) || v < 0),
          )
        )
          throw new Error("Invalid protocol chart observation");
      if (rows.length)
        await db.batch(
          rows.map((row) =>
            point(`protocol:chart:${source}`, row.time, row, row.sourceAt),
          ),
        );
    },
    async protocolChartRows(source, limit = 170) {
      if (!["summary", "history"].includes(source))
        throw new Error("Invalid protocol chart source");
      return (
        await db.rows<{ payload: unknown }>(
          `SELECT payload FROM ${t("points")} WHERE scope=? ORDER BY time DESC LIMIT ?`,
          [
            `protocol:chart:${source}`,
            Math.max(1, Math.min(170, Math.floor(limit))),
          ],
        )
      )
        .reverse()
        .map((row) => parsed<ProtocolChartObservation>(row.payload));
    },
  };
  return api;
}
