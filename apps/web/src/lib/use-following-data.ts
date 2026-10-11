import { useCallback, useEffect, useState } from "react";
import type { WalletBatchResponse } from "../../../../packages/shared/src/types";
import { fetchJson, pollDelay } from "./api";
import { followingBatchPath } from "./following-storage";

const snapshots = new Map<string, WalletBatchResponse>();
type State = {
  path: string | null;
  data: WalletBatchResponse | null;
  error: string;
  loading: boolean;
};

export function useFollowingData(addresses: readonly string[]) {
  const path = followingBatchPath(addresses);
  const [state, setState] = useState<State>({
    path: null,
    data: null,
    error: "",
    loading: false,
  });
  const [retry, setRetry] = useState(0);
  const refresh = useCallback(() => setRetry((value) => value + 1), []);
  useEffect(() => {
    if (!path) {
      setState({ path: null, data: null, error: "", loading: false });
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = false,
      failures = 0,
      nextReadAt = 0;
    setState({
      path,
      data: snapshots.get(path) ?? null,
      error: "",
      loading: true,
    });
    const schedule = (delay: number) => {
      clearTimeout(timer);
      nextReadAt = Date.now() + delay;
      timer = setTimeout(() => void read(), delay);
    };
    const read = async () => {
      if (controller.signal.aborted || pending) return;
      if (document.hidden) {
        schedule(10000);
        return;
      }
      if (Date.now() < nextReadAt) {
        timer = setTimeout(() => void read(), nextReadAt - Date.now());
        return;
      }
      pending = true;
      let delay = pollDelay(null, 0, 10000);
      try {
        const data = await fetchJson<WalletBatchResponse>(path, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        snapshots.delete(path);
        snapshots.set(path, data);
        if (snapshots.size > 8)
          snapshots.delete(snapshots.keys().next().value!);
        failures = 0;
        setState({ path, data, error: "", loading: false });
      } catch (error) {
        delay = pollDelay(error, ++failures, 10000);
        if (!controller.signal.aborted)
          setState((old) => ({
            ...old,
            loading: false,
            error: (error as Error).message,
          }));
      } finally {
        pending = false;
        if (!controller.signal.aborted) schedule(delay);
      }
    };
    // A StrictMode setup/cleanup probe must not start an extra batch request.
    queueMicrotask(() => void read());
    const visible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        void read();
      }
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [path, retry]);
  return {
    ...(state.path === path
      ? state
      : {
          path,
          data: path ? (snapshots.get(path) ?? null) : null,
          error: "",
          loading: Boolean(path),
        }),
    refresh,
  };
}
