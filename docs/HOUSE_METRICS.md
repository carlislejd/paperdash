# House and PAPER metrics

Verified October 10, 2026 from the public [house endpoint](https://exchange.papertrade.xyz/state/house/current), [protocol summary](https://exchange.papertrade.xyz/query/protocol/summary), and previously captured official frontend modules. Old hashed module URLs may expire after a frontend deployment; local captures preserve the inspected definitions.

The house frame is `{ok,historyGeneration,historyRevision,sourceAsOfMs,head,heads?}`. `head` has eight entries: `[timeMs,lpUsd,traderOpenPnlUsd,queueUsd,btcTraderLongEntryUsd,btcTraderShortEntryUsd,ethTraderLongEntryUsd,ethTraderShortEntryUsd]`. Its time equals `sourceAsOfMs`. Values after time are already USD numbers. LP and PnL are signed; queue and notionals are nonnegative. Optional bundled history is not needed for ongoing collection.

The official [House UI](https://exchange.papertrade.xyz/assets/PaperSummaryCard-DhkJzzzL.js) defines House Funds as **LP Balance + Open House PnL − Queue Debt**, from one coherent publication. House open PnL is the inverse of aggregate trader PnL, so the implementation uses `head[1] - head[2] - head[3]`. LP Balance includes the payout reserve. Do not subtract that reserve again, add leverage, multiply OI into funds, or mix the independent protocol-summary LP balance into this formula. Negative House Funds are valid and remain visible.

A nonzero public sample had `sourceAsOfMs=1791644716387`, LP `$4,874,685.202861032`, trader open PnL `$1,109,648.8560198427`, and zero queue debt. Its decimal-representation House Funds are `$3,765,036.3468411893`. The parser converts each supplied numeric representation to an 18-decimal integer before signed arithmetic. This avoids multiplication/addition rounding in derived amounts; it does not make the upstream floating-point publication exact. Sub-18-decimal residue truncates toward zero. Coverage explicitly marks these values approximate.

The independent summary provides integer strings with 18 decimals. The official [PAPER selectors](https://exchange.papertrade.xyz/assets/selectors-BDXWQuej.js) map supply to `paper.supply`, staked to `paper.staked`, displayed lifetime Staker Rewards to `fees.lifetime`, and pending rewards to `paper.pendingRewards`. Staker Rewards means lifetime USDC allocated to stakers, not token issuance or already-claimed user rewards. The [staking documentation](https://docs.papertrade.xyz/#/paper/staking) distinguishes accrued claimable rewards and fee distribution. Do not substitute `paper.reserve`, `paper.accumulator`, or pending rewards for the lifetime statistic.

Other summary fields: `balances.tvl` is total exchange USDC; `balances.margin` is user margin; `activity.open` is current open-position count; `activity.volume` is lifetime traded notional. Summary `source.at` is milliseconds and `source.block` is a decimal string. The house frame has no independently verified indexed-block field. `sourceBlock` in the dashboard's house response therefore belongs to its **protocol summary**, with a separate `summarySourceAt`; it is not the block of the house valuation.

## Dashboard prominence

The House health section appears immediately below the overview headline metrics. House funds are the featured chart, with LP balance, open house PnL and queued payouts alongside their coherent change decomposition. Each uses the house source clock and independent stale state. The label describes observable inputs, not a solvency rating or payout guarantee.

The hardcoded mint-threshold and staking-surplus explainer was removed from this section in the October 19 release. This does not establish that any particular threshold changed; upcoming protocol rules require separate activation verification. The section emphasizes observed balances and liabilities.

## Retention and public response

The existing collector house request serves all viewers. One latest sample per minute is durably retained in `house_samples`; a source-time regression cannot replace a newer sample, including across minute boundaries. Equal source timestamps can receive later corrections. PG writers serialize the ordering guard and upsert with a transaction advisory lock. SQLite uses one atomic guarded upsert. Samples survive restarts and are not reset when public views change.

The worker builds a cached 24-hour history with at most 300 points from at most 1,441 indexed minute observations. Each point now exports the LP, open house PnL and queue-debt values already retained with House Funds. The public `/api/house` handler reads the saved response, rather than upstream history or per-viewer historical scans. Chart time is the actual observation's source time. Discontinuities from generation changes or observation gaps greater than two minutes are marked `gapBefore`, including when thinning skips over a gap. Retained history is partial observation history, never an assertion of complete canonical protocol history.

The default House Funds chart fits the available observations within that 24-hour window, with a minimum one-minute range for a single sample. Its taller plot preserves missing values and gap markers. The chart does not offer a longer history window than the endpoint provides; PAPER charts retain their independently selected range.

The component cards use those same timestamps and gaps, with independent charts and PNG export. Existing `house-funds` links remain valid; component links use `house-lp`, `house-open-pnl` and `house-queue-debt`. Old cached responses without component fields can still display current values; missing historical components are not reconstructed or replaced with zero.

## Observed change

`change` compares the first and last coherent samples of the newest comparable segment in the retained 24-hour window. It is computed before thinning, after the last recorded gap or generation boundary, and requires at least two strictly ordered complete samples. The endpoint must match the current House publication in timestamp and all components. Otherwise the comparison is null, including old componentless history and concurrent-read mismatches. No larger history scan, new table, extra source request or migration is needed.

The response contains `fromMs`, `toMs`, `sampleCount` and signed raw differences `fundsRaw`, `lpRaw`, `openPnlRaw`, `queueDebtRaw`. Derived arithmetic uses integers: `fundsRaw = lpRaw + openPnlRaw - queueDebtRaw`. The UI negates queue-debt change when showing its effect on funds. These are endpoint component differences from approximate publications, not attributed cashflows, fee income or realized house profit. A positive LP change alone cannot identify deposits, and an open-PnL change can reflect marks and position composition.

Use the returned bounds instead of labeling this a full 24-hour change. `sampleCount` describes source samples used for the comparison, not the thinned displayed point count. Observations remain partial even within a segment. Negative funds and zero changes are valid; missing comparisons stay unavailable. There is no solvency rating, backing ratio or inferred future return.

House values and PAPER values may have independent source times. Missing values remain null. Freshness considers each source/receipt time, the collector heartbeat and source-loop errors; repeated receipt of an old house frame does not make its valuation fresh. `houseStale` tracks House and collector health independently of the legacy PAPER summary; the top-level `stale` remains conservative for both blocks. The dashboard falls back to `stale` if an older response lacks `houseStale`. The response includes `house`, `paper`, `sourceAt`, `receivedAt`, `sourceBlock`, `summarySourceAt`, `history`, `change`, `houseStale`, `stale`, and coverage `{source:'retained-house-observations',approximate:true,observedFrom,partial:true}`.

The PAPER panel now reads `/api/paper/economics` for a coherent summary and its own freshness rather than borrowing the house valuation's clock. `/api/house` keeps its existing PAPER fields for API compatibility. The new panel adds staking participation and hourly net supply/allocated-reward changes; see [PAPER economics](PAPER_ECONOMICS.md) for accounting and history limits.

Public ticker liquidations use `kind:'liq'`; closed wallet outcomes use `kind:'Liquidated'`. A live liquidation feed made from retained ticker observations remains partial, even when its connection and collector are healthy. It must not claim a complete canonical liquidation archive.
