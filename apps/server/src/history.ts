import { z } from "zod";
import {
  cashflowSchema,
  closedTradeSchema,
  historySchema,
  portfolioSchema,
} from "./schemas.js";
import type { HistoryJob, HistoryStore } from "./history-store.js";

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
  constructor(
    private store: HistoryStore,
    private load: HistoryLoader,
    private now = Date.now,
  ) {}
  async tick(options: { maxRequests?: number } = {}): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let requests = 0;
    try {
      for (
        ;
        requests < Math.max(1, Math.min(10, options.maxRequests ?? 2));
        requests++
      ) {
        const job = await this.store.claimJob(
          this.now(),
          120000,
          this.lane++ % 2 ? "fair" : "active",
        );
        if (!job) break;
        try {
          await this.run(job);
        } catch (error) {
          const e = error as {
            message?: string;
            status?: number;
            retryAt?: number;
          };
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
      return requests;
    } finally {
      this.running = false;
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
      );
    }
  }
}
