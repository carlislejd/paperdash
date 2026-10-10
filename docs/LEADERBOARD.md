# Leaderboard activity columns

The default rolling-24-hour PnL leaderboard keeps the source account ranking. Its current unrealized PnL comes from the same account snapshot and is distinct from the 24-hour PnL used for ordering. Trade counts, volume, and traded assets come from retained public trade observations within the last 24 hours; they include opens, closes, and liquidations and remain partial coverage.

Activity is queried in one batch for at most 25 displayed wallets and cached for 20 seconds through the existing shared-cache coordination. A cached page is reused only when its address set matches the requested accounts. No per-wallet upstream calls are added. Activity timestamps and stale flags are separate from the account valuation timestamp and stale flag.

Volume and trade-count rankings continue to use retained observations. These rankings expose observed assets but leave current uPnL unavailable because the activity query does not provide account valuations. Unknown values render as an em dash; zero activity and an empty observed asset set are shown only when the projection supports them. BTC and ETH badges describe assets traded during the window, not currently open positions.

The wallet/time/fingerprint index bounds asset lookups to the requested wallets and time window. PostgreSQL creates it concurrently in a separate owner migration session after the schema transaction. The migration verifies its definition and validity, preserves an already valid index, and repairs an interrupted matching build on retry. Runtime connections only check the catalog. The maintenance session has a bounded 120-second server statement timeout and 130-second client deadline; API and collector query deadlines are unchanged.
