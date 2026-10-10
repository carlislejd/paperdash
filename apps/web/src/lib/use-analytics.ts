import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "./api";

// Keep recent panels ready when navigating back; polling still refreshes them.
const snapshots = new Map<string, unknown>();

export function useAnalytics<T>(path: string) {
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
    setState({
      path,
      data: (snapshots.get(path) as T | undefined) ?? null,
      error: "",
      loading: true,
    });
    const read = async () => {
      if (pending || document.hidden || controller.signal.aborted) return;
      pending = true;
      try {
        const data = await fetchJson<T>(path, { signal: controller.signal });
        if (controller.signal.aborted) return;
        snapshots.delete(path);
        snapshots.set(path, data);
        // A long session with many search queries must not grow without bound.
        if (snapshots.size > 24)
          snapshots.delete(snapshots.keys().next().value!);
        setState({ path, data, error: "", loading: false });
      } catch (error) {
        if (!controller.signal.aborted)
          setState((previous) => ({
            ...previous,
            error: (error as Error).message,
            loading: false,
          }));
      } finally {
        pending = false;
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), 5_000);
    const visible = () => {
      if (!document.hidden) void read();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [path, retry]);

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
