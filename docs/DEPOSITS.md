# Daily deposits and first-time depositors

Overview shows two seven-day UTC charts from retained wallet cashflows. Deposit volume sums positive, credited `Deposit.amountRaw` values, including repeat deposits. It is a flow, not current TVL or traded notional. Withdrawals, zero amounts, pending bridge requests, and wallet account creation are not deposits.

First-time depositors counts wallets on their earliest retained positive deposit day. This measures wallets, not unique people. Existing cashflow identity is provisional (wallet, transaction, kind, timestamp and occurrence), and wallet histories are partial. The chart describes available records; reaching the end of the local projection is not proof of complete upstream history. An older backfill can move a wallet's first day. Source absence does not delete a retained record or establish a reorg tombstone.

## Storage and corrections

The collector incrementally projects `history_records` cashflows into deposit facts, per-wallet first dates and exact UTC day totals. Amounts and counter deltas use BigInt; API amounts remain 18-decimal strings. A retained-key correction retracts the old amount/day and applies the new contribution in one transaction. Indexed earliest-deposit lookups adjust first-day counts in both directions. Receipt-only replays do not queue more projection work unless a previously future timestamp becomes eligible. Invalid/future deposits are excluded and counted in coverage.

A durable queue is marked in the same fenced transaction as the retained cashflow. Pre-existing rows are discovered once with a persisted `(address, record_key)` keyset. New or corrected rows behind that cursor still enter the queue through the producer. PostgreSQL queue-row locking and a shared totals lock serialize changes, including two concurrent updates to the same wallet. A failed transaction leaves its queue item retryable.

The existing five-second position-metrics collector loop also services this projection. Each tick admits at most 500 legacy keys and 500 queued records (hard input cap 1,000), with a one-second legacy admission budget and two-second total admission budget; an admitted transaction finishes or rolls back. It uses stored data only. No upstream endpoint, request limit, history scheduling lane or source cadence changes.

## Delivery and display

The existing ten-second protocol chart refresh makes one bounded, indexed rollup query for seven UTC days. Results travel in optional `ProtocolChartsResponse.deposits` on `/api/protocol/charts`, using the same snapshot, cache, revision and browser subscription as the existing charts. Visitors do not scan cashflows or start a deposit request loop. An unchanged economic projection preserves its update timestamp and chart revision.

Today is a lighter, partial bar and grows as retained deposits arrive. Days before the earliest retained deposit remain unknown. Missing buckets are shown as zero recorded deposits only after local projection catches up, on or after that earliest day, with no stale/error state; source coverage still remains partial. First-depositor axes use integer rounded ticks. Both cards support expansion and the existing branded PNG export, preserving the coverage note. The displayed timestamp is when stored totals changed, not a claim that every wallet has just been checked.

If projection reads fail, the saved last-good deposit series stays visible and is marked delayed; independent protocol/PAPER charts can still publish. Collector interruption/projection errors mark retained data stale. Old deployed responses without the optional field remain compatible.

## Migration and release

Run the owner migration before new runtime code. It creates six deposit projection tables; the index on retained cashflows is built concurrently after the schema transaction, with a dedicated bounded owner connection. Interrupted matching indexes are repaired on retry; unexpected definitions stop migration. Runtime connections validate schema/index presence and never run DDL.

Production uses the existing API `npm run db:migrate` pre-deploy gate, followed by API, collector and web rollout. Explicit runtime grants support the separate-role setup without exposing raw deposit projection tables to the API; the API needs only the schema-state startup probe and saved response. Focused tests cover exact large amounts, duplicates, corrections, earlier/later first dates, restart/cursor behavior, concurrent producer/projector races, unknown coverage, last-good fallback, shared delivery and chart exports.

If an emergency rollback runs a collector older than this projection, its new cashflows will not mark the deposit queue. Before returning to the new collector, reset only the local projection discovery cursor (`deposit_metrics_state`: cursor_address/cursor_key empty, complete=0) under the owner migration path. Retain facts, day totals and raw history. The bounded idempotent rewalk then discovers missed records/corrections without re-fetching upstream history or counting unchanged facts twice.
