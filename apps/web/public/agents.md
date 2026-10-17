# Paperclub agent guide

Public, read-only Papertrade analytics. Use this guide to answer questions about TVL, PAPER, wallets, PnL, positions and observed trading activity.

- Website: https://papertrade.club/
- This guide: https://papertrade.club/agents.md
- JSON API base: https://paperdash-api.onrender.com
- Standalone CLI: https://papertrade.club/paperclub.mjs
- Authentication: none. All documented requests are GET requests.
- Contract checked: October 11, 2026.

## Quick start

Use direct HTTP or download the dependency-free CLI (Node.js 24):

```sh
curl --fail --show-error --location --max-time 20 \
  https://papertrade.club/paperclub.mjs -o paperclub.mjs
node paperclub.mjs --help
node paperclub.mjs overview --pretty
node paperclub.mjs wallets --sort currentUnrealizedPnl --page 0 --pretty
node paperclub.mjs leaderboard --metric pnl --page 0 --pretty
node paperclub.mjs leaderboard --metric paper --page 0 --pretty
node paperclub.mjs leaderboard --metric paper --window 24h --page 0 --pretty
node paperclub.mjs assets --pretty
node paperclub.mjs paper --pretty
node paperclub.mjs risk 0x1234567890123456789012345678901234567890 --pretty
```

The CLI prints one JSON object: `{command,url,fetchedAt,data}`. Direct API responses are the contents of `data`, without that wrapper. Use a JSON parser, not formatted dashboard text. No account, wallet connection, signing key or repository access is needed.

## Match the question to the metric

| Question | GET path | Read these fields |
| --- | --- | --- |
| Current TVL, PAPER supply, staking revenue, open positions | `/api/overview` | `summary.balances.tvl`, `summary.paper.supply`, `summary.fees.lifetime`, `summary.activity.open` |
| Number of wallets | `/api/overview` | `accountCount` (may be unavailable) |
| Top current unrealized PnL | `/api/accounts?sort=currentUnrealizedPnl&page=0&pageSize=10` | `accounts[].currentUnrealizedPnl`, `address`, `leaderboardName`, `currentOpenPositionCount` |
| Top protocol-reported lifetime realized PnL | `/api/accounts?sort=realizedPnl&page=0&pageSize=10` | `accounts[].realizedPnl` |
| Rolling 24-hour PnL leaderboard | `/api/leaderboard?metric=pnl&page=0` | `rows[].pnlRaw`, `rank`, `address`, `leaderboardName` |
| Largest current PAPER owners, including staked tokens | `/api/leaderboard?metric=paper&window=all&page=0` | `rows[].paperTotalRaw`, `rank`, `paperOwnership`; lifetime realized `pnlRaw`, lifetime `volumeRaw`, retained-close `tradeCount` |
| Current PAPER owners with 24-hour companion statistics | `/api/leaderboard?metric=paper&window=24h&page=0` | `rows[].pnlRaw`, `volumeUsd`, `tradeCount`, `activityCoverage`; ownership ranking remains current |
| Most trades in the last 24 hours, by wallet | `/api/leaderboard?metric=trades&page=0` | `rows[].tradeCount` |
| Most observed volume in the last 24 hours, by wallet | `/api/leaderboard?metric=volume&page=0` | `rows[].volumeUsd` |
| Observed trade counts and volume over the last 24 hours | `/api/assets` | `assets[].activity.counts`, `.notionalUsd`, `.windowFrom`, `.windowTo` |
| BTC/ETH open interest and long/short share | `/api/assets` | `assets[].openInterest` |
| Wallet balances, staking and initial history pages | `/api/wallets/ADDRESS` | `snapshot`, `cashflows`, `trades`, `portfolio` |
| Wallet initial margin near recorded bust prices | `/api/wallets/ADDRESS` | `marginRisk.assets[].bands`, `.totals`, `.nearest`, snapshot/reference clocks and `coverage` |
| Retained summaries and recent activity for selected wallets | `/api/wallets/batch?addresses=ADDRESS,ADDRESS` | `rows[].account`, each row's `receivedAt`/`stale`, and `activity` |
| Wallet deposits/withdrawals | `/api/wallets/ADDRESS/cashflows` | `items`, `nextCursor`, `coverage` |
| Wallet closed-position history | `/api/wallets/ADDRESS/trades` | `items`, `nextCursor`, `coverage` |
| One position's margin, outcome and PAPER issuance | `/api/wallets/ADDRESS/trades` | Match `items[].positionId` within this wallet; inspect the outcome fields below and page with `nextCursor` if needed |
| House funds, PAPER staked, rewards, annualized reward allocations | `/api/house` | `house`, `paper`, `annualizedStakingRevenue` |
| What changed House Funds | `/api/house` | `change` with actual `fromMs`/`toMs`; component `history`, `houseStale`, `sourceAt` |
| PAPER economics, staker yield, participation and hourly/daily supply/reward changes | `/api/paper/economics` | `supplyRaw`, `stakedRaw`, `stakeRatioBps`, `allocatedRewardsRaw`, `pendingRewardsRaw`, `annualized`, optional `stakingYield`, `series`, optional `daily` |
| Liquidation totals over the last 1 or 24 hours | `/api/liquidations/stats` | `stats.hour`, `stats.day`, `windowTo` |
| Estimated margin in liquidated positions | `/api/liquidations/stats` | `stats.hour.estimatedMarginUsd`, `stats.day.estimatedMarginUsd`, and each `marginObservationCount` |
| Liquidations by asset, hourly chart and recent events | `/api/liquidations?instrument=0` | `stats`, `hourly`, `items`, `nextCursor` |
| Hourly TVL, volume, open-position and PAPER charts | `/api/protocol/charts` | `series`, `intervalMs`, per-series `coverage` |
| Average holding time and leverage | `/api/position-metrics` or `/api/wallets/ADDRESS/position-metrics` | Returned metrics and their coverage; based on indexed closed-position history |

