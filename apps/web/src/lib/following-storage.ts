export interface FollowedWallet {
  address: string;
  nameHint: string | null;
  followedAt: number | null;
}

export const FOLLOWING_KEY = "paperdash:following";
export const FOLLOWING_LIMIT = 100;

/** Legacy Account arrays contribute identity only, never cached financial values. */
export function decodeFollowing(raw: string | null): FollowedWallet[] {
  try {
    const decoded: unknown = JSON.parse(raw ?? "[]");
    const legacy = Array.isArray(decoded);
    const entries = legacy
      ? decoded
      : decoded &&
          typeof decoded === "object" &&
          "version" in decoded &&
          decoded.version === 2 &&
          "items" in decoded &&
          Array.isArray(decoded.items)
        ? decoded.items
        : [];
    const result: FollowedWallet[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof entry.address !== "string" ||
        !/^0x[a-fA-F0-9]{40}$/.test(entry.address)
      )
        continue;
      const address = entry.address.toLowerCase();
      if (seen.has(address)) continue;
      seen.add(address);
      const name = legacy ? entry.leaderboardName : entry.nameHint;
      result.push({
        address,
        nameHint:
          typeof name === "string" ? name.trim().slice(0, 100) || null : null,
        followedAt:
          !legacy &&
          Number.isSafeInteger(entry.followedAt) &&
          entry.followedAt >= 0
            ? entry.followedAt
            : null,
      });
      if (result.length === FOLLOWING_LIMIT) break;
    }
    return result;
  } catch {
    return [];
  }
}

export function encodeFollowing(items: readonly FollowedWallet[]): string {
  // Apply the same boundary to programmatic callers as to imported storage.
  return JSON.stringify({
    version: 2,
    items: decodeFollowing(JSON.stringify({ version: 2, items })),
  });
}

export function toggleFollowing(
  items: readonly FollowedWallet[],
  address: string,
  nameHint: string | null = null,
  now = Date.now(),
): FollowedWallet[] {
  const normalized = address.toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) return [...items];
  if (items.some((item) => item.address === normalized))
    return items.filter((item) => item.address !== normalized);
  // Do not silently evict a previously followed wallet at the limit.
  if (items.length >= FOLLOWING_LIMIT) return [...items];
  return decodeFollowing(
    encodeFollowing([
      { address: normalized, nameHint, followedAt: now },
      ...items,
    ]),
  );
}

export function followingBatchPath(
  addresses: readonly string[],
): string | null {
  const normalized = [
    ...new Set(addresses.map((address) => address.toLowerCase())),
  ].sort();
  if (!normalized.length) return null;
  if (
    normalized.length > 25 ||
    normalized.some((address) => !/^0x[a-f0-9]{40}$/.test(address))
  )
    throw new Error(
      "Following batches require at most 25 valid wallet addresses",
    );
  return `/api/wallets/batch?addresses=${normalized.join(",")}`;
}
