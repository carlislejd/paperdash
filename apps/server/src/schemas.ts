import { createHash } from "node:crypto";
import { z } from "zod";
import type { TradeEvent } from "../../../packages/shared/src/types.js";

export const addressSchema = z
  .string()
  .regex(/^0x[\da-fA-F]{40}$/)
  .transform((v) => v.toLowerCase());
export const rawSchema = z
  .string()
  .max(79)
  .regex(/^(0|-?[1-9]\d*)$/);
const uint = z
  .string()
  .max(78)
  .regex(/^(0|[1-9]\d*)$/);
const time = z.number().int().nonnegative().safe();
const hash = z.string().regex(/^0x[\da-fA-F]{64}$/);
export const summarySchema = z.object({
  ok: z.boolean().default(true),
  source: z.object({ block: uint, at: time, genesis: time.optional() }),
  balances: z.object({
    tvl: uint,
    margin: uint,
    lp: uint,
    reserve: uint,
    queue: uint,
  }),
  activity: z.object({ volume: uint, open: time }),
  fees: z.object({ pending: uint, lifetime: uint }),
  paper: z.object({ supply: uint, staked: uint }).catchall(rawSchema),
});
export const accountSchema = z.object({
  address: addressSchema,
  leaderboardName: z.string().max(200).nullable(),
  currentBalance: rawSchema,
  currentQueued: rawSchema,
  currentOpenNotional: uint,
  currentOpenPositionCount: time,
  currentUnrealizedPnl: rawSchema,
  realizedPnl: rawSchema,
  totalVolume: uint,
  totalWindowedPnl: rawSchema,
  paperTotal: uint,
  lastActiveTs: time,
});
export const accountsSchema = z.object({
  ok: z.literal(true),
  accounts: z.array(accountSchema).max(200),
  count: time,
  summary: z.object({
    uniqueAccounts: time,
    trackedBalance: rawSchema,
    trackedQueued: rawSchema,
    trackedOpenNotional: uint,
    trackedPaper: uint,
  }),
  pageInfo: z.object({ page: time, totalPages: z.number().int().positive() }),
});
export const cashflowSchema = z.object({
  timestampMs: time,
  txHash: hash,
  amountRaw: uint,
  kind: z.enum(["Deposit", "Withdrawal"]),
  recipientAmountRaw: uint.nullable(),
  route: z.string().max(50).nullable(),
  withdrawalStatus: z
    .enum([
      "signed",
      "submitted",
      "in_transit",
      "settled",
      "needs_signature",
      "failed",
    ])
    .nullable(),
});
export const closedTradeSchema = z.object({
  timestampMs: time,
  txHash: hash,
  positionId: uint,
  instrumentId: time,
  symbol: z.string().min(1).max(32),
  assetIndex: time,
  priceScaleRaw: uint,
  terminal: z.boolean(),
  retired: z.boolean(),
  isLong: z.boolean(),
  entryPriceRaw: uint,
  marginRaw: uint,
  leverage: z.number().int().positive(),
  kind: z.enum(["PositionClosed", "Liquidated"]),
  openedAtMs: time,
  exitPriceRaw: uint,
  adjustedPnlRaw: rawSchema,
  userPaidFeeRaw: uint,
  paperMintedRaw: uint,
  paperMintBasisRaw: uint,
  paperMintBatchTotalRaw: uint.nullable(),
});
export const cursorSchema = z.string().min(1).max(2048);
export const historySchema = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item).max(200),
    nextCursor: cursorSchema.nullable(),
  });