Replace `ADDRESS` with a complete 42-character `0x` hexadecimal wallet address. Asset IDs: `0` = BTC, `1` = ETH.

### Top PnL example

```sh
curl --fail --show-error --max-time 20 \
  'https://paperdash-api.onrender.com/api/accounts?sort=currentUnrealizedPnl&page=0&pageSize=10'
node paperclub.mjs leaderboard --metric pnl --page 0 --pretty
```

Current unrealized PnL, lifetime realized PnL and rolling-24h PnL are different measures. If the user just asks for "top PnL", clarify the measure or explicitly state which one you chose. The rolling leaderboard's `pnlRaw` is protocol-reported window PnL; do not relabel it realized PnL. `currentUnrealizedPnlRaw`, when present in leaderboard rows, is a separate current snapshot. Directory `totalWindowedPnl` is not the rolling-24h leaderboard value.

For the dashboard's positive open-PnL leaders, filter current-uPnL rows to `currentUnrealizedPnl > 0` and exclude rows only when `currentOpenPositionCount` is explicitly zero. The count can be `null` when the source does not provide it; treat that as unavailable, never zero. A page may then contain fewer than ten qualifying wallets. Compare raw amounts with integer/decimal arithmetic.

### PAPER ownership

`node paperclub.mjs leaderboard --metric paper` ranks current **staked + unstaked PAPER**, not lifetime issuance or rewards. `window: "current"` describes ownership; `statsWindow` describes the companion columns. The CLI explicitly sends `window=all` by default: `pnlRaw` is source-reported lifetime realized PnL, and `volumeRaw` is exact source-reported lifetime notional in 18-decimal USD units. Direct API requests that omit `window` retain the legacy **24h** companion statistics; send `window=all` explicitly for lifetime statistics. Use `volumeRaw`, not the deliberately null `volumeUsd`. `tradeCount` means **recorded closes**, including retained closed and liquidated positions; it is not a lifetime all-execution count or guaranteed complete lifetime history.

Use `--window 24h` for protocol-reported rolling 24-hour `pnlRaw` and observed executions/volume (`tradeCount`, numeric `volumeUsd`) bounded by `activityCoverage.windowFrom/windowTo`. The PAPER ownership order stays current in either mode. The CLI accepts `--window` only with `leaderboard --metric paper`; other ranking commands retain their existing rolling 24-hour behavior. Inspect returned `statsWindow` before labeling columns; older responses can omit it and represent the previous 24-hour companion contract. PnL-ranked rows also expose `paperTotalRaw`; volume/trade rankings may leave it null. Keep all raw amounts as exact 18-decimal strings.

