# Public Paperdash CLI

Run with Node.js 24. No build, account, API key, wallet connection or package installation is needed:

```sh
node scripts/paperdash.mjs --help
node scripts/paperdash.mjs tvl --pretty
node scripts/paperdash.mjs overview
node scripts/paperdash.mjs wallets --page 0 --sort currentBalance
node scripts/paperdash.mjs wallet 0x1234567890123456789012345678901234567890
node scripts/paperdash.mjs positions 0x1234567890123456789012345678901234567890
node scripts/paperdash.mjs assets
node scripts/paperdash.mjs assets ETH
node scripts/paperdash.mjs leaderboard --metric pnl --page 0
node scripts/paperdash.mjs house
node scripts/paperdash.mjs liquidations --asset ETH
node scripts/paperdash.mjs indexing
node scripts/paperdash.mjs health --require-fresh
```

The example address is a placeholder, not a seeded account. Every command makes public GET requests only. The default API is `https://paperdash-api.onrender.com`; `PAPERDASH_API_URL=http://127.0.0.1:8787` or `--base-url URL` overrides it. A base URL may include a deployment prefix, but not credentials, query parameters or fragments.

## JSON contract

Stdout contains one JSON object: `{command,url,fetchedAt,data}`. `data` preserves the API response, including pagination, source timestamps, stale flags, errors and coverage. `--pretty` changes indentation only. Raw financial values remain strings; they are never converted through JavaScript `Number`. Protocol USD and PAPER raw values use 18 decimals. Ticker USD values and source house USD numbers are approximate; scaling their representation to a raw string does not restore unavailable precision.

`tvl` selects `{tvlRaw,decimals,currency,source,status}`. `positions` without an address returns the global open-position **count**, with source/status. There is no verified complete public global open-position inventory behind this command. `positions ADDRESS` returns the wallet snapshot's open-position tuples, column names and freshness. Tuple columns are `positionId,instrumentId,isLong,useDebt,entryPriceRaw,marginRaw,leverage,bustPriceRaw,openedAtMs,intentId`. BTC price integers divide by 10; ETH by 100. `useDebt` describes debt-funded margin; `intentId` is not a transaction hash. Opening times are milliseconds; the enclosing wallet `indexedThroughTimestamp` is seconds.

`house` preserves the coherent house valuation, separate PAPER summary source time and partial minute history. `liquidations` reads 50 retained observed liquidations plus cached rolling 1h/24h totals. Use `--asset BTC|ETH|0|1` to filter and `--cursor` for the next retained page. Notional means approximate USD execution size, not lost margin. No liquidation endpoint establishes complete canonical capture.

Freshness is separate from completeness. By default stale/partial observations remain usable and exit successfully. `--require-fresh` returns exit 3 for stale, unavailable or degraded results, while still printing the result to stdout. It does **not** establish complete history or a gap-free feed. The leaderboard's volume/trade modes count retained public execution observations, including opens, closes and liquidations; PnL uses the source rolling-24h ranking. Retained coverage remains partial.

## History and pagination

```sh
node scripts/paperdash.mjs wallet ADDRESS --history cashflows
node scripts/paperdash.mjs wallet ADDRESS --history trades --cursor 'CURSOR_FROM_PREVIOUS_RESPONSE'
node scripts/paperdash.mjs wallets --page 1 --q 0xabc
node scripts/paperdash.mjs leaderboard --metric volume --page 0 --q 0xabc
```

Replace `ADDRESS` with a full hexadecimal address. Each call reads only one page. Cursors are opaque and URL-encoded. No command silently traverses every wallet/history page; inspect `nextCursor`, `pageInfo` and coverage before requesting another page. Directory and leaderboard ranks can move between requests. Volume/trade search accepts only a wallet prefix, while the source PnL ranking also accepts names.

## Failure behavior

Errors are JSON on stderr: `{error:{code,message,...}}`. Exit codes are 0 success, 1 HTTP/network/response failure, 2 invalid arguments, and 3 failed `--require-fresh`. HTTP errors retain status, optional `retryAfterMs`, attempt count and any JSON error response. A readiness HTTP 503 is an error even if a response body is available.

Defaults are 10 seconds per attempt, a 30-second total request budget, and one additional attempt. Only transient HTTP statuses (408,429,500,502,503,504) and network/timeouts retry. HTTP 401/403 and malformed successful responses do not retry. `Retry-After` seconds and HTTP dates are honored; if the requested cooldown does not fit the remaining budget, the CLI exits immediately with cooldown metadata instead of retrying early. Options `--timeout-ms`, `--max-wait-ms` and `--retries` have explicit upper bounds. Response bodies are capped at 8 MiB. There is no watch loop or automatic pagination.

Use JSON parsing in agents rather than matching formatted money or assuming a nonempty result means fresh/complete data. No local database, signing capability or trading operation is exposed.
