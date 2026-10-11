import type { TradeEvent } from "../../../packages/shared/src/types.js";
export const sampleNow = 1_800_000_005_123;
export const sampleTrade = (
  id: string,
  fields: Partial<TradeEvent> = {},
): TradeEvent => ({
  id,
  ts: sampleNow - 1000,
  wallet: `0x${"1".repeat(40)}`,
  instrument: 0,
  side: "long",
  leverage: 50,
  kind: "open",
  notionalUsd: 100,
  pnlUsd: null,
  priceUsd: 110000,
  provenance: "public-stream",
  ...fields,
});
export function sampleFixtures(): TradeEvent[] {
  return [
    sampleTrade("hour-edge", { ts: sampleNow - 3600000, notionalUsd: 30e9 }),
    sampleTrade("older-hour", { ts: sampleNow - 3600001, notionalUsd: 40e9 }),
    sampleTrade("far", { ts: sampleNow - 2700000, notionalUsd: 20e9 }),
    sampleTrade("quarter-edge", { ts: sampleNow - 900000, notionalUsd: 12e9 }),
    sampleTrade("five-edge", { ts: sampleNow - 300000, notionalUsd: 8e9 }),
    sampleTrade("before-five", { ts: sampleNow - 300001, notionalUsd: 9e9 }),
    sampleTrade("inside-five", { ts: sampleNow - 240000, notionalUsd: 7e9 }),
    sampleTrade("stream-a", { ts: sampleNow - 150000, notionalUsd: 5e8 }),
    sampleTrade("stream-b", { ts: sampleNow - 150000, notionalUsd: 5e8 }),
    sampleTrade("rest-unpriced-a", {
      ts: sampleNow - 150000,
      notionalUsd: 5e8,
      provenance: "recent-api",
      priceUsd: null,
    }),
    sampleTrade("rest-unpriced-b", {
      ts: sampleNow - 150000,
      notionalUsd: 5e8,
      provenance: "recent-api",
      priceUsd: null,
    }),
    sampleTrade("overlap-stream-a", {
      ts: sampleNow - 60000,
      notionalUsd: 3e8,
    }),
    sampleTrade("overlap-stream-b", {
      ts: sampleNow - 60000,
      notionalUsd: 3e8,
    }),
    sampleTrade("overlap-rest-a", {
      ts: sampleNow - 60000,
      notionalUsd: 3e8,
      provenance: "recent-api",
    }),
    sampleTrade("overlap-rest-b", {
      ts: sampleNow - 60000,
      notionalUsd: 3e8,
      provenance: "recent-api",
    }),
    sampleTrade("now-largest", { ts: sampleNow, notionalUsd: 10e9 }),
    sampleTrade("now-second", { ts: sampleNow - 1, notionalUsd: 1e9 }),
    sampleTrade("unpriced-largest", {
      ts: sampleNow - 2,
      notionalUsd: 100e9,
      priceUsd: null,
    }),
    sampleTrade("future", { ts: sampleNow + 1, notionalUsd: 200e9 }),
    sampleTrade("eth", { ts: sampleNow - 1000, instrument: 1, priceUsd: 4000 }),
    ...[0, -1, NaN, Infinity, "123" as unknown as number].map((priceUsd, i) =>
      sampleTrade(`bad-price-${i}`, {
        ts: sampleNow - 100000 - i * 10000,
        notionalUsd: 50e9,
        priceUsd,
      }),
    ),
  ];
}