Lifetime recorded-close coverage is per row: `historyCoverage.indexedAt`, `backfillComplete`, `projectionPending`, `excludedCount` and `stale`. A null count is unavailable; zero is an available empty retained count, not proof the wallet never traded. An old check, unfinished backfill, pending projection or excluded rows must remain visible in the interpretation. Completed available backfill does not establish canonical lifetime completeness. Do not substitute a 24-hour count for this lifetime retained cohort.

`paperOwnership.trackedTotalRaw` is the source account directory's tracked PAPER total. It is not independently verified full protocol supply. `pageTotalRaw` sums this page; `pageShareBps / 100` is its percentage of tracked PAPER, or null when unavailable. The first page's share describes its returned leading accounts, not an arbitrary top-10 cohort. `count` counts accounts, including zero balances, not nonzero holders. Use `q=ADDRESS` or a name to find an account without crawling; ranks in filtered results apply to that filtered set, not the unfiltered global list. Ownership and source-account statistics share `accountReceivedAt` / `accountStale`; retained history and observed 24-hour activity have separate freshness.

### Wallet account freshness

Wallet PAPER ownership is `snapshot.paper.balance + snapshot.paper.staked`, summed as raw integers before applying 18 decimals. The balance alone excludes staked tokens.

`/api/wallets/ADDRESS` includes optional `accountFreshness` independently of retained history: `receivedAt` is when the account snapshot was fetched, `sourceAt` is its source indexing timestamp, `stale` marks delayed account data, and `refreshing` means a refresh is still running. A recently fetched snapshot can still have an older source timestamp. Do not use the whole response's `receivedAt` or `stale` as the account clock; those also include history. Older API responses can omit `accountFreshness`, so treat an absent clock as unknown.

If `refreshing` is true, a saved or absent snapshot may be replaced shortly. A client may make at most two follow-up reads two seconds apart, then return to its normal polling cadence. Respect error/backoff responses; do not repeatedly force refreshes or crawl wallets to warm snapshots.

### Trade counts and supported time ranges

```sh
node paperclub.mjs assets --pretty
node paperclub.mjs leaderboard --metric trades --page 0 --pretty
node paperclub.mjs liquidations --asset BTC --pretty
```

For BTC or ETH, use the matching entry in `/api/assets`. Report `activity.counts.total` and the actual `activity.windowFrom` / `windowTo` bounds. For the combined BTC+ETH count, sum those two totals only when both activities are available and both window bounds match. Include the stale state and coverage in the answer.

These counts mean **observed executions**, including opens, closes and liquidations. They are not unique positions, round trips, wallet counts or a guaranteed complete protocol ledger.

Supported windows today:

- All-execution counts and volume rankings: rolling 24 hours only.
- PAPER-ranked companion statistics: lifetime source PnL/volume and recorded closes by default, or rolling 24 hours with `--window 24h`; current ownership in both modes.
- Liquidations: rolling 1 hour and 24 hours; hourly buckets also available.
- Current open-position count: a snapshot, not trades over a time range.
- Protocol charts: hourly observations/volume changes, not hourly all-execution counts.
- Wallet trade history: paginated closed-position records, not all-execution totals.

**Arbitrary start/end times, `--since`, `--from`, `--to` and custom trade-count windows are not supported.** Do not send guessed query parameters: an endpoint may ignore unknown parameters and return its default window. If asked for all trades in the last 15 minutes, 6 hours, 7 days or between exact dates, explain that this aggregate is unavailable and offer the supported 24-hour figure. Do not silently substitute it.

Do not count `/api/overview.trades`, `activity.recent`, liquidation `items`, leaderboard rows, or market-view trades as a full total. These are limited lists. `assets BTC` in the CLI selects the capped recent market view, not BTC's full 24-hour count; use `assets` and select BTC from the response.

