import type { AnnualizedStakerYield } from "../../../../packages/shared/src/staking-yield";
import type { PaperEconomicsResponse } from "../../../../packages/shared/src/types";
import { formatRawUsd } from "./format";

const SCALE = 10n ** 18n;

export function stakerYieldDelayed(
  data: Pick<PaperEconomicsResponse, "sourceAt" | "receivedAt" | "stale" | "error"> | null | undefined,
  now = Date.now(),
): boolean {
  if (!data || data.stale || data.error || !Number.isSafeInteger(now))
    return true;
  return [data.sourceAt, data.receivedAt].some(
    (time) =>
      time === null ||
      !Number.isSafeInteger(time) ||
      time <= 0 ||
      time > now ||
      now - time > 30_000,
  );
}

function unsignedRaw(value: string | null | undefined): bigint | null {
  return typeof value === "string" && /^\d+$/.test(value)
    ? BigInt(value)
    : null;
}

/** Parse a hypothetical USDC price without passing through a floating point number. */
export function parsePaperPrice(value: string): bigint | null {
  const text = value.trim();
  if (!/^(?:\d+(?:\.\d{0,18})?|\.\d{1,18})$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const raw = BigInt(whole || "0") * SCALE + BigInt(fraction.padEnd(18, "0"));
  return raw > 0n ? raw : null;
}

/** The source clock and a complete interval must accompany an annualized rate. */
export function stakerYieldRate(
  value: AnnualizedStakerYield | null | undefined,
): string | null {
  if (
    !value ||
    unsignedRaw(value.usdPerPaperPerYearRaw) === null ||
    !Number.isSafeInteger(value.fromMs) ||
    !Number.isSafeInteger(value.toMs) ||
    !Number.isSafeInteger(value.elapsedMs) ||
    value.fromMs! <= 0 ||
    value.toMs! <= value.fromMs! ||
    value.toMs! > 8.64e15 ||
    value.elapsedMs !== value.toMs! - value.fromMs! ||
    value.elapsedMs! < 3_600_000 ||
    value.basis !== "observed-accumulator" ||
    value.yearDays !== 365
  )
    return null;
  return value.usdPerPaperPerYearRaw;
}

/** Annual USDC earned by 1,000 PAPER; zero and unknown stay distinct. */
export function formatStakerYield(raw: string | null | undefined): string {
  const amount = unsignedRaw(raw);
  if (amount === null) return "—";
  const perThousand = amount * 1000n;
  if (perThousand > 0n && perThousand < 5_000_000_000_000_000n)
    return "<$0.01";
  return formatRawUsd(perThousand.toString());
}

/** Simple APR, rounded once at the display boundary to hundredths of a percent. */
export function formatStakerApr(
  annualUsdPerPaperRaw: string | null | undefined,
  price: string,
): string {
  const annual = unsignedRaw(annualUsdPerPaperRaw);
  const priceRaw = parsePaperPrice(price);
  if (annual === null || priceRaw === null) return "—";
  const hundredths = (annual * 10000n + priceRaw / 2n) / priceRaw;
  if (annual > 0n && hundredths === 0n) return "<0.01%";
  return `${(hundredths / 100n).toLocaleString("en-US")}.${(hundredths % 100n).toString().padStart(2, "0")}%`;
}

export function formatYieldHours(
  elapsedMs: number | null | undefined,
): string {
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs! <= 0) return "—";
  // Six fractional hour digits expose partial hours; annualization uses every millisecond.
  const millionths =
    (BigInt(elapsedMs!) * 1_000_000n + 1_800_000n) / 3_600_000n;
  const fraction = (millionths % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${(millionths / 1_000_000n).toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

export function formatYieldTime(time: number): string {
  return `${new Date(time).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  })} UTC`;
}
