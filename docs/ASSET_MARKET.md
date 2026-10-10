# Asset price line and trade bubbles

Verified **2026-10-10** through the official frontend, Hyperliquid documentation, one short public Papertrade subscription and one public Hyperliquid connection with BTC/ETH subscriptions. No account actions were submitted.

## Execution prices

Reuse the collector's existing `public:trades` subscription at `wss://stream.papertrade.xyz/connection/websocket`. A live publication contained a closed ETH position with `ts: 1791642242000`, `seq: 48175329000031`, `positionId: 1903`, `instrumentId: 1`, `entry: null`, `exit: 2498.45`, `notionalUsd: 10000000` and its wallet address. Subscription recovery was disabled. The public recent-trades REST response also supplies prices, with sequence/position IDs represented as strings in the observed response rather than the WebSocket's numbers. These are observed public fields, not a versioned API guarantee. [Official exchange](https://exchange.papertrade.xyz/trade/btc), [recent trades](https://exchange.papertrade.xyz/query/protocol/trades/recent).

| Field | Chart meaning |
| --- | --- |
| `ts` | Execution time, epoch milliseconds in verified samples. |
| `entry` | Opening execution price, a USD number; use only for `kind: open`. |
| `exit` | Closing/liquidation execution price, a USD number; use for `kind: close` or `liq`. |
| `notionalUsd` | Source-reported USD notional for bubble sizing. |
| `wallet` | Public wallet address for the clickable feed/profile. |
| `side` | Position direction, `long` or `short`; it is not a generic buy/sell action label. |

These prices are already USD, with no 18-decimal conversion. Independently, the verified wallet outcome for position 195 had `exitPriceRaw: "249715"`, `priceScaleRaw: "100"`, and the recent feed's `exit: 2497.15`. [Position sample and definitions](POSITION_METRICS.md).

The minimal added event field is `priceUsd?: number | null`. Accept only finite positive numeric metadata; malformed, null or absent prices must not discard an otherwise valid execution. Do not substitute `exit` for a missing opening price, substitute `entry` for a missing closing price, or pass through an unverified client-supplied `priceUsd` field. Preserve legacy event IDs and economic fingerprints when adding this metadata so enrichment does not create another execution.

Older retained events may lack prices. Keep them in the activity feed with an unavailable-price state; do not depict a nearest market quote as an exact execution price. Recent REST recovery remains bounded to the source's short response, and the observed WebSocket provides no replay guarantee. Neither source establishes a complete execution ledger.

## Continuous reference line

Use one collector connection to `wss://api.hyperliquid.xyz/ws` and send one subscription per asset:

```json
{"method":"subscribe","subscription":{"type":"bbo","coin":"BTC"}}
{"method":"subscribe","subscription":{"type":"bbo","coin":"ETH"}}
```

Each `channel: "bbo"` frame has `data: {coin,time,bbo:[bid,ask]}`. Each side can be null; otherwise `px` is a decimal price string, with `sz` and `n` alongside it. The observed `time` is epoch milliseconds. The verified quotes were BTC `82785.0`/`82786.0` and ETH `2498.4`/`2498.5`. Use the bid/ask midpoint for a line explicitly labeled **Hyperliquid mid**. BBO updates occur only when the best quote changes; an unchanged quote's timestamp and a failed connection are different conditions. [Official subscription and frame definitions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions).

The official Papertrade frontend also subscribes to Hyperliquid BBO. Its quote decoder computes both a midpoint and a size-weighted display price; our simple midpoint should not be labeled as an exact copy of every official chart value or a Papertrade execution price. [Official quote decoder](https://exchange.papertrade.xyz/assets/focus-DkFX2CTr.js).

Retain source time, receipt time, connection state and discontinuities. Reject invalid, crossed or nonpositive quotes; do not draw through a known disconnect/restart gap or invent intervening ticks. Share bounded cached points and live updates through our API/SSE, independent of viewer count. Send a periodic protocol ping and monitor its pong; Hyperliquid documents a 60-second idle timeout. [Heartbeats](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/timeouts-and-heartbeats).

There is no verified historical BBO replay source in this investigation. If historical candles are later used to seed a chart, keep their close-price semantics distinct from midpoint samples: Hyperliquid's `candleSnapshot` supplies at most the latest 5,000 candles, with epoch-millisecond range parameters. Starting with visibly limited observed history is truthful. [Candle snapshot](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#candle-snapshot).

## Implemented dashboard contract

`GET /api/assets/0/market` (BTC) and `/api/assets/1/market` (ETH) read the collector's saved one-hour view, bounded to 720 price points and 200 visible trade observations. Coverage remains explicitly partial; `tradesCapped` reports truncation. The collector coalesces quotes to the latest pending observation per asset, flushes at most once per second, and retains the latest genuine quote in each five-second bucket. Exposed point `time` remains the actual source timestamp, not the bucket boundary.

SSE `asset-price` messages carry `{instrument, point: {time, priceUsd, gapBefore?}, receivedAt}`. The first accepted quote for each asset after connection/startup has `gapBefore: true`. Buffer replacement, persistence retries, later updates in that same storage bucket, and frontend merging preserve the marker. Price writes and their retained SSE notifications commit atomically; the chart breaks the line before marked points. Additive PostgreSQL/SQLite migrations preserve existing samples with a default unmarked gap field.

Market responses combine quote connection/age, saved-view age and the existing Papertrade activity-feed health checks. A connected reference-price feed alone does not make a failed trade feed current. Invalid optional execution-price metadata leaves the execution visible without inventing a price, and price enrichment leaves existing observation IDs and economic fingerprints unchanged.
