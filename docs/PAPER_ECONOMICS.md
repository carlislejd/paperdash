# PAPER economics

Verified October 10, 2026 against the captured official frontend, public protocol summary and current official documentation. This release explains supply, staking participation and USDC allocation. It does not establish a complete mint, distribution or claim ledger.

## Current totals

The public `/api/paper/economics` response preserves the following fields from one coherent [protocol summary](https://exchange.papertrade.xyz/query/protocol/summary):

| Response field | Source | Meaning |
| --- | --- | --- |
| `supplyRaw` | `paper.supply` | Current PAPER supply |
| `stakedRaw` | `paper.staked` | Currently staked PAPER |
| `allocatedRewardsRaw` | `fees.lifetime` | Lifetime USDC allocated to stakers |
| `pendingRewardsRaw` | `paper.pendingRewards` | Source-reported protocol pending rewards |

These are exact representations of the supplied decimal integer strings, with 18 decimals. Preserving their precision does not independently reconcile them to chain state. Missing values remain null, not zero. The official [selectors](https://exchange.papertrade.xyz/assets/selectors-BDXWQuej.js) and [PAPER summary component](https://exchange.papertrade.xyz/assets/PaperSummaryCard-DhkJzzzL.js) establish the headline mappings; local source captures preserve them if deployment-specific asset URLs expire.

`stakeRatioBps` is staked PAPER divided by supply from that same summary, truncated to integer basis points. Zero supply or invalid inputs make the ratio unavailable. It is participation, not yield.

`pendingRewardsRaw` must not be relabeled as wallet claimable rewards or as a verified amount awaiting a particular distribution stage. It is distinct from `fees.pending`, the global accumulator and a wallet's `pendingBase`.

The PAPER panel's **Average daily reward allocations** and **Annualized reward allocations** use the same historical trading window. The cutoff is the announced public trading start, **October 10, 2026 at 14:00 UTC** (`fromMs: 1791640800000`, `cutoffBasis: "announced-trading-start"`). The official hourly protocol history reports zero cumulative staking allocations in every available preceding hour, including the complete 13:00–14:00 UTC hour, and its first nonzero allocation appears in the 14:00–15:00 UTC hour. This supports a zero allocation baseline at the cutoff; it does not identify the exact first execution time. [Trading-start evidence](evidence/2026-10-16-trading-launch-verification.json) records the announcement, source history and precision limit.

`annualized.basis: "observed-trading-window"` identifies this calculation. Its raw 18-decimal fields are `lifetimeRewardsRaw` (the unchanged `fees.lifetime` total), `baselineRewardsRaw` (`"0"` for this verified deployment), `allocatedSinceStartRaw` (lifetime total minus baseline), `usdPerDayRaw`, and `usdPerYearRaw`. With source summary time `toMs`, the formulas use exact elapsed milliseconds and integer arithmetic:

```text
allocated since start = lifetime allocations − cutoff baseline
daily allocations    = allocated since start × 86,400,000 ÷ (toMs − fromMs)
annual allocations   = allocated since start × 365 × 86,400,000 ÷ (toMs − fromMs)
```

The rate is unavailable for an unverified deployment, an invalid or pre-cutoff source clock, or a cumulative counter below the baseline. It is a protocol-wide retrospective allocation rate, not APY, a forecast, a token price, a per-token return, or proof of USDC already distributed or claimed. The October 6 protocol genesis remains the deployment identity; it is not the start of public trading. Deposits opened October 8 and remain in their actual deposit history. This calculation uses the already collected summary and a verified fixed baseline, with no extra RPC, upstream polling or history scan. Older `basis: "protocol-lifetime"` responses describe a different denominator and must not be presented as this trading-window rate.

## Annualized staker yield

The overview headline shows **simple APR**, combining the observed annual USDC reward per PAPER with the Hyperliquid Paragon `para:PAPER` perpetual midpoint. The duplicate manual-price calculator has been removed. The reward numerator measures changes in `paper.accumulator`, the 1e27-scaled reward-per-share accumulator used for wallet rewards. It accounts for stake at each actual distribution, including changes between hourly observations. Lifetime allocations divided by today's stake would not measure this return.

The healthy headline has one note line: the current PAPER price linked to Hyperliquid. Hovering the metric or focusing its price link/info button reveals the formula, observed interval and quote timestamp in an overlay without changing the metrics row's height. The info button also opens the details on touchscreens; Escape or interacting outside dismisses them. Price/reward delays and missing inputs remain visible in compact status text.

The additive `stakingYield` response contains `usdPerPaperPerYearRaw` and `earnedUsdPerPaperRaw` (18-decimal USDC per one PAPER), `fromMs`, `toMs`, `elapsedMs`, `basis: "observed-accumulator"`, and `yearDays: 365`. For accumulator endpoints A and B:

```text
annual USDC raw per PAPER = (B − A) × (365 × 24 × 60 × 60 × 1000)
                           ÷ (10^9 × elapsedMs)
```

Integer arithmetic preserves the full accumulator delta through annualization, truncating only the final raw result. The denominator uses exact source timestamps: every elapsed hour, partial hour and zero-reward interval counts. Reopening the page or serving a cached response does not advance the measured interval. The displayed hourly duration is rounded only for presentation.

The collector saves the first and latest comparable accumulator observations in the existing snapshot store for every accepted summary, including observations between slower chart publications. The first observation survives restarts and seven-day chart eviction, so the rate uses all measured time. Missing intervening polls need no interpolation: a cumulative endpoint delta captures rewards across the entire elapsed interval. A known accumulator decrease, timestamp rollback or conflicting value at the same source timestamp starts a new window. Missing or invalid source values remain unavailable, while a measured zero reward rate displays zero. Chart publication only reads this window and requires its endpoint to match the summary; a concurrent update can temporarily leave the yield unavailable until the next refresh, but cannot roll back the window.

At least one elapsed hour is required before publishing an annualized number. On rollout, the UI shows that it is collecting the first hour. Older API responses can omit `stakingYield`. This read uses one bounded retained snapshot during normal collector publication, with no new upstream requests, per-viewer history reads, database migrations or RPC dependency. The headline and PAPER charts share the existing economics browser resource.

No zero **reward-per-share accumulator** at launch is assumed for this separate per-PAPER staking yield. A read-only check on October 15, 2026 (Pacific) returned identical current, nonzero `eth_call` values for block zero, the genesis block and latest, so that RPC cannot establish its historical accumulator baseline. [Captured evidence](evidence/2026-10-15-staking-genesis-verification.json) records the check. The verified zero **cumulative allocation** baseline above is a different counter; it does not imply a zero accumulator.

The headline uses the current best-bid/best-ask midpoint of Hyperliquid's [Paragon PAPER perpetual](https://app.hyperliquid.xyz/trade/para:PAPER) as a USDC reference price:

```text
simple APR (%) = annual USDC earned per PAPER ÷ PAPER reference price × 100
```

The optional `paperPrice` response carries `source: "hyperliquid"`, `market: "para:PAPER"`, `basis: "perp-mid"`, exact 18-decimal `priceUsdRaw`, `bidUsdRaw` and `askUsdRaw`, plus independent exchange `sourceAt` and receipt `receivedAt` clocks. Paragon's market metadata identifies USDC collateral. This is a perpetual midpoint, not an executable spot purchase quote, the oracle price, or the market's funding rate. APR uses integer arithmetic and does not compound.

One collector-owned [L2 book snapshot](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#l2-book-snapshot) request refreshes the retained price every ten seconds under normal operation. Unlike the change-only BBO stream, the book response supplies a timestamped snapshot for a quiet market. Quotes require the exact market, valid positive bid/ask, a non-crossed book and valid timestamps. Failures retain the original quote and its clocks with bounded retries; neither API reads nor page views contact Hyperliquid. The existing economics publication includes the saved quote for all viewers.

Missing or invalid prices make APR unavailable rather than zero. Prices older than 60 seconds are labeled delayed independently from the reward data's 30-second freshness limit. A measured zero reward rate still displays zero APR when a valid price exists. Refreshing the page cannot renew either source clock.

Staking is required to earn rewards; holding unstaked PAPER does not earn this rate. The observed average can change with revenue and staking participation, and does not include token price gains/losses, purchase fees or taxes.

## Optional Paragon reference valuations

“Show Paragon estimates” is off by default and remembered in this browser. It adds secondary PAPER values to the wallet directory, wallet drawer, leaderboards, Following, top open-PnL list and overview supply. Every estimate is labeled “(Paragon premarket price).” Existing trading P&L, balances, PAPER counts, ranking order and historical charts remain unchanged. The same shared economics response supplies the quote; enabling estimates does not fetch individual wallets or call Hyperliquid from the browser.

PAPER value is current staked plus unstaked PAPER multiplied by the validated `para:PAPER` perpetual midpoint, with integer arithmetic at 18 decimals. The wallet's additional “P&L + PAPER value” combines that mark with its existing lifetime trading-plus-rewards P&L. This is a reference estimate, not realized profit or token investment profit: acquisition costs are unknown, and sale proceeds depend on liquidity and execution. Current holdings are never added to 24-hour or open trading P&L. Overview supply uses the label “Implied supply value.”

Unknown price or holdings remain unavailable, distinct from zero. Source timestamps are preserved; quote delays and delayed holdings or other P&L inputs are labeled separately. P&L-card capture freezes the preference, validated quote, source time and failure state alongside the account. Preview, export and share text all use that captured snapshot until the user selects Update card.

## Retained charts

Supply and staked series are hourly snapshots. The net supply-change bars show signed changes between eligible consecutive hourly endpoints, not a sum of verified mint events. Reward-allocation bars show nonnegative changes in cumulative allocated USDC, not cash distributions or claims. A decreasing cumulative allocation counter cannot become a negative dividend or a fabricated zero.

The charts reuse retained protocol history and summary observations. Historical chart values are approximate numbers even though current totals preserve raw integer strings; coverage therefore reports `historyApproximate: true` and `partial: true`. Missing endpoints, source-generation discontinuities and known gaps remain unavailable. Do not spread a multi-hour change across one hourly bar or interpolate missing rewards. A current partial hour stays marked partial.

New hourly summary observations also retain exact raw supply, staked and allocated-reward strings in the existing stored JSON. Compatible raw endpoint pairs are subtracted before conversion to chart numbers. This preserves precision going forward without changing old records or pretending numeric source history has become exact.

### Daily calendar bars

The additive `daily` block contains `intervalMs: 86400000`, `timeZone: "UTC"`, and `supplyChange` / `rewardAllocation` series with `aggregation: "daily-change"`. It covers seven UTC calendar days, including today. Existing `series` fields remain hourly and unchanged; older responses can omit `daily` during rollout.

Daily values are differences between comparable cumulative endpoints, not sums of hourly bars. `daily.supplyChange` is signed net PAPER supply growth, including a negative value if supply falls; it is not attributed mint issuance. `daily.rewardAllocation` is newly allocated USDC, not distributed or claimed rewards. An allocation counter decrease anywhere in the retained daily sequence makes that day unavailable, even if its ending value subsequently recovers.

Each point's `time` is UTC midnight. `observedFromMs` and `observedToMs` report the actual endpoints used; the end can precede the response's overall `sourceAt`. `value` is a display number. Optional `valueRaw` is the exact signed 18-decimal difference when both endpoints retain raw integers, subtracted before number conversion.

Completed historical days require complete midnight boundaries and a coherent sequence of retained hourly observations. A compatible summary sequence can supply a partial daily observation, including today's growing value from the latest summary. Its boundary sample must be within one minute before midnight; the actual endpoint remains explicit and the point remains `partial: true`. Today's point is always partial. Sources and generation namespaces are never joined to manufacture a daily difference.

Missing boundaries, missing hours, null observations and generation changes produce null points with `gapBefore: true`, not zeros or estimates. Closed historical days are preferred over partial summary observations when both are available. The daily payload reuses the same bounded observations and summary as the hourly payload, without additional upstream requests or per-viewer history reads.

Source timestamps, receipt timestamps and freshness are preserved separately. Re-serving a cached response does not create a new source observation. The collector prepares shared cached results from already collected data; viewers do not trigger new upstream history requests or full-history scans. This scoped release needs no new event index or historical mint backfill.

## Allocation, distribution and claims

Official [staking mechanics](https://docs.papertrade.xyz/#/paper/staking) distinguish fees accrued at the Exchange, funds received by PaperStaking, distribution through its accumulator, and later user claims. Each distribution uses stake at that moment. The [dividend documentation](https://docs.papertrade.xyz/#/learn/staking-dividends) describes trading-fee allocation and LP excess as reward sources. An allocation total is therefore not proof that the same amount has been distributed or claimed.

This release excludes global distributed USDC and global claimed USDC. The accumulator delta measures per-token rewards over its explicit observed interval, not a complete lifetime distribution ledger. Current reserve, unallocated balances and current stake do not establish historical global cash flows. No reserve arithmetic is used to manufacture them. The source history's `paperRevenue` name alone does not establish its accounting stage, so it is not treated as a distribution ledger.

A wallet's `lifetime.paperRewardsClaimedRaw` is its reported lifetime claimed USDC, not a timestamped claim history. Wallet claimable rewards now use the verified accumulator calculation and an account/summary pair retained during the existing wallet refresh; `pendingBase` alone remains insufficient. The P&L card combines realized trading results with claimed and pending rewards. See [wallet rewards](WALLET_REWARDS.md) for the formula, contract verification, freshness, and missing-data behavior. Protocol-wide totals in this panel retain the definitions above.

Retained closed outcomes separately provide exact `paperMintedRaw` and eligible USD `paperMintBasisRaw`; optional batch totals are not individual issuance. The [mint-curve documentation](https://docs.papertrade.xyz/#/how/mint-curve) explains why eligible loss basis can differ from trader loss or LP gain. A later issuance aggregate must preserve corrections, ambiguous identities and partial discovery rather than treating sampled ticker trades or supply changes as a canonical mint ledger.
