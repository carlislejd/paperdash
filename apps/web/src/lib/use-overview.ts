import { useEffect, useState } from "react";
import type {
  Overview,
  StreamMessage,
} from "../../../../packages/shared/src/types";
import { API_BASE, fetchJson, pollDelay } from "./api";
import { publishLiveConnection, publishLiveEvent } from "./live-events";
import { mergeOverviewUpdate } from "./overview-data";

/** One connection for the visible view. REST is a fallback, not a second live feed. */
export function useOverview(topics: string) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [transport, setTransport] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let source: EventSource | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    let connected = false;
    let receivedSnapshot = false;
    let pending = false;
    let attempts = 0;
    let failures = 0;
    let revision = 0;
    const merge = (next: Overview) =>
      setData((old) => mergeOverviewUpdate(old, next));
    const refresh = async () => {
      if (controller.signal.aborted) return;
      if (document.hidden || pending || (connected && receivedSnapshot)) {
        fallback = setTimeout(() => void refresh(), 30000);
        return;
      }
      pending = true;
      const startedRevision = revision;
      let delay = 30000;
      try {
        const next = await fetchJson<Overview>("/api/overview", {
          signal: controller.signal,
        });
        if (!controller.signal.aborted && startedRevision === revision)
          merge(next);
        failures = 0;
        setError("");
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
        delay = pollDelay(e, ++failures);
      } finally {
        pending = false;
        if (!controller.signal.aborted)
          fallback = setTimeout(() => void refresh(), delay);
      }
    };
    const connect = () => {
      clearTimeout(reconnect);
      source?.close();
      source = null;
      connected = false;
      receivedSnapshot = false;
      setTransport(false);
      publishLiveConnection(false);
      if (document.hidden || controller.signal.aborted) return;
      const current = new EventSource(
        `${API_BASE}/api/events?topics=${encodeURIComponent(topics)}`,
      );
      source = current;
      current.onopen = () => {
        if (source !== current) return;
        connected = true;
        setTransport(true);
        publishLiveConnection(true);
      };
      current.onerror = () => {
        if (source !== current) return;
        connected = false;
        setTransport(false);
        publishLiveConnection(false);
        current.close();
        source = null;
        // Jitter spreads reconnects after deploys/outages; no synchronized retry storm.
        const delay =
          Math.min(30000, 1500 * 2 ** Math.min(attempts++, 5)) *
          (0.75 + Math.random() * 0.5);
        reconnect = setTimeout(connect, delay);
      };
      current.onmessage = (event) => {
        if (source !== current || controller.signal.aborted) return;
        try {
          const message = JSON.parse(event.data) as StreamMessage;
          // Only overview-state updates can supersede an in-flight overview
          // fallback. Panel hints and price ticks do not contain that snapshot.
          if (
            message.type !== "panel-revisions" &&
            message.type !== "asset-price"
          )
            revision++;
          attempts = 0;
          publishLiveEvent(message);
          if (message.type === "overview") {
            receivedSnapshot = true;
            merge(message.data);
            setError("");
          } else if (message.type === "metrics" || message.type === "history") {
            setData((old) => mergeOverviewUpdate(old, message.data));
          } else if (message.type === "trade") {
            setData((old) =>
              old
                ? {
                    ...old,
                    trades: [
                      message.data,
                      ...old.trades.filter((t) => t.id !== message.data.id),
                    ]
                      .sort((a, b) => b.ts - a.ts)
                      .slice(0, 50),
                  }
                : old,
            );
          } else if (message.type === "status") {
            setData((old) => (old ? { ...old, status: message.data } : old));
          }
        } catch {
          /* A malformed event cannot replace a good snapshot. */
        }
      };
    };
    connect();
    fallback = setTimeout(() => void refresh(), 3000);
    document.addEventListener("visibilitychange", connect);
    return () => {
      controller.abort();
      source?.close();
      publishLiveConnection(false);
      clearTimeout(reconnect);
      clearTimeout(fallback);
      document.removeEventListener("visibilitychange", connect);
    };
  }, [topics]);
  return { data, error, transport };
}
