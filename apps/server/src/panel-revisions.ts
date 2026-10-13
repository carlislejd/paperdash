import { createHash } from "node:crypto";
import type {
  PanelKey,
  PanelRevisions,
} from "../../../packages/shared/src/types.js";
import type { Store } from "./store.js";

export const PANEL_MANIFEST_KEY = "panel-revisions";
const KEYS: readonly PanelKey[] = [
  "house",
  "protocol-charts",
  "paper-economics",
  "liquidation-stats",
];
const DEPENDENCIES: Record<PanelKey, readonly string[]> = {
  // PAPER summary freshness is published independently by paper-economics.
  house: ["house", "asset-market"],
  "protocol-charts": ["protocol-charts", "summary", "history"],
  "paper-economics": ["protocol-charts", "summary", "history"],
  "liquidation-stats": [
    "liquidations", "liquidations-backfill", "stream", "recent",
  ],
};
export interface PanelPublication {
  key: PanelKey;
  revision: string;
  receivedAt: number;
  sourceAt: number | null;
  stale: boolean;
  /** Earliest expiry of required source receipts and the saved projection. */
  freshUntil: number;
}
type Entry = Omit<PanelPublication, "key">;

/** Embed this revision in the snapshot before writing it, then advertise it. */
export function snapshotPanelRevision(value: object): string {
  // Ignore only projection clocks. Genuine source revisions and all financial
  // values/coverage stay significant; heartbeat age does not alter content.
  const {
    panelRevision: _revision,
    receivedAt: _received,
    windowTo: _window,
    ...content
  } = value as Record<string, unknown>;
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

function validTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
/** Reject unknown versions/keys before advertising push capability during rollout. */
export function validPanelRevisions(value: unknown): value is PanelRevisions {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<PanelRevisions>;
  if (
    manifest.version !== 1 ||
    !validTime(manifest.publishedAt) ||
    !manifest.panels ||
    typeof manifest.panels !== "object" ||
    Array.isArray(manifest.panels)
  ) return false;
  return Object.entries(manifest.panels).every(
    ([key, entry]) =>
      KEYS.includes(key as PanelKey) &&
      !!entry &&
      typeof entry.revision === "string" &&
      entry.revision.length > 0 &&
      entry.revision.length <= 128 &&
      validTime(entry.receivedAt) &&
      (entry.sourceAt === null || validTime(entry.sourceAt)) &&
      typeof entry.stale === "boolean",
  );
}

/** One collector-owned manifest, with bounded entries and no source/DB reads. */
export class PanelPublisher {
  private entries = new Map<PanelKey, Entry>();
  private failures = new Set<string>();
  private streamConnected = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> | null = null;
  private dirty = false;
  private stopped = false;
  constructor(
    private store: Pick<Store, "put" | "event">,
    private notify: () => void,
    private report: (error: unknown | null) => void,
    private now: () => number = Date.now,
  ) {}
  start() {
    if (this.stopped || this.heartbeat) return;
    this.heartbeat = setInterval(() => this.schedule(), 10000);
    this.heartbeat.unref();
  }
  committed(publication: PanelPublication) {
    if (this.stopped) return;
    const previous = this.entries.get(publication.key);
    if (previous && previous.receivedAt > publication.receivedAt) return;
    this.entries.set(publication.key, {
      revision: publication.revision,
      receivedAt: publication.receivedAt,
      sourceAt: publication.sourceAt,
      stale: publication.stale || this.unhealthy(publication.key),
      freshUntil: publication.freshUntil,
    });
    this.dirty = true;
    this.schedule();
  }
  health(errors: ReadonlyMap<string, string>, streamConnected: boolean) {
    this.failures = new Set(errors.keys());
    this.streamConnected = streamConnected;
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (!entry.stale && this.unhealthy(key)) {
        entry.stale = true;
        changed = true;
      }
    }
    // Clearing an error does not freshen old data. Only committed() can do so.
    if (changed) {
      this.dirty = true;
      this.schedule();
    }
  }
  private unhealthy(key: PanelKey) {
    return (
      DEPENDENCIES[key].some((name) => this.failures.has(name)) ||
      (key === "liquidation-stats" && !this.streamConnected)
    );
  }
  private schedule() {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => {});
    }, 1000);
    this.timer.unref();
  }
  flush(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.stopped || !this.entries.size) return Promise.resolve();
    this.dirty = false;
    const run = Promise.resolve().then(async () => {
      const now = this.now();
      const panels: PanelRevisions["panels"] = {};
      for (const [key, entry] of this.entries) {
        const stale =
          entry.stale ||
          now > entry.freshUntil ||
          entry.receivedAt > now + 30000 ||
          (entry.sourceAt !== null && entry.sourceAt > now + 30000);
        // Once expired, only an actual committed publication can recover it.
        if (stale) entry.stale = true;
        panels[key] = {
          revision: entry.revision,
          receivedAt: entry.receivedAt,
          sourceAt: entry.sourceAt,
          stale,
        };
      }
      const manifest: PanelRevisions = { version: 1, publishedAt: now, panels };
      await this.store.put(PANEL_MANIFEST_KEY, manifest, now);
      await this.store.event({ type: "panel-revisions", data: manifest });
      this.notify();
      this.report(null);
    });
    this.pending = run
      .catch((error) => {
        this.dirty = true;
        this.report(error);
        throw error;
      })
      .finally(() => {
        this.pending = null;
        // At most one flush is in flight, regardless of DB latency or source rate.
        // Changes arriving while it writes collapse into one later publication.
        if (this.dirty) this.schedule();
      });
    return this.pending;
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    await this.pending?.catch(() => {});
  }
}
