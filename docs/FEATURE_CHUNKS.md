# Shared foundations and staged features

The October 10, 2026 feature discussion is being delivered as separate reviewable releases. Completing one chunk does not imply the later chunks are available. Each release gets focused tests, normal CI and targeted live checks; it does not trigger a new broad production load audit.

## Reuse before extending

The existing collector, durable raw observations, history checkpoints, source-overlap projections, shared request coordinator, API caches and chart exports remain the foundation. No second collector, parallel wallet ledger or independent per-viewer upstream connection is needed for these features.

The first addition is a per-address retained account summary with bounded batch reads and temporary, deduplicated collector refresh requests. Current wallet valuations and observed execution activity keep independent freshness. Original observation times survive caching. Missing values remain unavailable; observations remain partial rather than being promoted into a canonical ledger.

Later features should reuse this read boundary, retained wallet outcomes, minute aggregates and existing export components. Introduce additional history or indexes only with the chunk that needs them. In particular, neither the current live ticker nor selectively fetched wallet snapshots establish a complete global open-position inventory.

## Release sequence

1. **Live Following and wallet read foundation.** Migrate saved browser entries to identities, show current retained summaries and recent activity, and refresh known watched wallets through a globally bounded collector queue. Keep ten wallets per page and one visible-page request; no alerts or sign-in in this release.
2. **Trade receipts and richer wallet details.** A single typed interpretation of retained outcomes and open-position tuples should serve detail views, branded receipts and future statistics. Preserve initial margin, cash/debt funding, entry/bust/exit prices, holding duration, adjusted PnL and PAPER issuance with explicit provenance. Do not infer missing open/close pairs from sampled chart trades.
3. **PAPER economics.** Start with retained supply, staking participation and allocated-reward history. Distinguish net supply change from attributed issuance and allocated USDC from distributions or claims. Exact retained-outcome issuance totals need a correction-aware incremental projection; per-token realized distributions need verified distribution events and stake at that time. Supply growth is not revenue or a token price. Wallet claimable rewards need a verified source before display.
4. **House health.** Retain the components of each coherent house publication alongside funds so changes in LP, open house PnL and queue debt can be explained. Do not mix timestamps or treat TVL as available house backing.
5. **Margin at risk.** Start with verified wallet positions. A global bust-price map requires a continuously reconciled position inventory and source-correct cash/debt margin semantics. A price-band scenario is not a prediction of which positions will actually liquidate.
6. **Time ranges, historical moments and recaps.** Extend indexed aggregates to explicit supported bounds, then add reproducible saved chart/receipt snapshots. Shared links must preserve their original period and inputs. Longer-period PnL needs accounting appropriate to that period; never sum rolling leaderboard snapshots or treat deposits as gains.

The sequence is a dependency guide, not a commitment to ship every later feature in one session. Each delivered chunk should state what changed, its data limits and the next chunk.

## Delivered foundations

- **Chunk 1: Live Following.** Shared retained wallet reads and the bounded collector refresh queue are in use by browser Following and the agent watchlist command.
- **Chunk 2: Position details and receipt images.** Wallet open positions and retained closed/liquidated outcomes use a shared typed interpretation. Cards capture selected values and their source context; chart and receipt images share export actions and canvas helpers. Older loaded outcomes keep their original page's freshness/identity context when the head refreshes. No ingestion migration, new history scan, source connection or per-position request is required. [Definitions and limits](TRADE_RECEIPTS.md).
- **Chunk 3, first release: PAPER economics.** Current supply, staked percentage, lifetime allocated USDC and source-reported pending rewards share one saved economics response. Hourly net supply and allocated-reward changes reuse the retained observations, with gaps, partial hours and approximate history preserved. Charts expand/export; the agent CLI adds `paper`. No second collector, table migration, full scan or upstream request is introduced. [Definitions and remaining limits](PAPER_ECONOMICS.md).

- **Chunk 3, ownership extension: PAPER leaderboard.** Current staked-plus-unstaked ownership is sortable alongside 24-hour PnL, with page concentration measured against the same account directory's tracked PAPER total. The existing cached account page and bounded activity batch serve this without a new collector, crawl or migration. The CLI supports `leaderboard --metric paper`. Account counts are not positive-holder counts. [Definitions and limits](LEADERBOARD.md).

- **Chunk 4: House health.** The existing retained House samples now power LP, open house PnL and queue-debt charts alongside Funds. Signed endpoint changes explain each component's effect over the latest comparable observation segment, with actual bounds and gap handling. House freshness is independent of the legacy PAPER summary. Charts expand/export using existing components; the `house` agent command includes the same history and changes. No new source request, collector job or schema migration. [Definitions and limits](HOUSE_METRICS.md).

- **Chunk 5, wallet-first release: Margin at risk.** The existing wallet snapshot and shared reference prices power nonoverlapping bust-distance bands, cash/queued-balance margin splits and the five nearest recorded thresholds per asset. The profile and agent `risk ADDRESS` command share one calculation and independent snapshot/reference clocks. This is a hypothetical comparison, not liquidation eligibility or a complete global map. No additional source connection, history scan or migration. [Definitions and limits](MARGIN_AT_RISK.md).

The next independent feature chunk is explicit time ranges, historical moments and recaps. A global margin map still needs a continuously reconciled inventory. Global distributed/claimed rewards, per-token distributions and wallet claimable rewards remain deferred until their sources are verified; exact attributed issuance aggregation still needs its bounded correction-aware projection. Hosted immutable receipt links and replay remain part of the later historical-views work.

## October 12: freshness-first follow-up

The next approved sequence builds on the delivered chunks above, with separate reviewable releases:

1. **Shared panel delivery and measured freshness.** Reuse the existing EventSource to invalidate four saved global panels; deduplicate exact-URL browser reads; retain periodic reconciliation and old-server/disconnection fallback. Preserve independent source clocks and expose active-wallet history check-age buckets in the saved indexing status. This does not claim a shorter upstream collection cadence, complete global history, or proven 10k-viewer capacity.
2. **Wallet/PAPER experience.** Organize the profile into Overview, Positions, PAPER and History; preserve useful wallet/section links; highlight largest recorded adjusted-P&L win and loss from retained closed/liquidated outcomes. The latter requires a correction-aware indexed projection, not a per-viewer history scan or a ranking of just the loaded page. Missing positive/negative outcomes remain unavailable. Ownership includes staked and unstaked PAPER. Claimed rewards already have a source; claimable rewards remain gated on a verified source and calculation.
3. **Discovery and sharing.** Preserve supported filters and time ranges, add meaningful comparisons and since-last-check Following summaries, then daily recaps and immutable historical links. Reuse indexed aggregates and export primitives, keeping current values distinct from the inputs captured in a shared moment.

Only the first follow-up is part of this release. The wallet and discovery work remains queued; approval of the sequence does not mean those features have already shipped.
