# Position duration and leverage

Verified **2026-10-10** against the current official documentation bundle and the publicly served account decoder, with the retained trade-history contract in the captured official frontend. This note defines descriptive dashboard metrics, not estimates of return or account risk.

## Source contracts

`GET /query/accounts/<address>/trades?filter=all&limit=75` returns closed-position records with these relevant fields:

| Field | Meaning / representation |
| --- | --- |
| `positionId` | Unsigned decimal string; retain with wallet and deployment scope. |
| `kind` | `PositionClosed` or `Liquidated`. |
| `openedAtMs` | Opening execution timestamp, milliseconds since Unix epoch. |
| `timestampMs` | Closing/liquidation execution timestamp, milliseconds since Unix epoch. |
| `leverage` | Positive integer entry leverage multiplier, e.g. `10` means 10×. |
| `marginRaw` | Initial margin in USD accounting units with 18 decimals. |
| `instrumentId`, `symbol`, `isLong` | Market and direction. |
| `txHash` | Outcome transaction; multiple positions can share a transaction. |
| `terminal`, `retired` | Instrument lifecycle flags, not the position's payout status. |

The current wallet SSE snapshot includes `openPositions` as ten-element tuples:

```text
[positionId, instrumentId, isLong, useDebt, entryPriceRaw,
 marginRaw, leverage, bustPriceRaw, openedAtMs, intentIdOrNull]
```

The official decoder maps tuple index 8 directly to `openedAtMs`; do not multiply it by 1,000. `indexedThroughTimestamp` on the enclosing wallet snapshot uses seconds and is a separate field. Current application storage preserves the tuple, although its shared TypeScript type is presently `unknown[]`. [Official account decoder](https://exchange.papertrade.xyz/assets/account-wire-oK7wgoTe.js), [official trade-history schema and query](https://exchange.papertrade.xyz/assets/index-CvChIo_I.js).

Official trading documentation says a position's margin and leverage remain fixed until it ends. Closing is full size; scaling in creates another position, and reducing a position requires closing it and opening a smaller one. Therefore a closed row represents one completed position rather than a partial-close slice. Entry notional is margin multiplied by leverage. [Trades and pricing](https://docs.papertrade.xyz/#/learn/trades-pricing), [current docs bundle](https://docs.papertrade.xyz/assets/index-CdRrkZnQ.js).

Include closed outcomes from retired/terminal markets. Market retirement fixes the price used for subsequent closes; it does not invalidate the resulting holding duration. A winning position may also be closed while its payout remains queued: duration ends at closing execution, not when USDC is paid. [Market retirement](https://docs.papertrade.xyz/#/how/risk), [payout queue](https://docs.papertrade.xyz/#/learn/lp-queue).

## Chosen dashboard definitions

Both closed metrics use the **same valid retained cohort**, including voluntary closes and liquidations, with one equally weighted observation per eligible position:

```text
heldMs(position) = timestampMs - openedAtMs
averageHeldMs = sum(heldMs) / validPositionCount
averageEntryLeverage = sum(leverage) / validPositionCount
```

Require valid nonnegative integer epoch-millisecond timestamps, opening no later than closing, closing no more than 30 seconds beyond the retained observation's `received_at` (a small clock-skew allowance), and a valid positive integer leverage. Exclude malformed, inverted, negative or excessively future timestamps and ambiguous retained rows from **both** means; expose an excluded count. A valid zero-duration position remains included. With no valid positions, both means are unavailable, not zero. Re-evaluate an unchanged payload when a later source observation updates `received_at`, so a previously rejected future timestamp can recover without appending another contribution.

For a rolling window, select positions by their closing timestamp. Use their entire holding duration even when they opened before the window. For all retained history, aggregate beyond the first response page; never silently calculate a lifetime-looking metric from only the latest 75 rows.

Global averages use total sums divided by total eligible position count. Do not average wallet averages: a wallet with one position must not receive the same weight as a wallet with 1,000 positions. These are position-weighted means, not margin-, notional-, or time-weighted means. Keep exact aggregate sums/counts where practical and round only for display.

Current open positions are separate snapshot rows. This release shows each position's age and entry leverage; it does not add open-position averages. Calculate ages at a declared `asOf`; stale snapshots must remain visibly stale and must not imply that a possibly closed position is still live. Reject future opening timestamps. The chosen closed-position average leverage is not effective leverage against current equity; do not label it account risk or equity leverage.

## Coverage and identity limits

Position IDs make source-level matching stronger than the public ticker, but do not prove complete canonical coverage. Retain deployment/wallet scope, source provenance, valid/excluded counts, and history coverage. An upstream correction should replace its previous contribution rather than append another position. Preserve the original records for reconciliation.

The global `public:trades` ticker lacks position IDs and opening timestamps on outcome events. It cannot reliably pair opens with closes or reconstruct holding duration. Mixing its open, close and liquidation leverage values would also count completed positions more than once. Closed statistics should come from retained wallet outcome records and clearly indicate partial discovery/backfill coverage. Current open-wallet snapshots are fetched on demand; they are not a complete synchronized inventory of all global open positions. [Public source limitations](../research/DATA_SOURCES_2026-10-09.md).

Verification detail: the publicly served account decoder was re-read on October 10 and matches the previously inspected bytes (`sha256:49df45731a8a78726e868c4f5d96110684b9cc8e7fa84c5f83b07f27d41eed31`). The docs entrypoint currently selects `index-CdRrkZnQ.js`. This verifies the public contracts and documented behavior; it is not a claim that a nonzero live position sample or canonical chain reconciliation was observed during this review.
