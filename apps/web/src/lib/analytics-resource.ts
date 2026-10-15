import { fetchJson, pollDelay } from "./api";
import {
  getPanelDelivery,
  getAssetDelivery,
  subscribeAssetDelivery,
  subscribeLiveEvents,
  subscribePanelDelivery,
  type PanelDelivery,
  type PanelKey,
  type AssetDelivery,
} from "./live-events";

const paths: Readonly<Record<string, PanelKey>> = {
  "/api/house": "house",
  "/api/protocol/charts": "protocol-charts",
  "/api/paper/economics": "paper-economics",
  "/api/liquidations/stats": "liquidation-stats",
};
const NORMAL = 5000,
  ASSET_RECONCILE = 15000,
  RECOVERY = 30000,
  LEASE = 20000;
type Options = {
  liveLiquidations?: boolean;
  instrument?: number;
  liveAsset?: number;
};
export type AnalyticsSnapshot = {
  data: unknown;
  error: string;
  loading: boolean;
};
type Reason =
  | "initial"
  | "manual"
  | "revision"
  | "notification"
  | "retry"
  | "poll"
  | "recovery";
type Entry = {
  path: string;
  raw: unknown;
  emittedRaw: unknown;
  snapshot: AnalyticsSnapshot;
  listeners: Map<() => void, Options>;
  checkedAt: number | null;
  startedAt: number | null;
  jitter: number;
  failures: number;
  retryAt: number;
  wanted: string | null;
  applied: string | null;
  hintStale: boolean;
  healthVersion: number;
  appliedHealth: number;
  rawHealth: number;
  unmatched: number;
  unconfirmed: boolean;
  resumeAt: number;
  dirtyAt: number | null;
  notificationAt: number | null;
  force: boolean;
  controller?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  release?: ReturnType<typeof setTimeout>;
};
type Environment = {
  read: (path: string, options: { signal: AbortSignal }) => Promise<unknown>;
  now: () => number;
  random: () => number;
  hidden: () => boolean;
};

/** Shared by mounted consumers of the exact same URL; never fetches an event-supplied URL. */
export class AnalyticsResources {
  private entries = new Map<string, Entry>();
  private delivery: PanelDelivery = {
    connected: false,
    envelope: null,
    observedAt: 0,
  };
  private assetDelivery: AssetDelivery = {
    connected: false,
    topics: [],
    quotes: {},
  };
  private counters = {
    requests: 0,
    revisionRequests: 0,
    notificationRequests: 0,
    pollingRequests: 0,
    recoveryRequests: 0,
    coalesced: 0,
    failures: 0,
  };
  private wasHidden = false;
  constructor(private env: Environment) {}

