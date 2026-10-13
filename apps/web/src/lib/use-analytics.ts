import { useCallback, useSyncExternalStore } from "react";
import { analyticsResources } from "./analytics-resource";

export function useAnalytics<T>(
  path: string,
  options: { liveLiquidations?: boolean; instrument?: number } = {},
) {
  const { liveLiquidations = false, instrument } = options;
  const subscribe = useCallback(
    (listener: () => void) =>
      analyticsResources.subscribe(path, listener, {
        liveLiquidations,
        instrument,
      }),
    [path, liveLiquidations, instrument],
  );
  const get = useCallback(() => analyticsResources.get(path), [path]);
  const state = useSyncExternalStore(subscribe, get, get);
  const refresh = useCallback(() => analyticsResources.refresh(path), [path]);
  return { ...state, data: state.data as T | null, refresh };
}
