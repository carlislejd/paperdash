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

The annualized figure is lifetime allocated USDC divided by the verified protocol lifetime, multiplied by 365 days. It is a historical protocol-wide USDC/year run rate, not APY, a forecast, a token price or a per-token return. Unknown genesis or invalid clocks leave it unavailable.

## Retained charts

Supply and staked series are hourly snapshots. The net supply-change bars show signed changes between eligible consecutive hourly endpoints, not a sum of verified mint events. Reward-allocation bars show nonnegative changes in cumulative allocated USDC, not cash distributions or claims. A decreasing cumulative allocation counter cannot become a negative dividend or a fabricated zero.

The charts reuse retained protocol history and summary observations. Historical chart values are approximate numbers even though current totals preserve raw integer strings; coverage therefore reports `historyApproximate: true` and `partial: true`. Missing endpoints, source-generation discontinuities and known gaps remain unavailable. Do not spread a multi-hour change across one hourly bar or interpolate missing rewards. A current partial hour stays marked partial.

New hourly summary observations also retain exact raw supply, staked and allocated-reward strings in the existing stored JSON. Compatible raw endpoint pairs are subtracted before conversion to chart numbers. This preserves precision going forward without changing old records or pretending numeric source history has become exact.

Source timestamps, receipt timestamps and freshness are preserved separately. Re-serving a cached response does not create a new source observation. The collector prepares shared cached results from already collected data; viewers do not trigger new upstream history requests or full-history scans. This scoped release needs no new event index or historical mint backfill.

## Allocation, distribution and claims

Official [staking mechanics](https://docs.papertrade.xyz/#/paper/staking) distinguish fees accrued at the Exchange, funds received by PaperStaking, distribution through its accumulator, and later user claims. Each distribution uses stake at that moment. The [dividend documentation](https://docs.papertrade.xyz/#/learn/staking-dividends) describes trading-fee allocation and LP excess as reward sources. An allocation total is therefore not proof that the same amount has been distributed or claimed.

This release excludes global distributed USDC, global claimed USDC and realized distributions per staked token. Current reserve, unallocated balances and current stake do not establish those historical cash flows. No reserve arithmetic is used to manufacture them. The source history's `paperRevenue` name alone does not establish its accounting stage, so it is not treated as a distribution ledger.

A wallet's `lifetime.paperRewardsClaimedRaw` is its reported lifetime claimed USDC, not a timestamped claim history. Wallet claimable rewards remain unavailable here: `pendingBase` alone is insufficient. The documented `PaperStaking.pendingReward(address)` view includes already-distributed rewards, but this release does not add that source read or assume an unverified accumulator formula.

Retained closed outcomes separately provide exact `paperMintedRaw` and eligible USD `paperMintBasisRaw`; optional batch totals are not individual issuance. The [mint-curve documentation](https://docs.papertrade.xyz/#/how/mint-curve) explains why eligible loss basis can differ from trader loss or LP gain. A later issuance aggregate must preserve corrections, ambiguous identities and partial discovery rather than treating sampled ticker trades or supply changes as a canonical mint ledger.
