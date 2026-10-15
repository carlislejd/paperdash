import type {
  PanelKey,
  PanelRevisions,
  StreamMessage,
} from "../../../../packages/shared/src/types";
import { validPricePoint } from "./market-data";
export type {
  PanelKey,
  PanelRevisions,
} from "../../../../packages/shared/src/types";
export type PanelDelivery = {
  connected: boolean;
  envelope: PanelRevisions | null;
  observedAt: number;
};
export type AssetDelivery = {
  connected: boolean;
  topics: readonly string[];
  quotes: Readonly<
    Partial<
      Record<
        number,
        { observedAt: number; sourceAt: number; receivedAt: number }
      >
    >
  >;
};
type Listener = (message: StreamMessage) => void;
const listeners = new Set<Listener>();
const deliveryListeners = new Set<(delivery: PanelDelivery) => void>();
const assetListeners = new Set<(delivery: AssetDelivery) => void>();
let assetDelivery: AssetDelivery = {
  connected: false,
  topics: [],
  quotes: {},
};
let delivery: PanelDelivery = {
  connected: false,
  envelope: null,
  observedAt: 0,
};
const keys: readonly PanelKey[] = [
  "house",
  "protocol-charts",
  "paper-economics",
  "liquidation-stats",
];
const timestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Validate the small optional capability envelope; arbitrary URLs/keys are ignored. */
export function decodePanelRevisions(value: unknown): PanelRevisions | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (
    input.version !== 1 ||
    !timestamp(input.publishedAt) ||
    !input.panels ||
    typeof input.panels !== "object" ||
    Array.isArray(input.panels)
  )
    return null;
  const panels: PanelRevisions["panels"] = {};
  for (const key of keys) {
    const item = (input.panels as Record<string, unknown>)[key];
    if (!item || typeof item !== "object") continue;
    const hint = item as Record<string, unknown>;
    if (
      typeof hint.revision !== "string" ||
      !hint.revision.length ||
      hint.revision.length > 256 ||
      !timestamp(hint.receivedAt) ||
      !(hint.sourceAt === null || timestamp(hint.sourceAt)) ||
      typeof hint.stale !== "boolean"
    )
      continue;
    panels[key] = {
      revision: hint.revision,
      receivedAt: hint.receivedAt,
      sourceAt: hint.sourceAt,
      stale: hint.stale,
    };
  }
  return { version: 1, publishedAt: input.publishedAt, panels };
}
const publishDelivery = () => {
  for (const listener of deliveryListeners) listener(delivery);
};
export function publishLiveConnection(connected: boolean, topics = "") {
  // Capabilities belong to this connection, not a previous server/deployment.
  delivery = { connected, envelope: null, observedAt: 0 };
  publishDelivery();
  assetDelivery = {
    connected,
    topics: connected ? topics.split(",").map((topic) => topic.trim()) : [],
    quotes: {},
  };
  for (const listener of assetListeners) listener(assetDelivery);
}
export function getPanelDelivery() {
  return delivery;
}
export function subscribePanelDelivery(
  listener: (delivery: PanelDelivery) => void,
) {
  deliveryListeners.add(listener);
  return () => {
    deliveryListeners.delete(listener);
  };
}
export function getAssetDelivery() {
  return assetDelivery;
}
export function subscribeAssetDelivery(
  listener: (delivery: AssetDelivery) => void,
) {
  assetListeners.add(listener);
  return () => {
    assetListeners.delete(listener);
  };
}

// Panels share the dashboard's single EventSource; mounting a chart never
// opens another stream or reconnects the existing one.
export function publishLiveEvent(message: StreamMessage) {
  if (message.type === "asset-price" && assetDelivery.connected) {
    const quote = message.data;
    const now = Date.now();
    if (
      quote &&
      assetDelivery.topics.includes(`asset:${quote.instrument}`) &&
      validPricePoint(quote.point, now) &&
      timestamp(quote.receivedAt) &&
      quote.receivedAt <= now + 30000 &&
      quote.point.time >=
        (assetDelivery.quotes[quote.instrument]?.sourceAt ?? 0)
    ) {
      assetDelivery = {
        ...assetDelivery,
        quotes: {
          ...assetDelivery.quotes,
          [quote.instrument]: {
            observedAt: now,
            sourceAt: quote.point.time,
            receivedAt: quote.receivedAt,
          },
        },
      };
      for (const listener of assetListeners) listener(assetDelivery);
    }
  }
  const candidate = message as {
    type: string;
    data?: unknown;
    panels?: unknown;
  };
  const envelope = decodePanelRevisions(
    candidate.type === "panel-revisions"
      ? candidate.data
      : candidate.type === "overview"
        ? candidate.panels
        : null,
  );
  if (
    envelope &&
    delivery.connected &&
    envelope.publishedAt <= Date.now() + 30000 &&
    (!delivery.envelope ||
      envelope.publishedAt >= delivery.envelope.publishedAt)
  ) {
    // Change notifications can contain a subset; the heartbeat renews the full map.
    delivery = {
      connected: true,
      observedAt: Date.now(),
      envelope: {
        ...envelope,
        panels: { ...delivery.envelope?.panels, ...envelope.panels },
      },
    };
    publishDelivery();
  }
  for (const listener of listeners) listener(message);
}
export function subscribeLiveEvents(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
