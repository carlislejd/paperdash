# Papertrade data sources — October 9, 2026

This is a read-only investigation of the current official exchange frontend and a small set of unauthenticated HTTP probes. It documents feasible inputs for a community dashboard; it is not a supported API contract or a claim of complete historical coverage. No account actions or transactions were submitted.

Selected public source bundles, current extracted docs, the Render schema and a SHA-256 manifest are preserved in [sources/dashboard-2026-10-09](sources/dashboard-2026-10-09/manifest.json). The earlier research snapshots remain unchanged.

## Findings

Papertrade already exposes global trading activity, protocol aggregates, an account directory, account trade/cashflow history, and a live account stream. A useful dashboard can start with these sources without operating a blockchain node. A durable index still needs either a supported replay/export agreement or verified contract events and a reliable RPC provider: the public trade ticker is not a complete ledger.

The current application loads at [exchange.papertrade.xyz/trade/btc](https://exchange.papertrade.xyz/trade/btc). The bare exchange root returned HTTP 404 in this investigation; that did not mean the exchange was offline.

### Evidence levels

- **Source-confirmed:** routes, response validators, transport settings, and deployment values recovered from JavaScript publicly loaded by the official application.
- **Probe-confirmed:** an unauthenticated read succeeded during this research run. This does not establish a rate-limit allowance, SLA, retention guarantee, cross-origin browser access, or permission to depend on undocumented endpoints indefinitely.
- **Unresolved:** contract ABI/deployment-block verification, completeness, operational limits, and exact account-count semantics.

## Origins and transports

| Purpose | Origin or endpoint | Evidence |
| --- | --- | --- |
| Exchange REST and account SSE | `https://exchange.papertrade.xyz` | Official page metadata and relative frontend requests |
| Global live data | `wss://stream.papertrade.xyz/connection/websocket` | Metadata plus frontend URL construction |
| Signing service | `https://sign.papertrade.xyz` | Official metadata; unnecessary for read-only analytics |
| Preview service | `https://preview.papertrade.xyz` | Official metadata; unnecessary for the initial data pipeline |
| HyperEVM RPC | `https://rpc.hyperliquid.xyz/evm` | Published frontend deployment configuration |
| Hyperliquid market prices | `wss://api.hyperliquid.xyz/ws` | Published frontend deployment configuration |

Global streams use the Centrifuge client protocol, not arbitrary JSON pushed to a raw WebSocket. The frontend constructs the client and subscribes to the public channels below without a token/getToken option. Account streaming is a separate EventSource connection with `withCredentials: true`; that setting alone does not prove authentication is required.

REST requests set `Accept: application/json`, use same-origin credentials, reject redirects, and apply a ten-second timeout. The client recognizes 401/403 and 429 responses and respects `Retry-After`. Run shared ingestion on our backend and cache/fan out results; do not multiply upstream polling by the number of visitors.

Sources: [main application bundle](https://exchange.papertrade.xyz/assets/index-CvChIo_I.js), [deployment and request helpers](https://exchange.papertrade.xyz/assets/deployment-C3VOxZVa.js), [query client](https://exchange.papertrade.xyz/assets/query-api-client-DGxZQjmt.js), [account hooks](https://exchange.papertrade.xyz/assets/hooks-C8jAqgfJ.js).

## Global data

All HTTP paths in this report use `https://exchange.papertrade.xyz` as their base.

| Source | Parameters and returned data | Important limit |
| --- | --- | --- |
| WebSocket channel `public:trades` | Batches of 1–20 events: `ts`, `wallet`, `instrument`, `side`, `leverage`, `notionalUsd`, `kind`, `pnlUsd`; kinds are `open`, `close`, `liq` | Stream validator has no transaction hash, position ID, block/log index, or sequence ID. The client explicitly rejects a recoverable/recovering subscription. |
| `GET /query/protocol/trades/recent` | `{ok, events}`; ticker fields plus decimal-string `seq` | Frontend validator caps results at 50. No pagination/backfill parameter is evidenced. Official UI polls every 15 seconds. |
| `GET /query/protocol/summary` | `source:{block,at,genesis}`; `balances:{tvl,margin,lp,reserve,queue}`; `activity:{volume,open}`; fee totals and PAPER state | Official UI polls every second. Preserve the source block/time. |
| `GET /query/protocol/history?interval=1d` | Columnar history, start/interval, source revision/generation, totals. Series include TVL, users, trades, volume, trader P&L, liquidations, PAPER supply/staking/revenue. | Evidenced intervals: `1m`, `1h`, `1d`; frontend allows up to 5,000 points subject to interval window. |
| `GET /state/trading` and channel `trading:current` | Schema version 1, indexed block, instrument configuration, open interest/caps, current fee/liquidation inputs, trade limits, pause/intake state | Use actual current configuration for estimated values rather than Paperplay's launch-parameter snapshot. |
| Channel `pressure:current` | Queue/gas health, canonical block information, `source:"relayer-postgres"`, and queue preview; supports Fossil deltas | Preview has at most ten intents with ID/action/priority/gas/accepted-time. It has no wallet/side/size. This is not a full global pending-order feed. |

Source: [main bundle](https://exchange.papertrade.xyz/assets/index-CvChIo_I.js), notably functions `og`, `cg`, `rh`, `Cm`, `Hy`, and `Wy`; [trading/account wire validators](https://exchange.papertrade.xyz/assets/account-wire-oK7wgoTe.js).

### Account directory

The frontend issues:

```text
GET /state/leaderboard/accounts?window=all&sortKey=totalWindowedPnl&sortDir=desc&page=0&pageSize=25
```

- `window`: `24h`, `7d`, `30d`, `all`.
- `page`: zero-based; frontend validates 0–1,000,000.
- `pageSize`: frontend sends 25. Other server-supported sizes are unverified.
- `sortDir`: `asc` or `desc`.
- `sortKey`: `rank`, `address`, `lastActiveTs`, `totalWindowedPnl`, `realizedPnl`, `currentUnrealizedPnl`, `currentBalance`, `currentQueued`, `currentOpenNotional`, `totalVolume`, `paperTotal`, `currentOpenPositionCount`.
- Optional `q`: normalized search text, capped at 42 characters by the frontend.

Response: `{ok,count,summary,accounts,pageInfo}`. Summary contains `uniqueAccounts`, `trackedBalance`, `trackedQueued`, `trackedOpenNotional`, `trackedPaper`; pagination includes current `page` and `totalPages`. Rows contain address, optional leaderboard name, realized/window P&L, volume, last activity, balance, queued amount, open position count/notional, unrealized P&L, PAPER total, and rank. Most amounts are integer strings.

Use this as a discovery source, but do not silently equate its count with all depositors, all ever-seen wallets, or human users. Its inclusion rules and historical completeness remain unverified. Account placement is available separately at `/state/leaderboard/accounts/<address>?window=all`; closed-position rankings use `/state/leaderboard/positions?window=all`.

Source: [main bundle](https://exchange.papertrade.xyz/assets/index-CvChIo_I.js), directory builder `r_`, validators `qg`/`Yg`, and search validator `Qg`.

## Wallet detail and history

The official app has a read-only viewed-account mode selected by the `view` search parameter. Account data is keyed by the viewed address, independently of the connected wallet.

| Source | Parameters and schema |
| --- | --- |
| `GET /state/user/live?wallet=<address>` | SSE event names `wallet`, `heartbeat`, `liveness`; full snapshots and revision-based patches. |
| `GET /query/accounts/<address>/trades?filter=all&limit=75` | Optional `cursor`; `{items,nextCursor}`. Known filters include `all` and `losses`. Items are **closed/liquidated positions**, with transaction hash, position ID, instrument, direction, opening/closing times, raw entry/exit/margin/P&L/fee/PAPER fields. |
| `GET /query/accounts/<address>/cashflows?limit=75` | Optional `cursor`; deposits and withdrawals with `timestampMs`, `txHash`, `amountRaw`, optional recipient amount, route, withdrawal status. |
| `GET /query/accounts/<address>/portfolio-history?range=all` | Range `1h`, `1d`, `1w`, `all`; equity/P&L samples, source revision/generation, explicit `coverage.complete` and available-from/to timestamps. |
| `GET /query/accounts/<address>/staking?limit=75` | Cursor-paginated `staked`, `unstaked`, `claimed` events. |
| `GET /query/accounts/<address>/queue?limit=75` | Cursor-paginated `enqueued`, `harvested`, `debt_consumed` events. |

The history parser accepts up to 200 records but the application requests 75. Only the latter behavior is confirmed. The client canonicalizes query parameter order, rejects repeated cursors, refreshes first pages every 30 seconds, and treats older cursor pages as immutable in cache. The successful trade probe used sorted parameters `filter=all&limit=75`.

Wallet snapshots include `accountRevision`, `walletRevision`, `indexedThroughBlock`, `indexedThroughTimestamp`, balance/queued/locked funds, open positions, operation status, PAPER state, and lifetime totals:

```text
depositedRaw, withdrawnRaw, realizedPnlRaw, feesPaidRaw,
tradedNotionalRaw, paperRewardsClaimedRaw
```

Patches have `baseAccountRevision` and add/remove position and operation lists. Missing/mismatched base revisions require a fresh snapshot. Open-position tuples include position ID, instrument, side, debt flag, entry, margin, leverage, bust price, opening time, and optional intent ID.

Cashflow withdrawal statuses include `signed`, `submitted`, `in_transit`, `settled`, `needs_signature`, and `failed`. Preserve lifecycle status; do not treat every withdrawal row as a completed outflow. Deposit lifetime totals and deposit event sums should be reconciled independently of current account equity.

Sources: [main bundle](https://exchange.papertrade.xyz/assets/index-CvChIo_I.js), history builders `yg`/`bg` and portfolio builder `kh`; [account hooks](https://exchange.papertrade.xyz/assets/hooks-C8jAqgfJ.js), `ge` and viewed-account hooks; [wire/stream implementation](https://exchange.papertrade.xyz/assets/account-wire-oK7wgoTe.js), `mn`, `Zn`, and `Qn`.

## Published deployment values

These are public frontend configuration values, not independently verified deployment history. Chain ID is **999, HyperEVM Mainnet**. A read-only `eth_getCode` probe of the exchange at `latest` returned 925 bytes of nonempty code; this establishes code existence, not verified source, ABI, or deployment-block correctness.

| Role | Published address |
| --- | --- |
| Exchange | `0x6cd5661646289fb6e65ea5c032310fded797d0a2` |
| PAPER | `0xe40f17915daa230324030003a197cdaef2261c0e` |
| PAPER staking | `0xaad6c7b0cc3014fc80ffedae0ed7ce5967b0f016` |
| Deposit proxy factory | `0x1629b7d46bef6e13ff754174fc9f32dea309b38f` |
| Collateral | `0x6b9e773128f453f5c2c60935ee2de2cbc5390a24` |
| Governance multisig | `0x696292762fd5ac3677a45edbe54eaece4194d1f6` |
| Governance timelock | `0xb915fa41e824d6aa31bb833ee81220c0f2c8ea0f` |

Collateral has six EVM decimals; application collateral scale is `10^(18-6)`. Internal accounting uses 18-decimal raw values. BTC is instrument 0 / asset index 0 / price scale 10; ETH is instrument 1 / asset index 1 / price scale 100. Do not convert all raw fields with one universal decimal rule.

The downloaded [execution bundle](https://exchange.papertrade.xyz/assets/execution-gYC4ZbKm.js) includes generic ABI tooling and ERC-20/funding operations, but no exchange `PositionOpened`/`PositionClosed` event definitions. **Canonical event ABI, actual deployment block, proxy/upgrade history, and old deployments remain prerequisites for a complete chain indexer.**

Source: [deployment bundle](https://exchange.papertrade.xyz/assets/deployment-C3VOxZVa.js).

## Probe results during this research run

The coordinating agent performed unauthenticated read-only requests and reported:

- Protocol summary: HTTP 200, including TVL raw value `66315849249545080000000000` (about $66.316 million at 18 decimals).
- Account directory: HTTP 200, returning a reported count of 5,902 accounts.
- A sampled account's cashflows: HTTP 200 with three deposits totaling $10,779, consistent with its observed current balance at that moment. This single-account check does not establish global reconciliation.
- That account's sorted trade-history request: HTTP 200 with an empty history.
- Portfolio history: HTTP 200 and `coverage.complete: false`.
- Account SSE: HTTP 200 without authentication, followed by a wallet snapshot containing lifetime `depositedRaw: "10779000000000000000000"` and the same raw balance. The sampled wallet's full address is intentionally omitted from this report.
- Global WebSocket: an unauthenticated connection and subscription to `public:trades` were accepted. No trade execution arrived during the short probe, so transport/subscription access is confirmed while an actual event payload remains source-confirmed.

Counts and monetary values are observations, not stable product copy. The successful probes came from the coordinating agent's approved read-only HTTP/WebSocket/RPC path.

## Consequences for implementation

1. A shared upstream collector can support a live trade feed, account exploration, deposits/withdrawals, TVL, and protocol statistics immediately after access/stability checks.
2. Persist exact raw events and source revisions. Treat the public ticker as fast display input, not the authoritative ledger. Its missing IDs and lack of demonstrated replay prevent completeness guarantees.
3. Separate executed trades, pending actions, current positions, estimated mark-to-market, and settled cashflows. No complete global pre-execution order feed was established.
4. Display history coverage and last-indexed timestamps. Build backfill, deduplication, cursor recovery, reconciliation, and reorg handling before making claims of all-time completeness.
5. Start with managed RPC or a provider/partner export. Owning an application indexer is useful; owning a full blockchain node is not established as necessary.

## Visual reference notes

Paperplay supplies cream/charcoal styling, large tabular numerals, restrained risk colors, and clear after-deduction P&L labels. It has no wallet history or manga assets. The separate sibling project is at `/Users/carlisle/Documents/projects/paperplay`.

The official exchange's [theme module](https://exchange.papertrade.xyz/assets/theme-CHBWm7vo.js) stores light/dark preference and forces light mode for mobile routes. [AccountViewControl](https://exchange.papertrade.xyz/assets/AccountViewControl-Ch5-QX1u.js) labels the dark-theme switch **UwU Mode**. The [desktop shell](https://exchange.papertrade.xyz/assets/_desktop-CaJam4Fm.js) uses a lowercase papertrade wordmark with blinking underscore.

The [gates module](https://exchange.papertrade.xyz/assets/gates-DsIJPrST.js) renders optional controls and character settings only in dark/UwU mode. It lazily imports `uwu-controls-CLAOVKkq.js` (including `CharacterSetting`) and `uwu-chart-CT35KXfS.js`; dependency references include `uwu-audio-CaBXV1Fz.js`, `uwu-stars-v1-DV4eWU76.js`, and associated CSS. This directly establishes optional character/chart/audio/stars features and deferred loading. Exact character artwork was not inspected in those downstream assets. A manga editorial direction is a new design interpretation of the user's requested playfulness, not recovered artwork from the analyzed files.
