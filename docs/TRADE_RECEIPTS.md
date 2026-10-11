# Position details and trade receipts

The second staged release adds an inspectable position card to wallet profiles and a downloadable/shareable PNG. It reuses retained wallet outcomes and account snapshots. Selecting or exporting a record does not start another history scan, join sampled ticker events, or fetch a position from the source.

## Scope and accounting

Closed and liquidated receipts represent one retained wallet outcome. Open-position cards represent a position at the wallet snapshot's indexed time; they do not promise that the position is still open now. A receipt captures its record and observation context when selected so background refreshes cannot change it during export. Reopen the position to select a newer observation.

Keep these measures separate:

- Initial margin is the source's 18-decimal accounting amount. It is not entry notional, account equity, or independently reconciled cash lost.
- Entry notional is initial margin multiplied by entry leverage with integer arithmetic.
- Display adjusted PnL as supplied and keep the reported user fee separate; do not infer settled cash or combine it with PAPER issuance as a return. Adjusted PnL is not labeled net of the user fee. The user fee is not total protocol fees: a separate LP-side loss-fee carve can exist without increasing the user's loss.
- PAPER minted is a token amount, not USDC revenue or a dollar valuation. Receipts show the reported PAPER issued; the internal eligible-loss mint basis is omitted. An optional batch total has a separate meaning and must never be presented as this position's issuance.
- Entry and exit prices on outcomes use the row's own `priceScaleRaw`. Open BTC and ETH positions use the verified instrument scale; an unknown instrument must not inherit BTC's scale.
- A bust price is shown only when the position snapshot records it. Do not derive a missing historical bust price from leverage.
- Holding duration ends at the outcome timestamp, including a liquidation. It does not continue until a queued payout settles.

All raw amounts remain decimal integer strings. USD and USDC amounts display to two decimal places in cards and PNGs, rounded using integer arithmetic. Full precision remains available in the card's exact-value section. Missing and malformed fields remain unavailable rather than becoming zero. Invalid or future timestamps must not create a plausible holding duration.

## Identity, freshness and sharing

Position IDs need wallet/source scope. A transaction can contain several position outcomes, and retained source data can be corrected. The card therefore includes position identity and observation context; it is not a canonical onchain proof or a settlement receipt. History completeness and freshness remain separate. A history page's receipt time records its scan freshness, not an immutable receipt time for every record in that page.

The PNG preserves the selected observation, with currency rounded to two decimals, timestamps and available coverage qualification. The copied link opens the wallet; it does not resolve an immutable receipt or promise that the selected record appears on the first history page. A reproducible hosted snapshot/link belongs to the later historical-views release.

The dashboard never reconstructs an outcome from matching a wallet, notional and approximate time in the global live feed. Available history can be paged through the existing wallet-history controls.

See [position source contracts](POSITION_METRICS.md), [public agent usage](CLI.md), and the [release sequence](FEATURE_CHUNKS.md).
