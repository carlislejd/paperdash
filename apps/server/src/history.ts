import { z } from "zod";
import {
  cashflowSchema,
  closedTradeSchema,
  historySchema,
  portfolioSchema,
} from "./schemas.js";
import type { HistoryJob, HistoryLane, HistoryStore } from "./history-store.js";

export type HistoryLoader = <T>(
  path: string,
  schema: z.ZodType<T>,
) => Promise<T>;
function path(base: string, params: Record<string, string | number | null>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== null) query.set(key, String(value));
  query.sort();
  return `${base}?${query}`;
}
/** Each request advances one durable job. No visitor triggers a history fetch. */
export class HistoryIndexer {
  private running = false;
  private lane = 0;
  private retryAt = 0;
  constructor(
    private store: HistoryStore,
    private load: HistoryLoader,
    private now = Date.now,
  ) {}
  async tick(
    options: {
      maxRequests?: number;
      sourceConcurrency?: number;
      shouldStop?: () => boolean;
    } = {},
  ): Promise<number> {
    const canClaim = () =>
      !options.shouldStop?.() && this.now() >= this.retryAt;
    if (this.running || !canClaim()) return 0;
    this.running = true;
    let requests = 0;
    const limit = Math.max(1, Math.min(10, options.maxRequests ?? 2));
    // Leave source capacity for global/foreground reads. The shared request
    // gate still owns admission and spacing across every API and collector.
    const width = Math.min(
      2,
      Math.max(1, (options.sourceConcurrency ?? 3) - 1),
    );
    // Reserve one turn for viewed ledger heads, one for all active heads,
    // and two for all active work. The viewed turn borrows active heads first.
    // Empty backfill/retry turns borrow general active work before maintenance;
    // the explicit fair turn still serves older inactive jobs.
    const lanes: readonly HistoryLane[] = [
      "viewed-head",
      "backfill",
      "active",
      "retry",
      "active-head",
      "backfill",
      "active",
      "fair",
    ];
    try {
      while (requests < limit && canClaim()) {
        const jobs: HistoryJob[] = [];
        let claimFailed = false;
        let claimError: unknown;
        // Claim in order before starting a bounded chunk. A wallet's primary
        // and correction jobs must never fetch/commit the same ledger at once.
        while (jobs.length < width && requests < limit && canClaim()) {
          try {
            const job = await this.store.claimJob(
              this.now(),
              120000,
              lanes[this.lane],
              jobs.map(({ address, kind }) => ({ address, kind })),
            );
            if (!job) break;
            jobs.push(job);
            requests++;
            this.lane = (this.lane + 1) % lanes.length;
          } catch (error) {
            claimFailed = true;
            claimError = error;
            break;
          }
        }
        // Do not refill as individual jobs finish. In particular, a database
        // failure in failJob must not return early while a sibling still writes.
        const results = await Promise.allSettled(
          jobs.map((job) => this.runJob(job)),
        );
        if (claimFailed) throw claimError;
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        if (!jobs.length) break;
      }
      return requests;
    } finally {
      this.running = false;
    }
  }
  private async runJob(job: HistoryJob): Promise<void> {
    try {
      await this.run(job);
    } catch (error) {
      const e = error as {
        message?: string;
        status?: number;
        retryAt?: number;
      };
      if (e.status === 429)
        this.retryAt = Math.max(
          this.retryAt,
          Number.isFinite(e.retryAt) && e.retryAt! > this.now()
            ? e.retryAt!
            : this.now() + 5000,
        );
      await this.store.failJob(
        job,
        e.message ?? "History indexing failed",
        this.now(),
        e.retryAt,
        job.state.cursor !== null &&
          (e.status === 400 ||
            e.status === 404 ||
            /repeated a cursor/.test(e.message ?? "")),
      );
    }
  }
  private async run(job: HistoryJob) {
    if (job.kind === "portfolio") {
      const age = this.now() - (job.state.lastSuccessAt ?? 0);
      const fullAge = this.now() - (job.state.portfolio?.fullFetchedAt ?? 0);
      // There is no verified since filter. Retain the baseline, refresh a small
      // supported window, and expand after outages. Weekly full reconciliation
      // catches older upstream corrections without per-visitor full downloads.
      const range =
        !job.state.complete || fullAge > 7 * 86400000 || age > 6 * 86400000
          ? "all"
          : age > 20 * 3600000
            ? "1w"
            : "1d";
      const value = await this.load(
        path(`/query/accounts/${job.address}/portfolio-history`, { range }),
        portfolioSchema,
      );
      await this.store.commitPortfolio(
        job,
        value,
        range,
        this.now(),
        job.priority > 0 ? 300000 : 86400000,
        { adaptive: true },
      );
    } else {
      const value = await this.load(
        path(`/query/accounts/${job.address}/${job.kind}`, {
          cursor: job.state.cursor,
          limit: 75,
          ...(job.kind === "trades" ? { filter: "all" } : {}),
        }),
        historySchema(
          job.kind === "cashflows" ? cashflowSchema : closedTradeSchema,
        ),
      );
      await this.store.commitPage(
        job,
        value,
        this.now(),
        job.priority > 0 ? 60000 : 6 * 3600000,
        { adaptive: true },
      );
    }
  }
}