For chart highlights, `/api/assets/0/market?window=15m` (BTC) or `/api/assets/1/market?window=15m` (ETH) accepts `window=5m|15m|1h`, defaulting to `1h`. Its optional `chartSample` contains up to two large, priced observations per time bucket across the selected window (at most 62 trades), with explicit bounds and `partial: true`. These are sampled highlights, **not execution counts for that window**. The separate `trades` list remains capped at 200 recent observations. If `chartSample` is absent, window-wide highlights are unavailable; do not infer them from the recent list.

The market endpoint also accepts `segment=all|profitable`, defaulting to `all`. Profitable filters position openings before sampling to wallets with strictly positive latest checked lifetime realized trading P&L across markets. Rewards and unrealized P&L do not qualify a wallet. This is current classification, not evidence that a wallet was profitable when it entered. `segmentCoverage` counts unique opening wallets across the retained hour and reports classification time, known/profitable/unknown counts and account receipt bounds. Account summaries older than five minutes, missing or invalid remain unknown and are excluded. Coverage remains partial. Older responses without segment metadata cannot establish a profitable cohort; never substitute the unfiltered list for it. This filter does not change the separate rolling-24h all-trader activity totals.

## Units and interpretation

- USD/USDC and PAPER raw integer strings use 18 decimal places. This includes `pnlRaw`, balances, supply, staked amounts and reward fields. Keep strings intact; use arbitrary-precision integers or decimal arithmetic. In Python, set sufficient decimal precision (for example, `getcontext().prec = 100`) before `Decimal(raw) / Decimal(10**18)`. Do not convert raw strings to JavaScript `Number` before scaling. Raw representation preserves the API's precision; it does not establish independent accounting accuracy.
- Numeric `volumeUsd`, `notionalUsd` and `priceUsd` are already approximate USD amounts; do not divide them by `10**18`.
- `summary.activity.open` is the number of currently open positions. `summary.activity.volume` is lifetime notional, not recent volume or trade count.
- `summary.fees.lifetime` is lifetime USDC allocated to PAPER stakers, including unclaimed rewards. It is not an APY or the amount already claimed.
- `annualizedStakingRevenue.usdPerYearRaw` is a protocol-wide historical USDC/year allocation rate. For `basis: "observed-trading-window"`, it uses allocations since the announced October 10, 2026, 14:00 UTC trading start; it is not a forecast or yield percentage. The `/api/house` field name is retained for compatibility.
- Asset open interest is entry notional. Long/short percentages are notional-weighted, not percentages of wallets.
- Liquidation notional is execution size, not lost collateral or trader losses.
- `estimatedMarginUsd` is approximate USD initial margin associated with observed liquidations, summed as each position's notional divided by its entry leverage. It is already in USD, not 18-decimal raw units. Label it estimated; it is not an independently reconciled collateral-loss total. Null/missing means unavailable while retained observations are being enriched or a contribution cannot be derived. `marginObservationCount` covers locally derived observations; upstream coverage remains partial. Never estimate the total by dividing aggregate notional by average leverage.
- Most response times and window bounds are Unix milliseconds. Wallet `snapshot.indexedThroughTimestamp` is Unix seconds. Position `openedAtMs` is milliseconds.
- Wallet position tuples are easiest to interpret through `node paperclub.mjs positions ADDRESS`, which includes column names and unit descriptions. BTC raw entry/bust prices divide by 10; ETH by 100, unlike 18-decimal monetary amounts. `useDebt=true` means queued-balance funding; `false` means cash funding. It does not mean ordinary borrowed margin.
- Missing or null is unavailable, not zero. Never fabricate a missing value.

Wallet staking: `snapshot.paper.staked` is staked PAPER; `snapshot.lifetime.paperRewardsClaimedRaw` is claimed USDC rewards. `stakingRewards.pendingRaw` is the observed pending USDC calculation from a coherent account/accumulator pair; inspect its receipt/source clocks and `stale`. Missing pending is unavailable, not zero. Do not interpret `snapshot.paper.pendingBase` as the total pending/claimable balance.

