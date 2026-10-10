export function holdingTimeMs(
  openedAt: unknown,
  closedAt: unknown,
): number | null {
  return typeof openedAt === "number" &&
    typeof closedAt === "number" &&
    Number.isSafeInteger(openedAt) &&
    Number.isSafeInteger(closedAt) &&
    openedAt >= 0 &&
    closedAt >= openedAt
    ? closedAt - openedAt
    : null;
}

export function formatHoldingTime(
  milliseconds: number | null | undefined,
): string {
  if (
    milliseconds == null ||
    !Number.isFinite(milliseconds) ||
    milliseconds < 0
  )
    return "—";
  if (milliseconds === 0) return "0s";
  if (milliseconds < 1000) return "<1s";
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  const days = Math.floor(hours / 24);
  return `${days.toLocaleString("en-US")}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
}

export function closedHoldingTimeMs(
  item: { openedAtMs?: unknown; timestampMs?: unknown; kind?: unknown },
  receivedAt = Date.now(),
): number | null {
  if (item.kind !== "PositionClosed" && item.kind !== "Liquidated") return null;
  if (
    typeof item.timestampMs !== "number" ||
    item.timestampMs > Math.min(receivedAt, Date.now()) + 30_000
  )
    return null;
  return holdingTimeMs(item.openedAtMs, item.timestampMs);
}

export function formatLeverage(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "—";
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}×`;
}

/** Keep unknown tuple fields unknown; an incomplete snapshot must not look empty. */
export function openPositionRows(positions: unknown[], asOf: number) {
  return positions.map((entry, index) => {
    const tuple = Array.isArray(entry) ? entry : [];
    const leverage = tuple[6];
    return {
      key: `${String(tuple[0] ?? "unknown")}:${index}`,
      symbol: tuple[1] === 0 ? "BTC" : tuple[1] === 1 ? "ETH" : "Market",
      side: tuple[2] === true ? "Long" : tuple[2] === false ? "Short" : "—",
      leverage:
        typeof leverage === "number" &&
        Number.isSafeInteger(leverage) &&
        leverage > 0
          ? leverage
          : null,
      heldMs: holdingTimeMs(tuple[8], Math.floor(asOf)),
    };
  });
}