const positionSchema = z.tuple([
  uint,
  time,
  z.boolean(),
  z.boolean(),
  uint,
  uint,
  z.number().int().positive(),
  uint,
  time,
  hash.nullable(),
]);
export const walletSchema = z.object({
  address: addressSchema,
  indexedThroughBlock: time,
  indexedThroughTimestamp: time,
  accountRevision: time,
  balance: uint,
  queued: uint,
  locked: uint,
  lifetime: z.object({
    depositedRaw: uint,
    withdrawnRaw: uint,
    realizedPnlRaw: rawSchema,
    feesPaidRaw: uint,
    tradedNotionalRaw: uint,
    paperRewardsClaimedRaw: uint,
  }),
  paper: z.object({
    balance: uint,
    staked: uint,
    pendingBase: uint.optional(),
  }),
  openPositions: z.array(positionSchema).max(10000),
}); // Zod strips session keys, operations, and all other unexposed fields.
export const portfolioSchema = z
  .object({
    fromMs: time.optional(),
    toMs: time.optional(),
    intervalMs: z.number().int().positive().optional(),
    source: z
      .object({
        asOfMs: time,
        revision: z.string().regex(/^\d+:\d+$/),
        generation: z.string().min(1).max(256),
      })
      .optional(),
    series: z.literal("portfolio").optional(),
    aggregation: z.string().max(50).optional(),
    baseTimeMs: time,
    timeOffsetsMs: z.array(time).max(10000),
    columns: z.object({
      equity: z.array(z.number().finite()).max(10000),
      pnl: z.array(z.number().finite()).max(10000),
    }),
    gapIndices: z.array(time).max(10000),
    coverage: z.object({
      availableFromMs: time.nullable(),
      availableToMs: time.nullable(),
      complete: z.boolean(),
    }),
  })
  .refine(
    (v) =>
      v.columns.equity.length === v.timeOffsetsMs.length &&
      v.columns.pnl.length === v.timeOffsetsMs.length &&
      v.timeOffsetsMs.every((n, i, a) => !i || n >= a[i - 1]) &&
      v.gapIndices.every((i) => i < v.timeOffsetsMs.length),
    "Inconsistent portfolio columns",
  );
export const protocolHistorySchema = z
  .object({
    startMs: time,
    intervalMs: z.number().int().positive(),
    source: z.object({
      asOfMs: time,
      revision: uint,
      generation: z.string().min(1),
    }),
    columns: z
      .object({ tvl: z.array(z.number().finite().nullable()).max(5000) })
      .catchall(z.array(z.number().finite().nullable()).max(5000)),
  })
  .passthrough();
const tickerSchema = z.object({
  ts: z.union([
    z.number().finite().positive(),
    z.string().regex(/^\d+$/).transform(Number),
  ]),
  wallet: addressSchema,
  instrument: z.union([z.string(), z.number().int()]),
  side: z.enum(["long", "short"]),
  leverage: z.number().finite().positive(),
  notionalUsd: z.number().finite().nonnegative(),
  kind: z.enum(["open", "close", "liq"]),
  pnlUsd: z.number().finite().nullable(),
  seq: uint.optional(),
});
export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function normalizeTrade(
  input: unknown,
  provenance: TradeEvent["provenance"],
  observationId?: string,
): TradeEvent {
  const t = tickerSchema.parse(input);
  if (provenance === "recent-api" && t.seq === undefined)
    throw new Error("Recent trade is missing its sequence ID");
  if (
    typeof t.instrument === "string" &&
    !["BTC", "ETH"].includes(t.instrument) &&
    !/^\d+$/.test(t.instrument)
  )
    throw new Error("Unknown trade instrument");
  const instrument =
    t.instrument === "BTC"
      ? 0
      : t.instrument === "ETH"
        ? 1
        : Number(t.instrument);
  if (!Number.isInteger(instrument) || instrument < 0)
    throw new Error("Unknown trade instrument");
  const ts = t.ts < 1e12 ? t.ts * 1000 : t.ts;
  if (!Number.isSafeInteger(ts)) throw new Error("Invalid trade timestamp");
  const fields = {
    ts,
    wallet: t.wallet,
    instrument,
    side: t.side,
    leverage: t.leverage,
    notionalUsd: t.notionalUsd,
    kind: t.kind,
    pnlUsd: t.pnlUsd,
  };
  // A public stream has no execution ID: retain every actual received event.
  // Recent responses have sequence IDs; include content to survive sequence resets.
  return {
    id: t.seq
      ? `recent:${t.seq}:${digest(fields).slice(0, 16)}`
      : `stream:${observationId ?? digest(fields)}`,
    ...fields,
    provenance,
  };
}
export const sorts = [
  "currentBalance",
  "lastActiveTs",
  "totalWindowedPnl",
  "realizedPnl",
  "totalVolume",
  "currentOpenNotional",
] as const;
export const accountsQuerySchema = z.object({
  q: z.string().max(42).default(""),
  sort: z.enum(sorts).default("currentBalance"),
  page: z.coerce.number().int().min(0).max(1000000).default(0),
});
