# Paperclub agent guide

Public, read-only Papertrade analytics. Use this guide to answer questions about TVL, PAPER, wallets, PnL, positions and observed trading activity.

- Website: https://papertrade.club/
- This guide: https://papertrade.club/agents.md
- JSON API base: https://paperdash-api.onrender.com
- Standalone CLI: https://papertrade.club/paperclub.mjs
- Authentication: none. All documented requests are GET requests.
- Contract checked: October 10, 2026.

## Quick start

Use direct HTTP or download the dependency-free CLI (Node.js 24):

```sh
curl --fail --show-error --location --max-time 20 \
  https://papertrade.club/paperclub.mjs -o paperclub.mjs
node paperclub.mjs --help
node paperclub.mjs overview --pretty
node paperclub.mjs wallets --sort currentUnrealizedPnl --page 0 --pretty
node paperclub.mjs leaderboard --metric pnl --page 0 --pretty
node paperclub.mjs assets --pretty
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
| Most trades in the last 24 hours, by wallet | `/api/leaderboard?metric=trades&page=0` | `rows[].tradeCount` |
| Most observed volume in the last 24 hours, by wallet | `/api/leaderboard?metric=volume&page=0` | `rows[].volumeUsd` |
| Observed trade counts and volume over the last 24 hours | `/api/assets` | `assets[].activity.counts`, `.notionalUsd`, `.windowFrom`, `.windowTo` |
| BTC/ETH open interest and long/short share | `/api/assets` | `assets[].openInterest` |
| Wallet balances, staking and initial history pages | `/api/wallets/ADDRESS` | `snapshot`, `cashflows`, `trades`, `portfolio` |
| Wallet deposits/withdrawals | `/api/wallets/ADDRESS/cashflows` | `items`, `nextCursor`, `coverage` |
| Wallet closed-position history | `/api/wallets/ADDRESS/trades` | `items`, `nextCursor`, `coverage` |
| House funds, PAPER staked, rewards, annualized staking revenue | `/api/house` | `house`, `paper`, `annualizedStakingRevenue` |
| Liquidation totals over the last 1 or 24 hours | `/api/liquidations/stats` | `stats.hour`, `stats.day`, `windowTo` |
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

For the dashboard's positive open-PnL leaders, filter current-uPnL rows to `currentUnrealizedPnl > 0` and `currentOpenPositionCount > 0`. A page may then contain fewer than ten qualifying wallets. Compare raw amounts with integer/decimal arithmetic.

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
- Liquidations: rolling 1 hour and 24 hours; hourly buckets also available.
- Current open-position count: a snapshot, not trades over a time range.
- Protocol charts: hourly observations/volume changes, not hourly all-execution counts.
- Wallet trade history: paginated closed-position records, not all-execution totals.

**Arbitrary start/end times, `--since`, `--from`, `--to` and custom trade-count windows are not supported.** Do not send guessed query parameters: an endpoint may ignore unknown parameters and return its default window. If asked for all trades in the last 15 minutes, 6 hours, 7 days or between exact dates, explain that this aggregate is unavailable and offer the supported 24-hour figure. Do not silently substitute it.

Do not count `/api/overview.trades`, `activity.recent`, liquidation `items`, leaderboard rows, or market-view trades as a full total. These are limited lists. `assets BTC` in the CLI selects the capped recent market view, not BTC's full 24-hour count; use `assets` and select BTC from the response.

## Units and interpretation

- USD/USDC and PAPER raw integer strings use 18 decimal places. This includes `pnlRaw`, balances, supply, staked amounts and reward fields. Keep strings intact; use arbitrary-precision integers or decimal arithmetic. In Python, set sufficient decimal precision (for example, `getcontext().prec = 100`) before `Decimal(raw) / Decimal(10**18)`. Do not convert raw strings to JavaScript `Number` before scaling. Raw representation preserves the API's precision; it does not establish independent accounting accuracy.
- Numeric `volumeUsd`, `notionalUsd` and `priceUsd` are already approximate USD amounts; do not divide them by `10**18`.
- `summary.activity.open` is the number of currently open positions. `summary.activity.volume` is lifetime notional, not recent volume or trade count.
- `summary.fees.lifetime` is lifetime USDC allocated to PAPER stakers, including unclaimed rewards. It is not an APY or the amount already claimed.
- `annualizedStakingRevenue.usdPerYearRaw` is a protocol-wide historical USDC/year run rate, not a forecast or yield percentage.
- Asset open interest is entry notional. Long/short percentages are notional-weighted, not percentages of wallets.
- Liquidation notional is execution size, not lost collateral or trader losses.
- Most response times and window bounds are Unix milliseconds. Wallet `snapshot.indexedThroughTimestamp` is Unix seconds. Position `openedAtMs` is milliseconds.
- Wallet position tuples are easiest to interpret through `node paperclub.mjs positions ADDRESS`, which includes column names and unit descriptions. BTC raw entry/bust prices divide by 10; ETH by 100, unlike 18-decimal monetary amounts.
- Missing or null is unavailable, not zero. Never fabricate a missing value.

Wallet staking: `snapshot.paper.staked` is staked PAPER; `snapshot.lifetime.paperRewardsClaimedRaw` is claimed USDC rewards. Pending/claimable wallet rewards are currently unavailable. Do not interpret `snapshot.paper.pendingBase` as the total pending/claimable balance.

## Freshness, coverage and pagination

Read `stale`, `status.stale`, `error`/`errors`, source timestamps and coverage before answering. Report delayed results as the last available snapshot with an as-of time. Fresh data may still have partial history.

Leaderboard account values and observed activity have separate freshness: inspect `accountStale`, `accountReceivedAt` and `activityCoverage.stale`, `windowFrom`, `windowTo`, `observedFrom`, `projectionBackfillComplete`. Directory per-wallet trade counts likewise have `tradeCount24hAt`, `tradeCount24hStale` and `tradeCountCoverage`. Do not infer freshness of all fields from a single top-level flag.

Retained observations can have gaps or ambiguous identities. Finishing available backfill does not prove complete lifetime coverage. Label counts and volumes as observed when coverage is partial; preserve that qualification in summaries.

Directory pages are zero-based, with `pageSize=10` or `25` (default 25). Leaderboard pages contain up to 25 rows. `count` there counts wallets, not trades. Read `pageInfo` before requesting another page. Directory sorts are descending: `currentBalance`, `currentUnrealizedPnl`, `realizedPnl`, `totalVolume`, `totalWindowedPnl`, `currentOpenNotional`, `lastActiveTs`.

Use `q` for an address/name search where supported; observed volume/trade rankings accept only wallet-address prefixes. Use the response's opaque `nextCursor` for wallet history/liquidations, URL-encoding it. Rank pages can change between requests. Fetch only the pages needed for the user's question; avoid scanning every wallet.

## Request behavior

The CLI has bounded retries and timeouts. `--require-fresh` exits 3 on top-level stale/degraded/unavailable responses while retaining the JSON result on stdout; still inspect nested freshness and coverage yourself. Other exit codes: 0 success, 1 request failure, 2 invalid arguments. Errors are JSON on stderr.

For direct HTTP, use a timeout, honor `Retry-After` on 429, and back off on transient errors. Do not repeatedly retry 400/401/403. Reuse responses within a task; a refresh every 30–60 seconds is sufficient for ordinary agent conversations. Do not poll every wallet or fetch the dashboard HTML to extract numbers. No trading or account-write action is available through this interface.

## Suggested answer format

State the metric and scope, value/ranked wallets, actual time window or as-of timestamp, and freshness/coverage caveat. Link wallet results with `https://papertrade.club/?wallet=ADDRESS`. For example: "Observed BTC+ETH executions over [returned window]: [count]. Coverage is partial; data as of [timestamp]." Never claim a requested range was answered when only a different range is available.
