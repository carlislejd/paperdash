import { useCallback, useEffect, useRef, useState } from "react";
import {
  decodeFollowing,
  encodeFollowing,
  FOLLOWING_KEY,
  toggleFollowing,
  type FollowedWallet,
} from "./following-storage";

const CHANGED = "paperclub:following-changed";
function read() {
  try {
    return decodeFollowing(localStorage.getItem(FOLLOWING_KEY));
  } catch {
    return [];
  }
}

export function useFollowing() {
  const [following, setFollowing] = useState<FollowedWallet[]>(read);
  const current = useRef(following);
  const update = useCallback((items: FollowedWallet[]) => {
    current.current = items;
    setFollowing(items);
  }, []);
  useEffect(() => {
    const storage = (event: StorageEvent) => {
      if (event.key === FOLLOWING_KEY || event.key === null)
        update(decodeFollowing(event.key === null ? null : event.newValue));
    };
    const changed = (event: Event) =>
      update((event as CustomEvent<FollowedWallet[]>).detail);
    window.addEventListener("storage", storage);
    window.addEventListener(CHANGED, changed);
    try {
      const raw = localStorage.getItem(FOLLOWING_KEY);
      const items = decodeFollowing(raw);
      update(items);
      // Migrate only a recognized legacy array; do not overwrite unknown versions.
      if (Array.isArray(JSON.parse(raw ?? "null")))
        localStorage.setItem(FOLLOWING_KEY, encodeFollowing(items));
    } catch {
      /* A blocked store remains usable in memory. */
    }
    return () => {
      window.removeEventListener("storage", storage);
      window.removeEventListener(CHANGED, changed);
    };
  }, [update]);
  const toggle = useCallback(
    (address: string, nameHint: string | null = null) => {
      const items = toggleFollowing(current.current, address, nameHint);
      update(items);
      try {
        localStorage.setItem(FOLLOWING_KEY, encodeFollowing(items));
      } catch {
        /* Keep this session's selection when browser storage is unavailable. */
      }
      window.dispatchEvent(new CustomEvent(CHANGED, { detail: items }));
    },
    [update],
  );
  return { following, toggle };
}