Wallet UI and P&L cards show PAPER break-even as `max(0, -(lifetime realized trading P&L + claimed rewards + pending rewards)) / (staked + unstaked PAPER)`, in USDC per PAPER. This excludes open P&L and is not a market quote or acquisition cost basis. With a positive PAPER balance and a known nonnegative combined result, show **Cost recovered**. Zero PAPER or missing required data leaves the result unavailable. Retained stale values are labeled Last available. Tiny positive values must not round to zero.

### Wallet margin at risk

`node paperclub.mjs risk ADDRESS` selects `marginRisk` from the existing wallet response. This is a hypothetical price scenario for the included open positions in one wallet snapshot. It is **not** a complete global inventory, a prediction of liquidations, or expected cash loss. Fixed initial margin is distinct from position notional and current account equity. `cashMarginRaw` and `queuedMarginRaw` split that initial margin; queued-balance funding is a claim, not newly borrowed cash. All margin fields use 18 decimals.

Each asset's bands are nonoverlapping: at/beyond the reference; (0, 0.1%]; (0.1%, 0.25%]; (0.25%, 0.5%]; (0.5%, 1%]; (1%, 5%]; over 5%. `lowerBps` is exclusive and `upperBps` inclusive, except the at/beyond band covers all nonpositive distances. Long distance is `(reference − bust) / reference`; short distance is `(bust − reference) / reference`. `distanceBps / 100` is percent, with negative values on the far side of the recorded threshold. The approximate Hyperliquid midpoint reference is independent of the protocol's mark and snapshot block. Terminal/frozen-market metadata is unavailable, so even an at/beyond threshold does not establish liquidation eligibility.

Inspect `snapshot.sourceAt`/`receivedAt`/`stale`, asset `reference.sourceAt`/`receivedAt`/`stale`, and top-level `stale`/`error`. These clocks are independent of the enclosing wallet history's age. Missing reference leaves exact margin totals usable but `bands: null`; missing snapshot is unavailable, not zero. `nearest` shows at most five thresholds per asset ordered by absolute distance. Aggregates include all valid snapshot rows, not only those five. `coverage.includedCount` and `excludedCount` describe interpretation of this bounded snapshot, never full protocol capture. `duplicateCount` counts rows excluded for repeated wallet-scoped position IDs and is included in `excludedCount`. Keep `partial: true` in reports. `risk --require-fresh` checks the risk snapshot and relevant references; it does not certify completeness. Older API responses without `marginRisk` mean unavailable.

### House health

`node paperclub.mjs house` returns House Funds and its components from one publication: **LP balance + open house PnL − queue debt**. LP includes the payout reserve; do not subtract it twice. TVL is not available house backing, and these values alone do not establish solvency or a risk score. The source publishes approximate USD numbers; their raw 18-decimal representation preserves supplied precision without making them exact on-chain balances.

Each available `history` point carries the same four raw fields (`fundsRaw`, `lpRaw`, `openPnlRaw`, `queueDebtRaw`) and a source timestamp. Missing component fields in an older response mean unavailable, not zero. Respect `gapBefore`.

`change`, when available, contains signed endpoint differences for the four components, `fromMs`, `toMs` and `sampleCount`. Funds change equals LP change + open house PnL change − queue-debt change. Positive debt change therefore has a negative contribution to funds. The comparison covers the latest comparable retained segment, bounded to available history within 24 hours; recorded gaps and source-generation changes reset it. This remains partial observation history. State its returned time bounds rather than calling it a full-day change. A null/missing change means insufficient comparable observations. These differences explain the accounting components, not individual deposit, payout, fee or realized-profit flows.

Use `houseStale` (fallback `stale` for older responses), `sourceAt` and `receivedAt` for House freshness. The legacy PAPER block has a separate `summarySourceAt`; top-level `stale` and CLI `--require-fresh` remain conservative for the full response. For independent current PAPER economics, use `paper`.

### PAPER economics

