import type { WalletResponse } from "../../../../packages/shared/src/types";
import type { PositionMetricsResponse } from "../../../../packages/shared/src/position-metrics";
import { formatHoldingTime, formatLeverage } from "./position-format";
import { formatRawUsd, shortAddress } from "./format";
import { walletAccountClock } from "./wallet-account-clock";

export const PNL_CARD_ART = "/art/paperclub-social-v4.png";
export const PNL_CARD_LAYOUTS = [
  {
    id: "gallery",
    name: "Gallery",
    description: "Artwork first",
    width: 1200,
    height: 900,
  },
  {
    id: "split",
    name: "Spotlight",
    description: "Made for the timeline",
    width: 1200,
    height: 675,
  },
  {
    id: "portrait",
    name: "Portrait",
    description: "The full trading card",
    width: 1080,
    height: 1350,
  },
] as const;
export type PnlCardLayout = (typeof PNL_CARD_LAYOUTS)[number]["id"];
export interface PnlCardSnapshot {
  wallet: WalletResponse;
  metrics: PositionMetricsResponse | null;
  displayName: string | null;
  capturedAt: number;
  /** Local design-review fixtures only; visibly marked in exported pixels. */
  demo?: boolean;
}
export interface PnlCardOptions {
  layout: PnlCardLayout;
  hideWallet: boolean;
}
export interface PnlCardModel {
  layout: PnlCardLayout;
  width: number;
  height: number;
  identity: string;
  address: string | null;
  pnl: string;
  pnlTone: "positive" | "negative" | "neutral";
  paper: string;
  stats: { label: string; value: string; detail?: string }[];
  accountNote: string;
  historyNote: string;
  captured: string;
  link: string;
  filename: string;
  shareText: string;
}

function paperAmount(raw: bigint): string {
  const hundredths = (raw + 5_000_000_000_000_000n) / 10_000_000_000_000_000n;
  return `${(hundredths / 100n).toLocaleString("en-US")}.${(hundredths % 100n).toString().padStart(2, "0")}`;
}
function signedUsd(raw: string | null | undefined): string {
  const formatted = formatRawUsd(raw);
  return raw && /^\d+$/.test(raw) && BigInt(raw) > 0n
    ? `+${formatted}`
    : formatted;
}
function stamp(at: number | null | undefined): string {
  return typeof at === "number" &&
    Number.isSafeInteger(at) &&
    at > 0 &&
    at < 8_640_000_000_000_000
    ? new Date(at).toISOString().slice(0, 16).replace("T", " ") + " UTC"
    : "Time unavailable";
}

/** Produce a sanitized rendering model before any async image work begins. */
export function walletPnlCardModel(
  snapshot: PnlCardSnapshot,
  options: PnlCardOptions,
): PnlCardModel {
  const { wallet, metrics, capturedAt } = snapshot;
  const account = wallet.snapshot;
  const layout = PNL_CARD_LAYOUTS.find((item) => item.id === options.layout)!;
  const rawPnl = account?.lifetime.realizedPnlRaw;
  const paper =
    account &&
    /^\d+$/.test(account.paper.balance) &&
    /^\d+$/.test(account.paper.staked)
      ? paperAmount(
          BigInt(account.paper.balance) + BigInt(account.paper.staked),
        )
      : "—";
  const highlights = metrics?.highlights;
  const best = highlights?.bestTrade;
  const worst = highlights?.worstTrade;
  const historyComplete = Boolean(
    metrics &&
    highlights?.complete &&
    metrics.coverage.projectionBackfillComplete &&
    !metrics.coverage.pending &&
    metrics.coverage.historyBackfillComplete === true,
  );
  const accountClock = walletAccountClock(wallet, false, capturedAt);
  const address = options.hideWallet ? null : wallet.address;
  const identity = options.hideWallet
    ? "WALLET HIDDEN"
    : snapshot.displayName?.trim().slice(0, 64) || shortAddress(wallet.address);
  const pnl = signedUsd(rawPnl);
  const link = new URL("https://papertrade.club/");
  if (address) link.searchParams.set("wallet", address.toLowerCase());
  return {
    layout: options.layout,
    width: layout.width,
    height: layout.height,
    identity,
    address,
    pnl,
    paper,
    pnlTone:
      rawPnl && /^-?\d+$/.test(rawPnl)
        ? BigInt(rawPnl) < 0n
          ? "negative"
          : BigInt(rawPnl) > 0n
            ? "positive"
            : "neutral"
        : "neutral",
    stats: [
      {
        label: "Recorded closed trades",
        value:
          highlights?.tradeCount != null
            ? highlights.tradeCount.toLocaleString("en-US")
            : "—",
      },
      {
        label: "Average hold",
        value: formatHoldingTime(metrics?.avgHoldMs),
        detail: "Closed positions",
      },
      {
        label: "Best recorded trade",
        value: signedUsd(best?.pnlRaw),
        detail: best?.symbol ?? undefined,
      },
      {
        label: "Worst recorded trade",
        value: signedUsd(worst?.pnlRaw),
        detail: worst?.symbol ?? undefined,
      },
      {
        label: "Average leverage",
        value: formatLeverage(metrics?.avgLeverage),
      },
      {
        label: "Open positions",
        value: account
          ? account.openPositions.length.toLocaleString("en-US")
          : "—",
        detail: "At account snapshot",
      },
    ],
    accountNote: `${snapshot.demo ? "DEMO DATA · " : ""}${accountClock.stale ? "Saved account" : "Account"} checked · ${stamp(accountClock.checkedAt)}`,
    historyNote: !metrics
      ? "Trade statistics unavailable"
      : `${historyComplete ? "Recorded history" : "Partial recorded history"}${metrics.stale ? " · delayed" : ""} · ${metrics.coverage.lastHistoryIndexedAt ? `checked ${stamp(metrics.coverage.lastHistoryIndexedAt)}` : "check time unavailable"}`,
    captured: stamp(capturedAt),
    link: link.toString(),
    filename: `paperclub-pnl-${options.layout}.png`,
    shareText: `${pnl} realized P&L · ${paper} PAPER owned · paperclub`,
  };
}