  private entry(path: string) {
    let entry = this.entries.get(path);
    if (!entry) {
      entry = {
        path,
        raw: null,
        emittedRaw: null,
        snapshot: { data: null, error: "", loading: true },
        listeners: new Map(),
        checkedAt: null,
        startedAt: null,
        jitter: 0,
        failures: 0,
        retryAt: 0,
        wanted: null,
        applied: null,
        hintStale: false,
        healthVersion: 0,
        appliedHealth: 0,
        rawHealth: 0,
        unmatched: 0,
        unconfirmed: false,
        resumeAt: 0,
        dirtyAt: null,
        notificationAt: null,
        force: false,
      };
      this.entries.set(path, entry);
    }
    return entry;
  }
  get(path: string) {
    return this.entry(path).snapshot;
  }
  subscribe(path: string, listener: () => void, options: Options = {}) {
    const entry = this.entry(path);
    clearTimeout(entry.release);
    entry.listeners.set(listener, options);
    this.acceptHint(entry);
    // StrictMode's setup/cleanup probe shares the same not-yet-started request.
    queueMicrotask(() => this.plan(entry));
    return () => {
      entry.listeners.delete(listener);
      if (!entry.listeners.size) {
        clearTimeout(entry.timer);
        entry.release = setTimeout(() => {
          if (entry.listeners.size) return;
          entry.controller?.abort();
          entry.controller = undefined;
          this.trim();
        }, 0);
      }
    };
  }
  refresh(path: string) {
    const entry = this.entry(path);
    entry.force = true;
    this.plan(entry);
  }
  visibilityChanged() {
    const hidden = this.env.hidden();
    for (const entry of this.entries.values()) {
      if (this.wasHidden && !hidden)
        entry.resumeAt = this.env.now() + this.env.random() * 750;
      this.plan(entry);
    }
    this.wasHidden = hidden;
  }
  setDelivery(delivery: PanelDelivery) {
    this.delivery = delivery;
    for (const entry of this.entries.values()) {
      if (!entry.listeners.size) continue;
      this.acceptHint(entry);
      this.plan(entry);
    }
  }
  setAssetDelivery(delivery: AssetDelivery) {
    this.assetDelivery = delivery;
    for (const entry of this.entries.values()) {
      if (
        [...entry.listeners.values()].some(
          (option) => option.liveAsset !== undefined,
        )
      )
        this.plan(entry);
    }
  }
  private assetLease(entry: Entry): number | null {
    if (
      !this.assetDelivery.connected ||
      !entry.listeners.size ||
      (entry.raw as { stale?: boolean } | null)?.stale ||
      (entry.path === "/api/assets" &&
        this.assetSnapshotExpiry(entry) < this.env.now())
    )
      return null;
    let expiry = Infinity;
    for (const { liveAsset } of entry.listeners.values()) {
      if (
        liveAsset === undefined ||
        !this.assetDelivery.topics.includes(`asset:${liveAsset}`) ||
        (entry.path !== "/api/assets" &&
          entry.path.split("?")[0] !== `/api/assets/${liveAsset}/market`)
      )
        return null;
      const quote = this.assetDelivery.quotes[liveAsset];
      if (!quote) return null;
      expiry = Math.min(
        expiry,
        quote.observedAt + LEASE + 1,
        quote.sourceAt + LEASE + 1,
        quote.receivedAt + LEASE + 1,
      );
    }
    return expiry > this.env.now() ? expiry : null;
  }
  private assetSnapshotExpiry(entry: Entry) {
    const data = entry.raw as Record<string, unknown> | null;
    const now = this.env.now();
    const expiry = (time: unknown, maxAge: number) =>
      typeof time === "number" &&
      Number.isFinite(time) &&
      time >= 0 &&
      time <= now + 30000
        ? time + maxAge
        : 0;
    return Math.min(
      expiry(data?.receivedAt, 20000),
      expiry(data?.sourceAt, 30000),
      expiry(data?.activityReceivedAt, 30000),
    );
  }
  trade(instrument: number, kind: string) {
    if (kind !== "liq" || this.env.hidden()) return;
    for (const entry of this.entries.values()) {
      if (
        entry.failures ||
        entry.controller ||
        this.capable(entry) ||
        ![...entry.listeners.values()].some(
          (option) =>
            option.liveLiquidations &&
            (option.instrument === undefined ||
              option.instrument === instrument),
        )
      )
        continue;
      // Preserve the legacy notification deadline, rather than the later
      // jittered poll. Bursts share one deadline and never bypass error backoff.
      entry.notificationAt ??= Math.max(
        this.env.now(),
        (entry.startedAt ?? 0) + NORMAL,
      );
      this.plan(entry);
    }
  }
  private capable(entry: Entry) {
    const now = this.env.now(),
      envelope = this.delivery.envelope;
    return Boolean(
      paths[entry.path] &&
        this.delivery.connected &&
        envelope &&
        now - this.delivery.observedAt <= LEASE &&
        now - envelope.publishedAt <= LEASE &&
        envelope.publishedAt <= now + 30000 &&
        envelope.panels[paths[entry.path]],
    );
  }
  private hint(entry: Entry) {
    return paths[entry.path]
      ? this.delivery.envelope?.panels[paths[entry.path]]
      : undefined;
  }
  private acceptHint(entry: Entry) {
    if (!this.capable(entry)) return;
    const { revision, stale } = this.hint(entry)!;
    if (revision === entry.wanted && stale === entry.hintStale) return;
    if (entry.dirtyAt !== null) this.counters.coalesced++;
    if (stale !== entry.hintStale) entry.healthVersion++;
    entry.hintStale = stale;
    entry.wanted = revision;
    entry.unmatched = 0;
    const savedRevision =
      entry.raw && typeof entry.raw === "object"
        ? (entry.raw as { panelRevision?: unknown }).panelRevision
        : undefined;
    const saved = entry.raw as { stale?: boolean; houseStale?: boolean } | null;
    const savedStale =
      entry.path === "/api/house"
        ? (saved?.houseStale ?? saved?.stale)
        : saved?.stale;
    if (
      savedRevision === revision &&
      entry.healthVersion === entry.rawHealth &&
      !savedStale &&
      !entry.failures
    ) {
      // REST can observe a publication before its coalesced stream hint. The
      // arriving exact token proves the saved body without another download.
      entry.applied = revision;
      entry.appliedHealth = entry.rawHealth;
      entry.unconfirmed = false;
      entry.dirtyAt = null;
      return;
    }
    // Repeated changes preserve the first deadline instead of debouncing forever.
    entry.dirtyAt ??= this.env.now() + this.env.random() * 750;
  }
  private emit(
    entry: Entry,
    error = entry.snapshot.error,
    loading = entry.snapshot.loading,
  ) {
    let data = entry.raw;
    if (data && typeof data === "object" && paths[entry.path]) {
      const record = data as Record<string, unknown>,
        hint = this.hint(entry),
        now = this.env.now();
      const maxAge = paths[entry.path] === "liquidation-stats" ? 30000 : 60000;
      const old = (time: unknown) =>
        typeof time !== "number" ||
        !Number.isFinite(time) ||
        time < 0 ||
        time > now + 30000 ||
        now - time > maxAge;
      const receiptOld = old(record.receivedAt);
      const sourceOld = "sourceAt" in record && old(record.sourceAt);
      const hintedStale =
        this.capable(entry) &&
        Boolean(
          hint?.stale ||
            old(hint?.receivedAt) ||
            (hint?.sourceAt !== null && old(hint?.sourceAt)),
        );
      const ownOverlay = Boolean(
        error || receiptOld || sourceOld || entry.unconfirmed,
      );
      const overlay = Boolean(ownOverlay || hintedStale || entry.hintStale);
      const stale = Boolean(record.stale || overlay);
      const houseStale =
        entry.path === "/api/house"
          ? Boolean((record.houseStale ?? record.stale) || overlay)
          : undefined;
      const prior = entry.snapshot.data as Record<string, unknown> | null;
      data =
        entry.emittedRaw === entry.raw &&
        prior?.stale === stale &&
        (houseStale === undefined || prior?.houseStale === houseStale)
          ? prior
          : {
              ...record,
              stale,
              ...(houseStale === undefined ? {} : { houseStale }),
            };
    } else if (data && typeof data === "object" && entry.path === "/api/assets") {
      const record = data as Record<string, unknown>;
      // Quotes are a different source: they cannot renew saved open-interest
      // or activity clocks while the slower authoritative GET is pending.
      const stale = Boolean(
        record.stale ||
          error ||
          this.assetSnapshotExpiry(entry) < this.env.now(),
      );
      const prior = entry.snapshot.data as Record<string, unknown> | null;
      data =
        entry.emittedRaw === entry.raw && prior?.stale === stale
          ? prior
          : { ...record, stale };
    }
    if (
      entry.snapshot.data === data &&
      entry.snapshot.error === error &&
      entry.snapshot.loading === loading
    )
      return;
    entry.emittedRaw = entry.raw;
    entry.snapshot = { data, error, loading };
    for (const listener of entry.listeners.keys()) listener();
  }
  private plan(entry: Entry) {
    clearTimeout(entry.timer);
    if (!entry.listeners.size) return;
    this.emit(entry);
    if (this.env.hidden() || entry.controller) return;
    const now = this.env.now(),
      capable = this.capable(entry),
      assetLease = this.assetLease(entry);
    let reason: Reason, at: number;
    if (entry.failures) {
      reason = "retry";
      at = entry.retryAt;
    } else if (entry.force) {
      reason = "manual";
      at = now;
    } else if (entry.checkedAt === null) {
      reason = "initial";
      at = now;
    } else if (!capable && entry.notificationAt !== null) {
      reason = "notification";
      at = entry.notificationAt;
    } else if (
      capable &&
      (entry.wanted !== entry.applied ||
        entry.healthVersion !== entry.appliedHealth) &&
      entry.unmatched < 2
    ) {
      reason = "revision";
      at = Math.max((entry.startedAt ?? 0) + NORMAL, entry.dirtyAt ?? now);
    } else {
      // Live quotes/trades fill the current market. OI/activity need an earlier
      // authoritative refresh than the market's history/coverage reconciliation.
      const reconcile = capable || assetLease !== null;
      reason = reconcile ? "recovery" : "poll";
      const interval = reconcile
        ? entry.path === "/api/assets"
          ? ASSET_RECONCILE
          : RECOVERY
        : NORMAL;
      at =
        entry.checkedAt +
        interval +
        Math.min(interval * 0.2, 5000) * entry.jitter;
      if (assetLease !== null && entry.path === "/api/assets")
        // Keep a little network headroom before the saved source goes stale,
        // without allowing old backend snapshots to create a tight request loop.
        at = Math.max(
          entry.checkedAt + NORMAL,
          Math.min(at, this.assetSnapshotExpiry(entry) - 1000),
        );
    }
    at = Math.max(at, entry.resumeAt);
    if (at <= now) {
      void this.read(entry, reason);
      return;
    }
    // Wake at least every five seconds to age saved values and expire capabilities.
    const leaseExpiry = capable
      ? Math.min(
          this.delivery.observedAt,
          this.delivery.envelope!.publishedAt,
        ) +
        LEASE +
        1
      : (assetLease ?? Infinity);
    entry.timer = setTimeout(
      () => this.plan(entry),
      Math.max(1, Math.min(at, now + NORMAL, leaseExpiry) - now),
    );
  }
  private async read(entry: Entry, reason: Reason) {
    if (entry.controller || !entry.listeners.size || this.env.hidden()) return;
    const controller = new AbortController();
    entry.controller = controller;
    entry.startedAt = this.env.now();
    entry.force = false;
    entry.notificationAt = null;
    const revision = this.capable(entry) ? entry.wanted : null;
    const health = entry.healthVersion;
    this.counters.requests++;
    if (reason === "revision") this.counters.revisionRequests++;
    if (reason === "notification") this.counters.notificationRequests++;
    if (reason === "poll") this.counters.pollingRequests++;
    if (reason === "recovery") this.counters.recoveryRequests++;
    this.emit(entry, entry.snapshot.error, !entry.raw || reason === "manual");
    try {
      const data = await this.env.read(entry.path, {
        signal: controller.signal,
      });
      if (controller.signal.aborted || entry.controller !== controller) return;
      entry.raw = data;
      entry.rawHealth = health;
      entry.checkedAt = this.env.now();
      entry.jitter = this.env.random();
      entry.failures = 0;
      entry.retryAt = 0;
      const returnedRevision =
        data && typeof data === "object"
          ? (data as { panelRevision?: unknown }).panelRevision
          : undefined;
      // Bootstrap can arrive while the initial polling GET is in flight.
      // Preserve that new hint and acknowledge it only with the same proof.
      const expected = revision ?? (this.capable(entry) ? entry.wanted : null);
      const expectedHealth = health;
      if (expected === null || returnedRevision === expected) {
        if (expected === null) {
          // A successful polling response is authoritative after capability
          // loss/rollback. Do not retain health from a previous connection.
          entry.hintStale = false;
          entry.wanted = null;
          entry.dirtyAt = null;
        }
        entry.applied = expected;
        entry.appliedHealth = expectedHealth;
        entry.unconfirmed = false;
        entry.unmatched = 0;
        if (entry.wanted === expected && entry.healthVersion === expectedHealth)
          entry.dirtyAt = null;
      } else {
        // A one-second edge cache may still serve the previous publication.
        // Retry once after the normal floor, then reconcile slowly if metadata
        // is missing/old during rollout. Never claim the hint was consumed.
        entry.unconfirmed = true;
        if (entry.wanted === expected && entry.healthVersion === expectedHealth)
          entry.unmatched++;
      }
      this.emit(entry, "", false);
    } catch (error) {
      if (controller.signal.aborted || entry.controller !== controller) return;
      this.counters.failures++;
      entry.retryAt =
        this.env.now() +
        pollDelay(error, ++entry.failures, NORMAL, this.env.random);
      this.emit(
        entry,
        error instanceof Error
          ? error.message
          : "Could not refresh this snapshot.",
        false,
      );
    } finally {
      if (entry.controller === controller) {
        entry.controller = undefined;
        this.plan(entry);
      }
    }
  }
  private trim() {
    const unused = [...this.entries.values()].filter(
      (entry) => !entry.listeners.size && !entry.controller,
    );
    while (unused.length > 24) this.entries.delete(unused.shift()!.path);
  }
  diagnostics() {
    return {
      ...this.counters,
      resources: [...this.entries.values()]
        .filter((entry) => entry.listeners.size)
        .map((entry) => ({
          path: entry.path,
          mode:
            this.capable(entry) || this.assetLease(entry) !== null
              ? "events"
              : "poll",
          inFlight: Boolean(entry.controller),
          sourceAgeMs:
            entry.raw &&
            typeof entry.raw === "object" &&
            typeof (entry.raw as { sourceAt?: unknown }).sourceAt === "number"
              ? Math.max(
                  0,
                  this.env.now() - (entry.raw as { sourceAt: number }).sourceAt,
                )
              : null,
        })),
    };
  }
  dispose() {
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer);
      clearTimeout(entry.release);
      entry.controller?.abort();
    }
    this.entries.clear();
  }
}

export const analyticsResources = new AnalyticsResources({
  read: fetchJson,
  now: Date.now,
  random: Math.random,
  hidden: () => typeof document !== "undefined" && document.hidden,
});
analyticsResources.setDelivery(getPanelDelivery());
subscribePanelDelivery((delivery) => analyticsResources.setDelivery(delivery));
analyticsResources.setAssetDelivery(getAssetDelivery());
subscribeAssetDelivery((delivery) =>
  analyticsResources.setAssetDelivery(delivery),
);
subscribeLiveEvents((message) => {
  if (message.type === "trade")
    analyticsResources.trade(message.data.instrument, message.data.kind);
});
if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", () =>
    analyticsResources.visibilityChanged(),
  );