`node paperclub.mjs paper` returns one bounded snapshot. Current supply, stake, allocated rewards and source-reported pending rewards are raw 18-decimal strings. `stakeRatioBps / 100` is percent of supply staked; null means unavailable, including zero supply. `allocatedRewardsRaw` is lifetime USDC allocated to stakers, not already distributed or claimed. `pendingRewardsRaw` is the protocol-reported pending amount, not a wallet's claimable balance. For `annualized.basis: "observed-trading-window"`, `fromMs` is the announced October 10, 2026, 14:00 UTC public trading start, `cutoffBasis` is `"announced-trading-start"`, and `toMs` is the source summary time. `lifetimeRewardsRaw` remains the source lifetime total; `baselineRewardsRaw` is the verified zero pre-trading allocation, and `allocatedSinceStartRaw` is their difference. `usdPerDayRaw` and `usdPerYearRaw` divide that difference by the exact elapsed milliseconds and scale it to one day or 365 days. These are historical protocol-wide allocation rates, not APY, distributed/claimed USDC, or forecasts. The source's prior complete hour and first active hourly bucket support the cutoff and zero baseline; they do not prove the exact first trade time. Older `basis: "protocol-lifetime"` responses used October 6 deployment age and must not be described as trading-window rates. See the [verification record](https://github.com/carlislejd/paperdash/blob/main/docs/evidence/2026-10-16-trading-launch-verification.json).

Optional `stakingYield` measures actual observed reward-accumulator changes. `usdPerPaperPerYearRaw` is 18-decimal USDC/year per **one staked PAPER**; the UI multiplies by 1,000. `earnedUsdPerPaperRaw` covers the explicit `fromMs`–`toMs` interval. Annualization uses every millisecond of `elapsedMs`, including zero-reward and partial hours, and a 365-day year. `basis: "observed-accumulator"` is not lifetime history. The baseline survives chart eviction and collector restarts; regressions start a new interval. Fewer than one elapsed hour, missing accumulator or invalid data leaves the annual rate null, not zero. Respect the enclosing source/receipt clocks and `stale`. Percentage APR additionally requires a USDC price per PAPER: annual USDC per PAPER ÷ price × 100. The UI accepts a hypothetical price, not a live quote; no compounding or future return is assumed.

Optional `daily` contains `supplyChange` and `rewardAllocation` for seven UTC calendar days, including today (`intervalMs: 86400000`, `timeZone: "UTC"`, `aggregation: "daily-change"`). Existing `series` remains hourly. Daily PAPER is signed net supply change, not attributed mint events; daily rewards are changes in lifetime allocated USDC, not distributions or claims. Each point's `time` is UTC midnight; report `observedFromMs` and `observedToMs` as its actual endpoints. Today's bar and summary-derived days are partial, and their endpoint can precede overall `sourceAt`. Missing/gapped/incompatible observations remain null, not zero. Do not sum partial hourly bars to reconstruct daily totals. `value` is an approximate chart number; optional `valueRaw` is an exact 18-decimal endpoint difference. Older responses may omit `daily`.

The hourly series are `supply`, `staked`, `allocated`, `supplyChange` and `rewardAllocation`. Numeric values are already in PAPER or USD, approximate, and may be null; do not rescale them by 10**18. `allocated` is cumulative lifetime allocated USDC. `supplyChange` is net supply change, not a count or exact total of attributed mint events. `rewardAllocation` is a change in lifetime allocated USDC, not a payout. Respect `gapBefore`, `partial`, the returned source time and per-series coverage. Missing or incompatible history stays unknown rather than zero. Global distributed/claimed rewards and a complete lifetime per-token distribution ledger are unavailable; current stake or reserves cannot reconstruct them.

### Position outcomes and receipts

`node paperclub.mjs wallet ADDRESS --history trades` returns one page of closed/liquidated positions. For an individual result:

- Read initial margin from `marginRaw` and entry leverage from `leverage`. Entry notional is their product using integer arithmetic, with 18 decimals.
- Divide `entryPriceRaw` and `exitPriceRaw` by that outcome's `priceScaleRaw` for USD prices. Do not assume every market uses the same scale.
- Holding time is `timestampMs - openedAtMs` for valid ordered timestamps. A completed position's duration ends at the outcome, not at later payout settlement.
- Display `adjustedPnlRaw` as supplied and keep `userPaidFeeRaw` separate. Do not label adjusted PnL net of that fee, infer a settled payout, or call PAPER a dollar return.
- `paperMintedRaw` is PAPER attributed to this position. Keep `paperMintBasisRaw` and nullable `paperMintBatchTotalRaw` separate; the batch total can cover multiple positions.
- `kind` distinguishes `PositionClosed` and `Liquidated`. Closed outcomes do not expose a funding flag or bust price; these remain unknown. Open-position tuples do expose `useDebt` and `bustPriceRaw`, but have no completed outcome or exit price.

Scope `positionId` to the wallet and source. Several outcomes can share one transaction hash. Retained records may be corrected and coverage may be incomplete. Use the history page's `receivedAt` and `coverage.lastIndexedAt`, not the oldest aggregate wallet timestamp, when describing its observation age. A wallet card's exported PNG captures the selected observation; copied wallet links are not immutable receipt links. Never reconstruct a receipt by matching size and time in the sampled global live feed.

For a watchlist, use `node paperclub.mjs watchlist ADDRESS,ADDRESS` or the batch endpoint above with 1–25 addresses. This is one read, not a background monitor and not access to a visitor's browser-saved Following list. Rows can have null account data or delayed valuations; `refreshQueued` only means a shared collector refresh is scheduled. The directory source has no verified valuation source clock, so `sourceAt` is null and `receivedAt` records collection time. Activity has separate freshness, a rolling 24-hour bound and a capped recent list. Do not count that list as total trades or claim that a fresh feed makes all balances fresh.

## Freshness, coverage and pagination

Read `stale`, `status.stale`, `error`/`errors`, source timestamps and coverage before answering. Report delayed results as the last available snapshot with an as-of time. Fresh data may still have partial history.

Leaderboard account values and observed activity have separate freshness: inspect `accountStale`, `accountReceivedAt` and `activityCoverage.stale`, `windowFrom`, `windowTo`, `observedFrom`, `projectionBackfillComplete`. Directory per-wallet trade counts likewise have `tradeCount24hAt`, `tradeCount24hStale` and `tradeCountCoverage`. Do not infer freshness of all fields from a single top-level flag.

Retained observations can have gaps or ambiguous identities. Finishing available backfill does not prove complete lifetime coverage. Label counts and volumes as observed when coverage is partial; preserve that qualification in summaries.

Directory pages are zero-based, with `pageSize=10` or `25` (default 25). Leaderboard pages contain up to 25 rows. `count` there counts wallets, not trades. Read `pageInfo` before requesting another page. Directory sorts are descending: `currentBalance`, `currentUnrealizedPnl`, `realizedPnl`, `totalVolume`, `totalWindowedPnl`, `currentOpenNotional`, `lastActiveTs`.

Use `q` for an address/name search where supported; observed volume/trade rankings accept only wallet-address prefixes. Use the response's opaque `nextCursor` for wallet history/liquidations, URL-encoding it. Rank pages can change between requests. Fetch only the pages needed for the user's question; avoid scanning every wallet.

## Request behavior

The CLI has bounded retries and timeouts. `--require-fresh` exits 3 on stale/degraded/unavailable responses while retaining the JSON result on stdout; `risk` uses its independent snapshot/reference freshness instead of unrelated wallet history. For PAPER lifetime statistics it also requires a matching `statsWindow: "all"`, fresh source-account data and available recorded-close counts with indexed, completed, nonpending, fresh per-row history coverage. For 24-hour rankings it rejects delayed activity coverage when present. These checks do not prove canonical lifetime completeness; inspect excluded rows and coverage when explaining results. Other exit codes: 0 success, 1 request failure, 2 invalid arguments. Errors are JSON on stderr.

For direct HTTP, use a timeout, honor `Retry-After` on 429, and back off on transient errors. Do not repeatedly retry 400/401/403. Reuse responses within a task; a refresh every 30–60 seconds is sufficient for ordinary agent conversations. Do not poll every wallet or fetch the dashboard HTML to extract numbers. No trading or account-write action is available through this interface.

## Suggested answer format

State the metric and scope, value/ranked wallets, actual time window or as-of timestamp, and freshness/coverage caveat. Link wallet results with `https://papertrade.club/?wallet=ADDRESS`. For example: "Observed BTC+ETH executions over [returned window]: [count]. Coverage is partial; data as of [timestamp]." Never claim a requested range was answered when only a different range is available.
