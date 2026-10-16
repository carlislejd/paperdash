import { VERIFIED_PROTOCOL_GENESIS } from "./staking-yield.js";

/** The announced public trading start, corroborated by the first active hour
 * in the official protocol history. The preceding complete hour reports zero
 * cumulative allocations. This is a launch-window cutoff, not the timestamp
 * of the first execution. See docs/evidence/2026-10-16-trading-launch-verification.json.
 * Keep deployment identity and deposit/TVL history independent of this cutoff. */
export const VERIFIED_TRADING_WINDOW = Object.freeze({
  genesis: VERIFIED_PROTOCOL_GENESIS,
  fromMs: 1791640800000, // 2026-10-10T14:00:00.000Z
  baselineRewardsRaw: "0",
  cutoffBasis: "announced-trading-start" as const,
});
