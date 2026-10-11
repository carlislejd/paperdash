# Shared foundations and staged features

The October 10, 2026 feature discussion is being delivered as separate reviewable releases. Completing one chunk does not imply the later chunks are available. Each release gets focused tests, normal CI and targeted live checks; it does not trigger a new broad production load audit.

## Reuse before extending

The existing collector, durable raw observations, history checkpoints, source-overlap projections, shared request coordinator, API caches and chart exports remain the foundation. No second collector, parallel wallet ledger or independent per-viewer upstream connection is needed for these features.

The first addition is a per-address retained account summary with bounded batch reads and temporary, deduplicated collector refresh requests. Current wallet valuations and observed execution activity keep independent freshness. Original observation times survive caching. Missing values remain unavailable; observations remain partial rather than being promoted into a canonical ledger.

Later features should reuse this read boundary, retained wallet outcomes, minute aggregates and existing export components. Introduce additional history or indexes only with the chunk that needs them. In particular, neither the current live ticker nor selectively fetched wallet snapshots establish a complete global open-position inventory.

## Release sequence

1. **Live Following and wallet read foundation.** Migrate saved browser entries to identities, show current retained summaries and recent activity, and refresh known watched wallets through a globally bounded collector queue. Keep ten wallets per page and one visible-page request; no alerts or sign-in in this release.
2. **Trade receipts and richer wallet details.** A single typed interpretation of retained outcomes and open-position tuples should serve detail views, branded receipts and future statistics. Preserve initial margin, cash/debt funding, entry/bust/exit prices, holding duration, adjusted PnL and PAPER issuance with explicit provenance. Do not infer missing open/close pairs from sampled chart trades.
3. **PAPER economics.** Aggregate retained issuance and reward history. Distinguish allocated, distributed and claimed USDC, and use stake at distribution time for per-token realized distributions. Supply growth is not revenue or a token price. Wallet claimable rewards need a verified source before display.
4. **House health.** Retain the components of each coherent house publication alongside funds so changes in LP, open house PnL and queue debt can be explained. Do not mix timestamps or treat TVL as available house backing.
5. **Margin at risk.** Start with verified wallet positions. A global bust-price map requires a continuously reconciled position inventory and source-correct cash/debt margin semantics. A price-band scenario is not a prediction of which positions will actually liquidate.
6. **Time ranges, historical moments and recaps.** Extend indexed aggregates to explicit supported bounds, then add reproducible saved chart/receipt snapshots. Shared links must preserve their original period and inputs. Longer-period PnL needs accounting appropriate to that period; never sum rolling leaderboard snapshots or treat deposits as gains.

The sequence is a dependency guide, not a commitment to ship every later feature in one session. Each delivered chunk should state what changed, its data limits and the next chunk.
