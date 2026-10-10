import { useCallback, useEffect, useState } from "react";
import { fetchJson, pollDelay } from "./api";
import { subscribeLiveEvents } from "./live-events";

// Keep recent panels ready when navigating back; polling still refreshes them.
const snapshots = new Map<string, unknown>();

export function useAnalytics<T>(
  path: string,
  options: { liveLiquidations?: boolean; instrument?: number } = {},
) {
  const { liveLiquidations = false, instrument } = options;
  const [state, setState] = useState<{
    path: string;
    data: T | null;
    error: string;
    loading: boolean;
  }>(() => ({
    path,
    data: (snapshots.get(path) as T | undefined) ?? null,
    error: "",
    loading: true,
  }));
  const [retry, setRetry] = useState(0);
  const refresh = useCallback(() => setRetry((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    let failures = 0;
    let lastReadAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState({
      path,
      data: (snapshots.get(path) as T | undefined) ?? null,
      error: "",
      loading: true,
    });
    const read = async () => {
      if (pending || document.hidden || controller.signal.aborted) return;
      pending = true;
      lastReadAt = Date.now();
      clearTimeout(timer);
      let nextDelay = pollDelay(null, 0);
      try {
        const data = await fetchJson<T>(path, { signal: controller.signal });
        if (controller.signal.aborted) return;
        snapshots.delete(path);
        snapshots.set(path, data);
        // A long session with many search queries must not grow without bound.
        if (snapshots.size > 24)
          snapshots.delete(snapshots.keys().next().value!);
        failures = 0;
        setState({ path, data, error: "", loading: false });
      } catch (error) {
        nextDelay = pollDelay(error, ++failures);
        if (!controller.signal.aborted)
          setState((previous) => ({
            ...previous,
            error: (error as Error).message,
            loading: false,
          }));
      } finally {
        pending = false;
        if (!controller.signal.aborted)
          timer = setTimeout(() => void read(), nextDelay);
      }
    };
    void read();
    const unsubscribe = liveLiquidations
      ? subscribeLiveEvents((message) => {
          if (
            message.type !== "trade" ||
            message.data.kind !== "liq" ||
            (instrument !== undefined &&
              message.data.instrument !== instrument) ||
            document.hidden ||
            controller.signal.aborted ||
            pending ||
            failures > 0
          )
            return;
          // Coalesce notifications with the existing poll, leaving at least five
          // seconds between reads. Failed requests keep their normal backoff timer.
          clearTimeout(timer);
          timer = setTimeout(
            () => void read(),
            Math.max(0, lastReadAt + 5000 - Date.now()),
          );
        })
      : undefined;
    const visible = () => {
      if (!document.hidden) void read();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      unsubscribe?.();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [path, retry, liveLiquidations, instrument]);

  // A different page/sort must never show the previous query's rows or rank.
  return {
    ...(state.path === path
      ? state
      : {
          data: (snapshots.get(path) as T | undefined) ?? null,
          error: "",
          loading: true,
        }),
    refresh,
  };
}
