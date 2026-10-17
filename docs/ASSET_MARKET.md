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

`GET /api/assets/0/market` (BTC) and `/api/assets/1/market` (ETH) read the collector's saved one-hour view, bounded to 720 price points and 200 recent visible trade observations. Coverage remains explicitly partial; `tradesCapped` reports truncation of that recent list. The collector coalesces quotes to the latest pending observation per asset, flushes at most once per second, and retains the latest genuine quote in each five-second bucket. Exposed point `time` remains the actual source timestamp, not the bucket boundary.

The optional `window=5m|15m|1h` parameter (default `1h`) selects a separate `chartSample`; it does not change the one-hour price history or turn the recent list into a complete trade ledger. The collector prepares all three cohorts every five seconds from retained, priced observations. Each cohort takes the two largest notionals per epoch-aligned bucket: ten seconds for 5m, thirty seconds for 15m, and two minutes for 1h. With clipped edge buckets, each response includes at most 62 sampled trades. Only the selected cohort is returned. API caches distinguish windows and trader segments. The fixed asset/window URLs, including canonical `?window=15m&segment=profitable` and explicit `segment=all` variants, remain eligible for shared edge caching. Viewer requests do not run the sampling query.

`chartSample` reports `windowFrom`, `windowTo`, `bucketMs`, `perBucket: 2`, `selection: "largest-notional-per-time-bucket"`, `partial: true`, and `trades`. Source-overlap matching uses existing economic fingerprints and priced-source multiplicity; adding a price does not create a new execution. Missing, invalid or nonpositive execution prices are excluded from the sample. Older snapshots may omit `chartSample`; clients then label their bounded recent-trade fallback explicitly.

The chart defaults to **All traders**, with **Profitable traders** as the alternative. There is no minimum-notional filter; bubble size still represents notional. Both bubbles and the linked sidebar use the selected segment. In All traders, live arrivals are merged into bounded per-bucket candidates so a burst cannot evict earlier buckets merely by filling the recent-trade buffer. Times and execution prices are unchanged, and quiet or unobserved intervals remain empty. This is a visualization sample, never a total trade count or a claim of complete coverage. Unpriced recent trades can remain in the feed without a chart bubble. The separate rolling-24h Recent activity table continues to show all traders and is labeled accordingly.

### Profitable traders

`segment=all|profitable` defaults to `all`. Profitable traders shows **position openings** from wallets whose latest retained account has strictly positive **lifetime realized trading P&L** across markets. Staking rewards, open-position P&L and rolling-window P&L do not determine membership. Classification describes the latest checked account, not the wallet's profitability at the historical time of entry. The UI states this distinction.

The collector classifies unique opening wallets in its retained one-hour instrument window through indexed account-summary lookups. Account receipts must be no older than five minutes at classification; missing, malformed, future-dated or older accounts remain unknown and are excluded. It filters qualifying opens before both the recent-list cap and per-bucket chart sampling, so a smaller qualifying entry can survive when larger unprofitable observations occupy the same bucket. No new upstream requests or wallet crawls are triggered by this feature.

`segmentCoverage` reports `basis: "positive-lifetime-realized-trading-pnl"`, `classifiedAt`, `maxAccountAgeMs`, `observedWallets`, `classifiedWallets`, `profitableWallets`, `unknownWallets`, and the oldest/newest classified account receipt clocks. Counts describe unique opening wallets in the retained one-hour window, independently of the selected chart window and visible sample. Unknown is not equivalent to unprofitable. Coverage is partial even when every observed wallet is classified.

Profitable mode waits for the collector's classified snapshots instead of merging unclassified raw trade SSE messages. A missing, mismatched, failed or older-than-60-second classification snapshot is unavailable; the client does not substitute All traders. Legacy snapshots without segment metadata remain usable only in All traders mode. Price SSE updates remain independent of trader classification.

SSE `asset-price` messages carry `{instrument, point: {time, priceUsd, gapBefore?}, receivedAt}`. The first accepted quote for each asset after connection/startup has `gapBefore: true`. Buffer replacement, persistence retries, later updates in that same storage bucket, and frontend merging preserve the marker. Price writes and their retained SSE notifications commit atomically; the chart breaks the line before marked points. Additive PostgreSQL/SQLite migrations preserve existing samples with a default unmarked gap field.

Market responses combine quote connection/age, saved-view age and the existing Papertrade activity-feed health checks. A connected reference-price feed alone does not make a failed trade feed current. Invalid optional execution-price metadata leaves the execution visible without inventing a price, and price enrichment leaves existing observation IDs and economic fingerprints unchanged.
