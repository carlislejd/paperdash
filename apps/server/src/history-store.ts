import { randomUUID } from "node:crypto";
import type {
  HistoryPage,
  PortfolioHistory,
  ProtocolChartMetric,
} from "../../../packages/shared/src/types.js";
import { addressSchema, digest } from "./schemas.js";
import { enqueuePositionMetrics } from "./position-metrics-store.js";
import { enqueueDepositMetrics } from "./deposit-metrics-store.js";
import {
  boundedPortfolioGaps,
  crossesPortfolioGap,
  portfolioLocalGaps,
  type PortfolioGap,
} from "./portfolio-history-policy.js";

export type LedgerKind = "cashflows" | "trades";
export type JobKind = LedgerKind | "portfolio";
export type HistoryLane = "viewed-head" | "active-head" | "active-portfolio" | "active" | "backfill" | "retry" | "fair";
export interface HistoryScheduleOptions {
  /** Apply the collector's adaptive cadence; explicit callers retain refreshMs. */
  adaptive?: boolean;
}
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
  /** Completed unchanged head cycles, capped at two; never a backfill counter. */
  unchangedCycles?: number;
  /** A change anywhere in a multi-page head cycle prevents slowing its cadence. */
  cycleChanged?: boolean;
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
    /** Canonical bounded missing intervals; unrelated to source incomplete flags. */
    localGaps?: PortfolioGap[];
    /** Derived earliest interval boundary; retained for older-reader compatibility. */
    localGapAfterMs?: number | null;
    /** Last successful 1w/all repair; bounds repeated broad source reads. */
    repairFetchedAt?: number;
    range: string;
    source?: { asOfMs: number; revision: string; generation: string };
    /** Last applied projection only; older retained batches may have been superseded. */
    projectionDigest?: string;
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
export interface ActiveHistoryFreshness {
  asOf: number;
  /** Successful primary-job checks for currently active wallets, not event age or time waiting after activation. */
  byKind: {
    kind: JobKind;
    jobs: number;
    never: number;
    invalidClock: number;
    futureClock: number;
    within1m: number;
    oneTo5m: number;
    fiveTo15m: number;
    fifteenTo60m: number;
    over60m: number;
    oldestSuccessAt: number | null;
  }[];
}
export interface HistoryStore {
  ensureWallet(address: string, priority?: number): Promise<void>;
  discoverWallets(addresses: string[], priority?: number): Promise<void>;
  claimJob(
    now?: number,
    leaseMs?: number,
    lane?: HistoryLane,
    exclude?: readonly { address: string; kind: JobKind }[],
  ): Promise<HistoryJob | null>;
  commitPage(
    job: HistoryJob,
    page: HistoryPage<Record<string, unknown>>,
    at: number,
    refreshMs: number,
    options?: HistoryScheduleOptions,
  ): Promise<void>;
  commitPortfolio(
    job: HistoryJob,
    value: SourcePortfolio,
    range: string,
    at: number,
    refreshMs: number,
    options?: HistoryScheduleOptions,
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
    /** Disjoint due counts, including leased work, whose sum equals pending. */
    activeDue: number;
    backfillDue: number;
    maintenanceDue: number;
    correctionsDue: number;
    oldestActiveDueAt: number | null;
    oldestBackfillDueAt: number | null;
    activeFreshness: ActiveHistoryFreshness;
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
  const failed = postgres
    ? "(state->>'failures')::integer>0"
    : "json_extract(state,'$.failures')>0";
  return `
CREATE TABLE IF NOT EXISTS ${prefix}history_wallets(address TEXT PRIMARY KEY,priority INTEGER NOT NULL,active_until ${int} NOT NULL,last_seen ${int} NOT NULL);
CREATE TABLE IF NOT EXISTS ${prefix}history_jobs(address TEXT NOT NULL,kind TEXT NOT NULL,state ${json} NOT NULL,next_run ${int} NOT NULL,locked_until ${int} NOT NULL DEFAULT 0,token TEXT,updated_at ${int} NOT NULL,PRIMARY KEY(address,kind));
CREATE INDEX IF NOT EXISTS ${prefix}history_jobs_due ON ${prefix}history_jobs(next_run,locked_until);
CREATE INDEX IF NOT EXISTS ${prefix}history_jobs_retry_due ON ${prefix}history_jobs(next_run,locked_until) WHERE ${failed};
CREATE TABLE IF NOT EXISTS ${prefix}history_records(address TEXT NOT NULL,kind TEXT NOT NULL,record_key TEXT NOT NULL,source_at ${int} NOT NULL,payload ${json} NOT NULL,payload_hash TEXT NOT NULL,ambiguous INTEGER NOT NULL,received_at ${int} NOT NULL,PRIMARY KEY(address,kind,record_key));
CREATE INDEX IF NOT EXISTS ${prefix}history_records_page ON ${prefix}history_records(address,kind,source_at DESC,record_key DESC);
CREATE TABLE IF NOT EXISTS ${prefix}history_pages(id TEXT PRIMARY KEY,address TEXT NOT NULL,kind TEXT NOT NULL,cursor TEXT,payload ${json} NOT NULL,received_at ${int} NOT NULL);
CREATE TABLE IF NOT EXISTS ${prefix}history_visits(address TEXT NOT NULL,kind TEXT NOT NULL,cycle TEXT NOT NULL,cursor_hash TEXT NOT NULL,PRIMARY KEY(address,kind,cycle,cursor_hash));
CREATE TABLE IF NOT EXISTS ${prefix}history_points(scope TEXT NOT NULL,time ${int} NOT NULL,payload ${json} NOT NULL,received_at ${int} NOT NULL,PRIMARY KEY(scope,time));
CREATE TABLE IF NOT EXISTS ${prefix}history_portfolio_batches(id TEXT PRIMARY KEY,address TEXT NOT NULL,range_name TEXT NOT NULL,payload ${json} NOT NULL,received_at ${int} NOT NULL);
CREATE TABLE IF NOT EXISTS ${prefix}history_corrections(id TEXT PRIMARY KEY,address TEXT NOT NULL,state ${json} NOT NULL,next_run ${int} NOT NULL,locked_until ${int} NOT NULL DEFAULT 0,token TEXT,updated_at ${int} NOT NULL);
CREATE INDEX IF NOT EXISTS ${prefix}history_corrections_due ON ${prefix}history_corrections(next_run,locked_until);
CREATE INDEX IF NOT EXISTS ${prefix}history_corrections_retry_due ON ${prefix}history_corrections(next_run,locked_until) WHERE ${failed};
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
    activeRefreshMs?: number,
  ): Statement {
    const table = job.correctionId ? t("corrections") : t("jobs");
    const active = `EXISTS (SELECT 1 FROM ${t("wallets")} w WHERE w.address=${table}.address AND w.active_until>? AND w.priority>0)`;
    const jsonParam = db.prefix ? "CAST(? AS jsonb)" : "?";
    const timeParam = db.prefix ? "CAST(? AS bigint)" : "?";
    const stateSql = activeRefreshMs
      ? `CASE WHEN ${active} THEN ${jsonParam} ELSE ${jsonParam} END`
      : "?";
    const stateParams = activeRefreshMs
      ? [at, JSON.stringify({ ...state, unchangedCycles: 0 }), JSON.stringify(state)]
      : [JSON.stringify(state)];
    const activeAt = at + (activeRefreshMs ?? 0);
    const nextSql = activeRefreshMs
      ? `CASE WHEN ${active} AND ${timeParam}>${timeParam} THEN ${timeParam} ELSE ${timeParam} END`
      : "?";
    const nextParams = activeRefreshMs
      ? [at, nextRun, activeAt, activeAt, nextRun]
      : [nextRun];
    if (job.correctionId)
      return {
        sql: `UPDATE ${t("corrections")} SET state=${stateSql},next_run=${nextSql},locked_until=0,token=NULL,updated_at=? WHERE id=? AND token=? AND locked_until>?`,
        params: [
          ...stateParams,
          ...nextParams,
          at,
          job.correctionId,
          job.token,
          at,
        ],
        requireChanges: 1,
      };
    return {
      sql: `UPDATE ${t("jobs")} SET state=${stateSql},next_run=${nextSql},locked_until=0,token=NULL,updated_at=? WHERE address=? AND kind=? AND token=? AND locked_until>?`,
      params: [
        ...stateParams,
        ...nextParams,
        at,
        job.address,
        job.kind,
        job.token,
        at,
      ],
      requireChanges: 1,
    };
  }
  function activityLock(address: string): Statement {
    // Discovery takes this row first too. Serialize activation and checkpoint
    // so a signal during an in-flight request cannot leave a cold 24h schedule.
    return {
      sql: `UPDATE ${t("wallets")} SET priority=priority WHERE address=?`,
      params: [address],
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
      priority = Math.max(0, Math.min(30, Math.floor(priority)));
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
          if (priority > 0) {
            const cadence = kind === "portfolio" ? 300000 : 60000;
            statements.push({
              sql: `UPDATE ${t("jobs")} SET next_run=CASE WHEN updated_at+?>? THEN updated_at+? ELSE ? END WHERE address=? AND kind=? AND next_run>? AND next_run>updated_at+? AND locked_until<=? AND ${db.prefix ? "(state->>'failures')::integer" : "json_extract(state,'$.failures')"}=0`,
              params: [
                cadence,
                at,
                cadence,
                at,
                address,
                kind,
                at,
                cadence,
                at,
              ],
            });
          }
        }
        if (priority > 0)
          statements.push({
            sql: `UPDATE ${t("corrections")} SET next_run=CASE WHEN updated_at+60000>? THEN updated_at+60000 ELSE ? END WHERE address=? AND id LIKE 'head:%' AND next_run>? AND next_run>updated_at+60000 AND locked_until<=? AND ${db.prefix ? "(state->>'failures')::integer" : "json_extract(state,'$.failures')"}=0`,
            params: [at, at, address, at, at],
          });
      }
      if (statements.length) await db.batch(statements);
    },
    async claimJob(now = Date.now(), leaseMs = 120000, lane = "fair", exclude = []) {
      // Claims are sequential within a collector batch. Exclude every ledger
      // already claimed for that batch, including its independent corrections.
      const incomplete = db.prefix
        ? "((j.state->>'complete')::boolean=false OR j.state->>'cursor' IS NOT NULL)"
        : "(json_extract(j.state,'$.complete')=0 OR json_extract(j.state,'$.cursor') IS NOT NULL)";
      const excluded = (address: string, kind: string) => exclude.length
        ? `AND NOT (${exclude.map(() => `(${address}=? AND ${kind}=?)`).join(" OR ")})`
        : "";
      const excludedParams = exclude.flatMap(({ address, kind }) => [address, kind]);
      const correctionKind = db.prefix
        ? "COALESCE(c.state->>'jobKind','cashflows')"
        : "COALESCE(json_extract(c.state,'$.jobKind'),'cashflows')";
      const failed = (alias: string) => db.prefix
        ? `(${alias}.state->>'failures')::integer>0`
        : `json_extract(${alias}.state,'$.failures')>0`;
      const head = lane === "active-head" || lane === "viewed-head";
      const portfolio = lane === "active-portfolio";
      const active = lane === "active" || head || portfolio;
      const activePriority = lane === "viewed-head" ? "w.priority>=30" : "w.priority>0";
      const cursorIsNull = (alias: string) => db.prefix
        ? `${alias}.state->>'cursor' IS NULL`
        : `json_extract(${alias}.state,'$.cursor') IS NULL`;
      const correctionIsHead = db.prefix
        ? "c.state->>'purpose'='head'"
        : "json_extract(c.state,'$.purpose')='head'";
      const candidates = await db.rows<{
        address: string;
        kind: JobKind;
        state: unknown;
        next_run: string | number;
        priority: number;
      }>(
        `SELECT j.address,j.kind,j.state,j.next_run,CASE WHEN w.active_until>? THEN w.priority ELSE 0 END AS priority FROM ${t("jobs")} j JOIN ${t("wallets")} w ON w.address=j.address WHERE j.next_run<=? AND j.locked_until<=? ${active ? `AND w.active_until>? AND ${activePriority}` : lane === "backfill" ? `AND ${incomplete}` : lane === "retry" ? `AND ${failed("j")}` : ""} ${head ? `AND j.kind<>'portfolio' AND ${cursorIsNull("j")}` : portfolio ? "AND j.kind='portfolio'" : ""} ${excluded("j.address", "j.kind")} ORDER BY j.next_run,j.address,j.kind LIMIT 8`,
        [now, now, now, ...(active ? [now] : []), ...excludedParams],
      );
      // These reserved lanes cannot select corrections. Avoid the database
      // round trip; an empty lane still checks them in its general-active fallback.
      const corrections = portfolio || lane === "backfill" ? [] : await db.rows<{
        id: string;
        address: string;
        state: unknown;
        next_run: number | string;
      }>(
        `SELECT c.id,c.address,c.state,c.next_run FROM ${t("corrections")} c JOIN ${t("wallets")} w ON w.address=c.address WHERE c.next_run<=? AND c.locked_until<=? ${active ? `AND w.active_until>? AND ${activePriority}` : lane === "retry" ? `AND ${failed("c")}` : ""} ${head ? `AND ${correctionIsHead} AND ${cursorIsNull("c")}` : ""} ${excluded("c.address", correctionKind)} ORDER BY c.next_run,c.id LIMIT 2`,
        [now, now, ...(active ? [now] : []), ...excludedParams],
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
          priority: lane === "viewed-head" ? 30 : active ? 10 : 0,
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
      // Idle reserved turns serve due active work before cold maintenance.
      // The explicit general-active and fair turns still preserve service for
      // portfolios, continuations, pending corrections and inactive wallets.
      return lane === "fair" ? null
        : api.claimJob(now, leaseMs, lane === "viewed-head" ? "active-head" : lane === "active" ? "fair" : "active", exclude);
    },
    async commitPage(job, page, at, refreshMs, options = {}) {
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
        ? await db.rows<{ record_key: string; payload_hash: string }>(
            `SELECT record_key,payload_hash FROM ${t("records")} WHERE address=? AND kind=? AND record_key IN (${identified.rows.map(() => "?").join(",")})`,
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
      const adaptiveHead = options.adaptive && !job.correctionId &&
        job.state.complete && job.state.phase === "head";
      const hashes = new Map(existing.map((r) => [r.record_key, r.payload_hash]));
      const cycleChanged = Boolean(job.state.cycleChanged) ||
        identified.rows.some((r) => hashes.get(r.key) !== r.hash);
      const unchangedCycles = adaptiveHead && done && job.priority <= 0 && !cycleChanged
        ? Math.min(2, (job.state.unchangedCycles ?? 0) + 1)
        : 0;
      const nextRefreshMs = adaptiveHead && done && job.priority <= 0
        ? Math.min(24 * 3600000, refreshMs * 2 ** unchangedCycles)
        : refreshMs;
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
        ...(options.adaptive && !job.correctionId ? {
          unchangedCycles: adaptiveHead && !done && job.priority <= 0
            ? (job.state.unchangedCycles ?? 0)
            : unchangedCycles,
          cycleChanged: adaptiveHead && !done ? cycleChanged : undefined,
        } : {}),
      };
      const statements: Statement[] = [
        ...(options.adaptive && !pendingCorrection ? [activityLock(job.address)] : []),
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
              ? at + nextRefreshMs
              : at + 1000,
          options.adaptive && !pendingCorrection ? 60000 : undefined,
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
        else statements.push(enqueueDepositMetrics(db.prefix, job.address, row.key));
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
        if (!done && !job.state.complete) {
          const timeParam = db.prefix ? "CAST(? AS bigint)" : "?";
          const headNext = options.adaptive
            ? `CASE WHEN EXISTS (SELECT 1 FROM ${t("wallets")} WHERE address=? AND active_until>? AND priority>0) THEN ${timeParam} ELSE ${timeParam} END`
            : "?";
          statements.push({
            sql: `INSERT INTO ${t("corrections")} (id,address,state,next_run,updated_at) VALUES(?,?,?,${headNext},?) ON CONFLICT(id) DO NOTHING`,
            params: [
              headId,
              job.address,
              JSON.stringify({
                ...freshState(),
                phase: "head",
                purpose: "head",
                jobKind: job.kind,
              }),
              ...(options.adaptive
                ? [job.address, at, at + Math.min(refreshMs, 60000), at + refreshMs]
                : [at + refreshMs]),
              at,
            ],
          });
        }
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
    async commitPortfolio(job, value, range, at, refreshMs, options = {}) {
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
      // Portfolio publications contain change samples, not one sample at every
      // covered instant. A quiet window's first change cannot identify a gap.
      // Only trust requested bounds as coverage when the source says complete.
      const sourceFrom =
        value.coverage.availableFromMs ??
        (value.coverage.complete ? (value.fromMs ?? first) : null);
      const sourceTo =
        value.coverage.availableToMs ??
        (value.coverage.complete ? (value.toMs ?? last) : null);
      const availableFrom =
        sourceFrom === null
          ? null
          : Math.max(sourceFrom, value.fromMs ?? sourceFrom);
      const availableTo =
        sourceTo === null
          ? null
          : Math.min(sourceTo, value.toMs ?? sourceTo, source?.asOfMs ?? sourceTo);
      const observedTo = availableTo ?? last;
      const priorGaps = portfolioLocalGaps(prior);
      let localGaps = generationChanged
        ? []
        : priorGaps.filter(
            (gap) =>
              !(availableFrom !== null &&
                availableTo !== null &&
                availableFrom <= gap.afterMs &&
                availableTo >= gap.beforeMs),
          );
      if (!generationChanged) {
        if (
          prior?.availableToMs != null &&
          availableFrom !== null &&
          availableFrom > prior.availableToMs
        )
          localGaps.push({
            afterMs: prior.availableToMs,
            beforeMs: availableFrom,
          });
      }
      localGaps = boundedPortfolioGaps(localGaps);
      const localGapAfterMs = localGaps[0]?.afterMs ?? null;
      // Old checkpoints did not distinguish a local gap from a partial source.
      // Keep an unlocated legacy gap conservative until a full reconciliation.
      const unlocatedGap = Boolean(prior?.gap && priorGaps.length === 0);
      const gaps = new Set(value.gapIndices);
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
      // Source clocks/revisions can advance without changing any projected
      // points. Include all replacement semantics, not just the returned rows:
      // an empty wider window or a generation change can retract old samples.
      const projectionDigest = digest({
        generation: source?.generation,
        availableFrom,
        availableTo,
        inclusiveEnd: value.toMs === undefined,
        points: [...groups],
      });
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
            : !generationChanged &&
              Boolean(prior?.sourceComplete && value.coverage.complete),
          gap:
            (!full && (Boolean(generationChanged) || unlocatedGap)) ||
            localGapAfterMs !== null,
          availableToMs:
            generationChanged
              ? observedTo
              : observedTo === null
                ? (prior?.availableToMs ?? null)
                : Math.max(observedTo, prior?.availableToMs ?? observedTo),
          localGapAfterMs,
          localGaps,
          repairFetchedAt:
            full || range === "1w"
              ? at
              : (prior?.repairFetchedAt ?? prior?.fullFetchedAt ?? 0),
          range,
          source,
          projectionDigest,
        },
      };
      const statements: Statement[] = [
        ...(options.adaptive ? [activityLock(job.address)] : []),
        checkpoint(
          job,
          state,
          at,
          generationChanged && !full ? at + 1000 : at + refreshMs,
          options.adaptive ? 300000 : undefined,
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
      // The digest checkpoints atomically with the projection under the same
      // job fence. Comparing only to the last applied batch also ensures an old
      // response is reapplied after an intervening correction or window change.
      if (generationChanged || prior?.projectionDigest !== projectionDigest) {
        // Projection replacement is safe because every source batch above remains
        // durable, including removed/corrected points and repeated timestamps.
        if (generationChanged)
          statements.push({
            sql: `DELETE FROM ${t("points")} WHERE scope=?`,
            params: [job.address],
          });
        else if (
          availableFrom !== null &&
          availableTo !== null &&
          availableFrom <= availableTo
        )
          statements.push({
            // Explicit source windows are [fromMs,toMs). Legacy point-only batches
            // still replace their final sample inclusively. A partial publication
            // cannot retract previously retained samples outside its available
            // interval; absent partial bounds permit only returned-sample upserts.
            sql: `DELETE FROM ${t("points")} WHERE scope=? AND time>=? AND time${value.toMs === undefined ? "<=" : "<"}?`,
            params: [job.address, availableFrom, availableTo],
          });
        for (const [time, samples] of groups)
          statements.push(point(job.address, time, { samples }, at));
      }
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
      const localGaps = portfolioLocalGaps(state.portfolio);
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
          gapIndices: points.flatMap((p, i) =>
            p.gap ||
            (i > 0 &&
              crossesPortfolioGap(points[i - 1].time, p.time, localGaps))
              ? [i]
              : [],
          ),
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
      const continuing = db.prefix
        ? "((j.state->>'complete')::boolean=false OR j.state->>'cursor' IS NOT NULL)"
        : "(json_extract(j.state,'$.complete')=0 OR json_extract(j.state,'$.cursor') IS NOT NULL)";
      // Active includes both primary and correction jobs. The remaining three
      // categories are inactive: initial/continuing primary work, completed
      // primary maintenance, and corrections. Leased due jobs still count.
      const [due] = await db.rows<{
        active_due: string | number | null;
        backfill_due: string | number | null;
        maintenance_due: string | number | null;
        corrections_due: string | number | null;
        oldest_active: string | number | null;
        oldest_backfill: string | number | null;
      }>(
        `SELECT sum(CASE WHEN active=1 THEN 1 ELSE 0 END) AS active_due,sum(CASE WHEN active=0 AND category='backfill' THEN 1 ELSE 0 END) AS backfill_due,sum(CASE WHEN active=0 AND category='maintenance' THEN 1 ELSE 0 END) AS maintenance_due,sum(CASE WHEN active=0 AND category='correction' THEN 1 ELSE 0 END) AS corrections_due,min(CASE WHEN active=1 THEN next_run ELSE NULL END) AS oldest_active,min(CASE WHEN active=0 AND category='backfill' THEN next_run ELSE NULL END) AS oldest_backfill FROM (SELECT j.next_run,CASE WHEN w.active_until>? AND w.priority>0 THEN 1 ELSE 0 END AS active,CASE WHEN ${continuing} THEN 'backfill' ELSE 'maintenance' END AS category FROM ${t("jobs")} j JOIN ${t("wallets")} w ON w.address=j.address WHERE j.next_run<=? UNION ALL SELECT c.next_run,CASE WHEN w.active_until>? AND w.priority>0 THEN 1 ELSE 0 END AS active,'correction' AS category FROM ${t("corrections")} c JOIN ${t("wallets")} w ON w.address=c.address WHERE c.next_run<=?) due`,
        [at, at, at, at],
      );
      // This runs in the collector's saved status sample, never per viewer.
      // Activation may inherit an old next_run, so measure successful checks
      // separately instead of interpreting oldestActiveDueAt as a wait SLA.
      const successExpr = db.prefix
        ? "CASE WHEN jsonb_typeof(j.state->'lastSuccessAt')='number' THEN (j.state->>'lastSuccessAt')::numeric ELSE NULL END"
        : "CASE WHEN json_type(j.state,'$.lastSuccessAt') IN ('integer','real') THEN json_extract(j.state,'$.lastSuccessAt') ELSE NULL END";
      const neverExpr = db.prefix
        ? "(j.state->'lastSuccessAt' IS NULL OR j.state->'lastSuccessAt'='null'::jsonb)"
        : "(json_type(j.state,'$.lastSuccessAt') IS NULL OR json_type(j.state,'$.lastSuccessAt')='null')";
      const freshnessRows = await db.rows<Record<string, string | number | null>>(
        `SELECT kind,count(*) AS jobs,
          sum(CASE WHEN never=1 THEN 1 ELSE 0 END) AS never,
          sum(CASE WHEN never=0 AND (success IS NULL OR success<=0 OR success<>round(success)) THEN 1 ELSE 0 END) AS invalid_clock,
          sum(CASE WHEN success>? AND success=round(success) THEN 1 ELSE 0 END) AS future_clock,
          sum(CASE WHEN success>? AND success<=? AND success=round(success) THEN 1 ELSE 0 END) AS within_1m,
          sum(CASE WHEN success>? AND success<=? AND success=round(success) THEN 1 ELSE 0 END) AS one_to_5m,
          sum(CASE WHEN success>? AND success<=? AND success=round(success) THEN 1 ELSE 0 END) AS five_to_15m,
          sum(CASE WHEN success>? AND success<=? AND success=round(success) THEN 1 ELSE 0 END) AS fifteen_to_60m,
          sum(CASE WHEN success>0 AND success<=? AND success=round(success) THEN 1 ELSE 0 END) AS over_60m,
          min(CASE WHEN success>0 AND success<=? AND success=round(success) THEN success ELSE NULL END) AS oldest_success
        FROM (SELECT j.kind,${successExpr} AS success,CASE WHEN ${neverExpr} THEN 1 ELSE 0 END AS never
          FROM ${t("jobs")} j JOIN ${t("wallets")} w ON w.address=j.address
          WHERE w.active_until>? AND w.priority>0) checks GROUP BY kind ORDER BY kind`,
        [at, at - 60000, at, at - 300000, at - 60000,
          at - 900000, at - 300000, at - 3600000, at - 900000,
          at - 3600000, at, at],
      );
      return {
        wallets: Number(wallets.count),
        jobs: Number(jobs.count) + Number(corrections.count),
        pending: Number(due.active_due ?? 0) + Number(due.backfill_due ?? 0) +
          Number(due.maintenance_due ?? 0) + Number(due.corrections_due ?? 0),
        failed: Number(failed.count) + Number(corrections.failed ?? 0),
        oldestDueAt: jobs.oldest === null ? null : Number(jobs.oldest),
        backfillComplete: Number(complete.count),
        pendingCorrections: Number(corrections.unresolved ?? 0),
        activeDue: Number(due.active_due ?? 0),
        backfillDue: Number(due.backfill_due ?? 0),
        maintenanceDue: Number(due.maintenance_due ?? 0),
        correctionsDue: Number(due.corrections_due ?? 0),
        oldestActiveDueAt: due.oldest_active === null ? null : Number(due.oldest_active),
        oldestBackfillDueAt: due.oldest_backfill === null ? null : Number(due.oldest_backfill),
        activeFreshness: {
          asOf: at,
          byKind: freshnessRows.map((row) => ({
            kind: row.kind as JobKind,
            jobs: Number(row.jobs),
            never: Number(row.never),
            invalidClock: Number(row.invalid_clock),
            futureClock: Number(row.future_clock),
            within1m: Number(row.within_1m),
            oneTo5m: Number(row.one_to_5m),
            fiveTo15m: Number(row.five_to_15m),
            fifteenTo60m: Number(row.fifteen_to_60m),
            over60m: Number(row.over_60m),
            oldestSuccessAt: row.oldest_success === null ? null : Number(row.oldest_success),
          })),
        },
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
