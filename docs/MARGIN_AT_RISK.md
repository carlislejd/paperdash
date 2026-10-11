# Wallet margin at risk

The first release describes the open positions in one wallet snapshot. It reuses the existing snapshot request and saved shared BTC/ETH reference prices. The API adds optional `WalletResponse.marginRisk`; the drawer and `risk ADDRESS` agent command use that same result. There is no additional upstream request, collector, full-history scan, schema change or global inventory claim.

## Quantities and source meaning

The shared open-position interpreter validates the wallet tuple: position ID, instrument, side, cash/queued funding, initial margin, leverage, entry/bust price and opening time. Verified instruments are BTC (price scale 10) and ETH (scale 100). Margin is an unsigned 18-decimal raw amount. Its funding split is exhaustive for included positions: cash + queued-balance margin = initial margin. Queued margin represents a balance claim, not new cash or ordinary borrowing. Initial margin remains distinct from notional, unrealized equity and expected loss.

The reference is the shared Hyperliquid bid/ask midpoint captured by the existing collector. That feed publishes a JavaScript numeric midpoint; `priceRaw` preserves its decimal representation at 18 decimals. It does not recover unavailable source precision. Papertrade's captured valuation code uses an integer midpoint at the instrument's price scale and can use frozen prices for terminal instruments. Terminal flags/frozen prices and a quote matching the snapshot's protocol block are not available here. Therefore this feature compares recorded thresholds against an approximate reference; it cannot determine live liquidation eligibility.

Source evidence checked against the captured Papertrade valuation module and official documentation:

- [Trades and pricing](https://docs.papertrade.xyz/#/learn/trades-pricing)
- [Liquidations](https://docs.papertrade.xyz/#/learn/liquidations)
- [LP and queue](https://docs.papertrade.xyz/#/learn/lp-queue)
- [BBO pricing](https://docs.papertrade.xyz/#/how/pricing-bbo)
- [Risk](https://docs.papertrade.xyz/#/how/risk)

## Band calculation

For a reference price R and recorded bust B, signed distance is `(R − B) / R` for longs and `(B − R) / R` for shorts. Multiply by 10,000 for basis points. Long adverse movement is down; short adverse movement is up. Bands partition all included positions with a usable reference:

| Band | Signed basis points |
| --- | --- |
| At or beyond reference | ≤ 0 |
| 0–0.1% | (0, 10] |
| 0.1–0.25% | (10, 25] |
| 0.25–0.5% | (25, 50] |
| 0.5–1% | (50, 100] |
| 1–5% | (100, 500] |
| Over 5% | > 500 |

Cross-products use `BigInt` after reconciling price scales. Margin aggregation and comparisons never convert raw amounts to floating point. Numeric `distanceBps` is approximate display output only. Upper boundaries are inclusive; the bars are not cumulative. Each band contains separate long and short totals, each split into cash and queued margin. Asset totals cover all valid positions. `nearest` is at most five per asset sorted by absolute distance, independently of margin size. Its cap never limits aggregation.

A zero bust price is representable and is not automatically discarded. Missing quotes leave valid asset totals available with `bands: null` and no nearest results. At/beyond reference means only that the two recorded inputs cross; it is not a statement that the position should be liquidated now.

## Coherence, freshness and coverage

The backend derives risk from the exact fulfilled cached snapshot selected for the wallet response. It does not reread a potentially newer snapshot after selecting the wallet data. Snapshot block, revision, source time and its own receipt time are preserved independently from older portfolio/history pages. Shared market heads are read in a bounded batch and compacted into a single-entry, one-second read cache shared across wallets in each API instance. Concurrent reads are deduplicated, failed reads are not cached, and freshness is recalculated from the original clocks. Reference failures degrade risk without failing the wallet profile. No historical market query is needed.

Snapshot and reference source/receipt clocks have independent stale flags. A stale but valid reference can still describe a visibly delayed scenario. Missing snapshot is unknown, while a valid empty snapshot has zero positions without requiring unused quotes. Reference freshness also accounts for the saved market publication, active shared connection and collector heartbeat; a trade-feed delay alone does not make a valid price stale. Connection transition time is not treated as heartbeat time.

The snapshot is bounded to 10,000 rows. Unknown markets, malformed fields, invalid clocks and duplicate identities are excluded explicitly. Every row of a repeated wallet-scoped position ID is removed, rather than choosing one arbitrarily. `duplicateCount` is a row count already included in `excludedCount`. Included plus excluded equals the snapshot row count when the snapshot itself is valid. `coverage.partial` remains true because neither one snapshot nor an available reference certifies complete protocol capture.

The drawer guards matching address, source time, block and revision when retaining a previous snapshot during refresh. A rejected older snapshot cannot supply a new-looking risk calculation for the retained newer one. Exported images capture the selected scenario and its clocks; copied wallet URLs open current data, not an immutable scenario. Older APIs without the optional field render unavailable.

## Scope boundary

This release does not create a global liquidation heatmap, forecast cash losses or rank protocol solvency. A global map needs a continuously reconciled open-position inventory, close/correction handling and verified terminal-market metadata. Reusing selectively fetched wallet snapshots or the recent-trade ticker would create misleading gaps and duplicates.
