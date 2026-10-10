# Running Paperdash

Paperdash is a public-source analytics beta. It reads the official Papertrade HTTP endpoints and public trade stream. It does not submit orders, connect a user's signing wallet, run a blockchain node, or currently decode canonical HyperEVM contract events.

Global trade observations, minute TVL samples, wallet cashflows/trades, raw history pages and portfolio batches are retained in our database. Protocol totals and current account details remain upstream snapshots with source timestamps. Wallet history has separate indexing and coverage status. A connected stream or completed source backfill is not proof of complete execution history. The upstream recent-trades feed is bounded, and its public stream does not provide canonical transaction identities. Do not describe this deployment as an independently reconciled ledger or a complete lifetime trade archive. The earlier [research plan](../research/DASHBOARD_PLAN.md) describes later canonical ingestion work; this document describes the implemented beta.

## Local development

Use Node 24 and the committed npm lockfile:

```sh
cp .env.example .env
npm ci
npm run dev
```

Vite serves the frontend at `http://127.0.0.1:5173` and proxies `/api` to the API on port 8787. With `DATABASE_URL` absent, the API runs its collector and a durable SQLite store. The example environment uses `.data/paperdash.sqlite`. Keep the database, `-wal` and `-shm` files together while running; stop the process before making a simple filesystem copy. Local collection fails visibly at `LOCAL_MAX_BYTES` rather than silently removing financial observations. Do not use local SQLite for multiple Render instances: their filesystems are ephemeral and not shared.

For local Postgres, set both `DATABASE_URL` and `REDIS_URL`, run `npm run db:migrate`, then run `npm run dev` and `npm run dev:ingest` in separate terminals. The API defaults to no embedded collector when Postgres is configured. Redis is required with Postgres so API replicas and the worker share one upstream request budget. Single-process SQLite development can use the in-process coordinator. Do not enable an embedded collector while intentionally running another collector against the same local store.

Production builds use `npm run build`; API and worker commands are `npm run start:api` and `npm run start:ingest`. `npm run db:migrate` is idempotent and serializes database migrations. Secrets belong in environment variables or the hosting dashboard. All `VITE_*` variables are public browser build inputs.

## Render deployment

The authoritative deployment file is [render.yaml](../render.yaml); [infra/render.blueprint.yaml](../infra/render.blueprint.yaml) is an identical convenience copy. CI verifies both against the saved official Render schema. Use the dedicated Paperdash Pro workspace for database HA and separate billing from unrelated projects. All stateful/backend resources must stay in the same region; the Blueprint uses Oregon. Creating these files does not provision anything.

The initial beta was deployed on October 9, 2026: [frontend](https://paperdash-web.onrender.com), [API readiness](https://paperdash-api.onrender.com/health/ready), and [indexing status](https://paperdash-api.onrender.com/api/indexing). The deployed database uses PostgreSQL 18 with HA enabled and 50 GB per copy; Key Value uses Valkey 8 with `noeviction`. Blueprint auto-sync and service auto-deploy are disabled. These public endpoints report the current state; a past successful deploy is not a guarantee of present freshness.

Initial release verification: frontend/API `b4c88c6`, collector `682a480`. [CI passed](https://github.com/carlislejd/paperdash/actions/runs/38028420500) with 73 unit/integration tests (including PostgreSQL and Redis), 14 desktop/mobile browser tests, seven Python tests and Blueprint validation. The production replacement logged standby at 22:43:37 PDT, then acquired the lease at 22:44:38 without a crash. Retained data survived the earlier restart and this deployment. Public checks afterward returned a fresh connected stream, 300 retained TVL chart points, and advancing backfill status (622 discovered wallets, 858 completed history jobs, zero failed jobs at the sampled instant). Initial backfill was still running. SSE reconnect returned a fresh snapshot with a newer watermark; trade replay during activity, load capacity, HA failover and backup restoration were not established by these checks.

Analytics release verification (October 9, 2026): worker, both API instances and static frontend deployed commit `6a1bfae`. [CI passed](https://github.com/carlislejd/paperdash/actions/runs/38029834258) with 102 unit/integration tests, 20 desktop/mobile browser tests, the Python suite and Blueprint validation. The additive migration completed; the replacement worker waited from 23:08:20 to 23:09:20 PDT before acquiring ingestion responsibility. Public checks returned fresh BTC/ETH asset snapshots, correctly undefined shares at the source's zero OI, and newly retained history samples. The source PnL leaderboard returned 25 rows and 6,213 ranked accounts at the sampled instant; observed volume/trade rankings were empty with explicit partial coverage. Gzip, exact frontend CORS and empty 304 revalidation responses passed. Indexing continued with 1,797 discovered wallets, 2,594 completed jobs and zero failed jobs at the sampled instant. A previously unused ranking initially served its older snapshot with delayed status, then refreshed on the next visible poll. No additional Render resources or plan changes were made. Live desktop checks covered BTC/ETH switching, leaderboard page-two ranks and opening a funded wallet without losing the leaderboard route. Both mobile views fit a 412 px viewport without horizontal overflow; metric switching and fresh empty observed rankings were verified. Real production previews: [desktop assets](previews/production-assets.jpg), [desktop leaderboard](previews/production-leaderboard.jpg), [mobile assets](previews/production-assets-mobile.jpg), [mobile leaderboard](previews/production-leaderboard-mobile.jpg). These checks used live public responses, not browser fixtures; they do not establish large-scale capacity or complete trade capture.

Recovery verification (October 10, 2026): the hosted collector continued through the laptop outage; sampled overnight deposits were already retained, and no history reset was needed. Worker-only release `c078a0b` added private stream lifecycle diagnostics after a disconnected stream was found without a recorded reason. CI passed, including PostgreSQL/Redis and desktop/mobile flows. Deployment `dep-db53sj59fdbs73bh79e0` waited in standby from 06:32:26 to 06:33:27 PDT, then connected and subscribed. The worker status command reported a healthy heartbeat, no errors, 8,911 discovered wallets, 26,576 completed history jobs and zero failed jobs. Public asset snapshots were fresh again. Discovery/backfill remained in progress; the prior stream failure cause and complete trade coverage were not established. API remains `6a1bfae`; frontend `f7f857b` contains the simplified status panel, removed repository link and mobile sizing fix. No data, checkpoints, environment values or service plans were reset.

Position metrics release verification (October 10, 2026): both API instances deployed `fe01112` and the static frontend deployed `eac9cc9`. The additive migration completed and the collector finished its local position-metrics projection without resetting history checkpoints. [Feature CI passed](https://github.com/carlislejd/paperdash/actions/runs/38058004481), including PostgreSQL/Redis integration, desktop/mobile browser flows, Python tests and Blueprint validation. Live global averages populated and increased as closed history arrived. Wallet `0xb978…a2c0` produced one position held for 64 seconds at 1,000×, matching the official source and its displayed closed-trade row. Wallet `0x1aa7…9ed9` showed 18 real open positions with per-position age/leverage; expanding and collapsing the list worked. Delayed snapshots held ages at their saved source time. Both viewport sizes passed visual checks, with no horizontal overflow at 412 px. Exact frontend CORS and empty 304 revalidation passed for wallet metrics. Global discovery/backfill remains partial; these checks do not establish complete trade capture or large-scale capacity. Real production previews: [mobile overview](previews/production-position-overview-mobile.jpg), [wallet averages](previews/production-position-wallet-mobile.jpg), [open positions](previews/production-position-open-mobile.jpg). No new services or plan changes were required.

The metrics rollout exposed numeric `seq` values in actual WebSocket publications, which the existing string-only validator rejected. Worker-only repair `930c801` accepts exact nonnegative safe integers as their string identity and still rejects ambiguous numeric values. [Repair CI passed](https://github.com/carlislejd/paperdash/actions/runs/38058416070). Deployment `dep-db54f859fdbs73bj6u3g` waited from 07:12:21 to 07:13:22 PDT, then connected and subscribed. The worker reported a fresh heartbeat with no loop errors; a bounded, read-only query over the latest 1,000 observations confirmed five retained public-stream rows received after handoff, including one at 07:14:33 PDT. Position metrics had 318 eligible records at the sampled instant, with the local legacy projection complete and new records pending normally. History indexing had 9,388 discovered wallets, 27,381 completed jobs, and one job reporting failure; discovery and source-history coverage remain incomplete. API/frontend stayed on their verified metrics commits, and no records, checkpoints, environment values or plans were reset.

Dependency maintenance: the release's `npm audit --omit=dev` reported zero vulnerabilities. The full audit reported three findings in the development-only Vitest/mocker/tinypool dependency tree; the reported remediation requires a major test-runner upgrade. The deployed commands run the compiled application, with no Vitest server. Track that tooling upgrade separately from the validated runtime release.

| Resource | Configuration | Monthly fixed estimate |
| --- | --- | ---: |
| Workspace | Pro | $25 |
| Frontend | Static CDN | $0 compute |
| API | Two `1c-2g` instances | $50 |
| Ingestion | One `1c-2g` worker | $25 |
| Postgres | `2c-4g`, primary plus HA standby | $150 |
| Postgres storage | 50 GB for each copy | $30 |
| Key Value | `1g` | $20 |
| **Fixed total** | | **$300** |

Prices checked October 9, 2026. An illustrative beta budget adds $35 streaming egress and a $5 external backup/archive allowance, totaling **about $340/month**. A future $49/month archive RPC subscription would bring that example to **$389/month**, but the current app neither requires nor consumes that subscription. External archive upload automation is not implemented yet: the $5 line is an allowance, not an active service. Taxes, domains, exceptional build minutes and traffic/storage growth are additional. [Render pricing](https://render.com/pricing), [workspace fees](https://render.com/docs/new-workspace-plans), [HA billing](https://render.com/docs/postgresql-high-availability).

The $35 egress example assumes 100 average concurrent viewers receiving 1 decimal KB/second for 30 days: 259.2 GB, less Pro's 25 GB included, at $0.15/GB. Page loads, downloads and external backup uploads add traffic. This is a workload estimate, not a measured rate or a price cap. At 1,000 average concurrent viewers that same stream costs roughly $385 in overages alone. These estimates include only Paperdash and its dedicated workspace; unrelated projects are outside this budget. [Bandwidth billing](https://render.com/docs/outbound-bandwidth).

Deploy steps:

1. Run the build and tests, check the Blueprint against the saved JSON schema, then use `render blueprints validate render.yaml` with an authenticated CLI or the dashboard's Blueprint review for account-aware validation. Schema validation alone does not verify available account plans, repository access, runtime behavior or load capacity.
2. Connect `carlislejd/paperdash`, select the tested `main` commit's `render.yaml`, and review the Blueprint cost in the selected Pro workspace. Check all active and suspended resources for an existing Paperdash deployment before creating one. The definition keeps service auto-deploy and preview environments off. Blueprint auto-sync is a separate setting: it defaults on and can apply infrastructure changes when `render.yaml` changes. Set the Blueprint's Settings → Auto Sync to No for controlled manual releases. [Blueprint setup and sync](https://render.com/docs/infrastructure-as-code).
3. Deploy the Blueprint. Database connections and Redis URLs are internal references; their public IP allowlists are empty. The API runs the migration as a pre-deploy command. Initial API/worker startup also runs the idempotent migration so first-deploy ordering does not leave the worker behind.
4. Confirm `/health/ready`, the first stored protocol snapshot, `/api/indexing`, wallet lookup and a browser stream connection. Check `npm run ingest:status` from the worker environment and verify that checkpoints and retained row counts advance, including after a worker restart. No upstream trade activity is a valid empty state, not an excuse to insert fixtures into production.
5. If custom domains are used, update the API's `CORS_ORIGIN` to the exact frontend origin, set the static site's `VITE_API_URL` to the public API origin and `VITE_SITE_URL` to the public frontend origin, then rebuild the static site. Multiple allowed origins are comma separated. Blueprint URL references initially use Render's `onrender.com` URLs. Keep these changes in the Blueprint so a future sync does not replace them.
6. Complete the role hardening and recovery checks below before a broad public launch. Confirm the upstream operator's allowance for sustained polling of these undocumented public endpoints.

The API binds `HOST=0.0.0.0` and Render's provided `PORT`. `EMBEDDED_COLLECTOR=false` keeps upstream polling in the dedicated worker. The collector's database advisory lock prevents parallel active collectors during overlapping deploys. A replacement worker stays alive in standby, checking the lease every two seconds until the previous worker finishes shutdown. SIGTERM also cancels standby safely. Losing an already-held database lease is a fatal condition: the process exits immediately because it can no longer guarantee exclusive ingestion. It needs a direct Postgres connection; do not move that session onto a transaction pool.

Failed collector loops retry within 30 seconds (or their normally shorter interval), while respecting longer upstream retry deadlines. Successful reconciliation restores the normal schedule, including the hourly protocol-history refresh. Temporary cache provisioning or network errors should not leave that history loop idle for an entire hour after connectivity recovers.

## Environment contract

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection; omitted only for local SQLite |
| `REDIS_URL` | Required with Postgres; shared request coordination, cache locks and stream fan-out |
| `AUTO_MIGRATE` | `true` for initial owner bootstrap; `false` after runtime roles are restricted |
| `HOST`, `PORT` | API bind address and port; local port 8787 |
| `CORS_ORIGIN` | Exact, comma-separated allowed frontend origins |
| `VITE_API_URL` | Public API origin compiled into frontend; empty uses same-origin requests |
| `VITE_SITE_URL` | Public frontend origin for canonical and link-preview URLs; overrides Render's `RENDER_EXTERNAL_URL` |
| `EMBEDDED_COLLECTOR` | Override local API collector; `false` for production API |
| `UPSTREAM_ORIGIN` | Official HTTP source, default `https://exchange.papertrade.xyz` |
| `STREAM_URL` | Official Centrifuge source, default `wss://stream.papertrade.xyz/connection/websocket` |
| `SUMMARY_INTERVAL_MS` | Summary cadence; default 2000 |
| `RECENT_INTERVAL_MS` | Recent-trade fallback cadence; default 10000 |
| `DIRECTORY_INTERVAL_MS` | Account directory cadence; default 30000 |
| `HISTORY_INTERVAL_MS` | Source TVL history reconciliation cadence; default 3600000; minute samples are recorded between reconciliations |
| `WALLET_INDEX_INTERVAL_MS` | Background wallet-history indexing tick; default 1000 |
| `WALLET_INDEX_REQUESTS_PER_TICK` | Maximum source history requests per indexing tick; default 2, also constrained by the shared budget |
| `UPSTREAM_REQUEST_SPACING_MS` | Shared minimum spacing between upstream request starts; default 250 |
| `UPSTREAM_CONCURRENCY` | Shared maximum concurrent upstream requests; default 3 |
| `UPSTREAM_QUEUE_TIMEOUT_MS` | Maximum request-budget wait; default 8000 |
| `DATA_DIR` | Local SQLite directory; use `.data` |
| `LOCAL_MAX_BYTES` | Local collection limit; default 536870912 bytes |

Polling values are configuration, not permission to exceed upstream rate limits. Increase intervals when upstream requests throttle or operator guidance requires it; verify that any app freshness thresholds remain appropriate. Chain RPC URLs, contract manifests and archive credentials are deliberately absent from the runtime configuration because the current collector does not implement those adapters.

Keep the dedicated Key Value instance on `noeviction`: evicting coordination or lock keys would break the shared request limits. The keys have short expirations, but memory/error alerts are still required. A Redis interruption stops fresh upstream requests rather than allowing each replica to poll independently; database-backed history remains available with its last source timestamps. Restore Redis before expecting collection to resume, and verify the worker heartbeat and indexing progress afterward.

Favicons and link-preview metadata are included in the initial HTML, so crawlers do not need to run React. Builds use `VITE_SITE_URL`, then Render's automatic `RENDER_EXTERNAL_URL`, for absolute page/image URLs. Outside Render, an unset origin falls back to `http://localhost:5173` with a build warning; configure the real public origin before publishing. Supply an HTTP(S) origin without a path, query, credentials or fragment. The public preview image is `/art/paperdash-social.jpg` (1200 × 630). Social platforms cache previews; after changing it, use the platform's preview refresh tooling when available.

## Runtime database roles

The initial Blueprint injects the managed database owner's connection into both services. This makes schema bootstrap runnable, but grants more permission than a public API should retain. **It is not a least-privilege production setup.** The API writes current account/directory caches and prioritizes wallet indexing, so a strictly read-only role would break those operations.

Before broad launch, create separate API and ingestion login roles from an owner session on the private network. The following `psql` commands cover the four original tables, eight history tables, seven activity tables and four position-metric tables; the `\password` commands prompt without putting passwords in shell history:

```sql
CREATE ROLE paperdash_api LOGIN;
CREATE ROLE paperdash_ingest LOGIN;
\password paperdash_api
\password paperdash_ingest
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO paperdash_api, paperdash_ingest;
GRANT SELECT ON paperdash_snapshots, paperdash_trade_observations,
  paperdash_samples, paperdash_stream_events,
  paperdash_history_wallets, paperdash_history_jobs, paperdash_history_records,
  paperdash_history_pages, paperdash_history_visits, paperdash_history_points,
  paperdash_history_portfolio_batches, paperdash_history_corrections,
  paperdash_analytics_members, paperdash_analytics_fingerprints,
  paperdash_analytics_minutes, paperdash_analytics_oi_samples,
  paperdash_analytics_wallet_fingerprints, paperdash_analytics_wallet_minutes,
  paperdash_analytics_state, paperdash_position_metrics_queue,
  paperdash_position_metrics_rollups, paperdash_position_metrics_state
  TO paperdash_api, paperdash_ingest;
GRANT SELECT ON paperdash_position_metrics_facts TO paperdash_ingest;
GRANT INSERT, UPDATE ON paperdash_snapshots,
  paperdash_history_wallets, paperdash_history_jobs TO paperdash_api;
GRANT UPDATE ON paperdash_history_corrections TO paperdash_api;
GRANT INSERT, UPDATE ON paperdash_snapshots, paperdash_samples TO paperdash_ingest;
GRANT INSERT ON paperdash_trade_observations, paperdash_stream_events TO paperdash_ingest;
GRANT DELETE ON paperdash_stream_events TO paperdash_ingest;
GRANT USAGE, SELECT ON SEQUENCE paperdash_stream_events_id_seq TO paperdash_ingest;
GRANT INSERT, UPDATE ON paperdash_history_wallets, paperdash_history_jobs,
  paperdash_history_records, paperdash_history_visits, paperdash_history_points,
  paperdash_history_corrections TO paperdash_ingest;
GRANT INSERT ON paperdash_history_pages, paperdash_history_portfolio_batches
  TO paperdash_ingest;
GRANT DELETE ON paperdash_history_visits, paperdash_history_corrections,
  paperdash_history_points TO paperdash_ingest;
GRANT INSERT, UPDATE ON paperdash_analytics_members,
  paperdash_analytics_fingerprints, paperdash_analytics_minutes,
  paperdash_analytics_oi_samples, paperdash_analytics_wallet_fingerprints,
  paperdash_analytics_wallet_minutes, paperdash_analytics_state
  TO paperdash_ingest;
GRANT INSERT, UPDATE ON paperdash_position_metrics_queue,
  paperdash_position_metrics_facts, paperdash_position_metrics_rollups,
  paperdash_position_metrics_state TO paperdash_ingest;
GRANT DELETE ON paperdash_position_metrics_queue,
  paperdash_position_metrics_facts TO paperdash_ingest;
```

Neither runtime role needs `CREATE`, `ALTER`, `DROP`, ownership or access to unrelated schemas. New tables/sequences require explicit reviewed grants. Store the two role URLs separately in Render, replace the two `fromDatabase` entries with `sync: false`, and set `AUTO_MIGRATE=false` in both services. Keep the database's internal host/database name; only the URL-encoded username/password change.

Move migrations to a one-off deployment step that receives the owner connection separately; remove the API's `preDeployCommand` once its runtime URL is restricted. Run the migration before rolling out compatible API/worker code, then deploy with runtime roles and smoke-test wallet reads, cache writes, indexing priority updates and worker checkpoints. Never keep a schema-owner secret in an API runtime merely to run migrations. PostgreSQL `LISTEN` or session advisory locks require direct connections; API query pools may later use managed PgBouncer independently. [Connection pooling](https://render.com/docs/postgresql-connection-pooling).

## Retained history and indexing

The worker repeatedly sweeps the mutable wallet directory and discovers active wallets through trade observations. A wallet lookup also enrolls and temporarily prioritizes that address. Three durable jobs per wallet cover cashflows, trades and portfolio history. The indexer alternates priority work with older due work so browsing does not indefinitely starve the background queue. The shared Redis budget limits all HTTP request starts and in-flight requests across API replicas and ingestion; it does not count WebSocket messages as HTTP polling.

Cashflow/trade pages commit normalized records, the original source page and a fenced checkpoint in one database transaction. A 120-second job lease expires if the process dies; its successor can resume from the saved cursor. Replaying a committed page does not blindly append another copy. Source-field/occurrence identities remain provisional, especially for cashflows with no unique source event ID. Changed source pages remain as raw variants even when a projection is updated. `backfillComplete` means the available source pages reached their end, not that we proved lifetime or canonical completeness.

New activity is refreshed from the head while deep backfill continues. A dedicated retry revisits observed pending cashflows for later status changes. If a main backfill cursor expires with a 400/404, indexing restarts that bounded scan from the head while keeping retained records. An invalid pending-correction cursor remains an explicit error with backoff; it must not silently become an unrelated head scan. Repeated cursors and malformed ordering are errors. Inspect them before resetting any checkpoint, and never delete retained records to force a retry.

Portfolio history begins with an available full-range fetch, then refreshes supported recent windows, expanding after gaps and periodically reconciling the full range. Raw batches are retained. A newer source generation can replace the active chart projection without deleting the earlier raw batches. Older/invalid revisions are rejected. The API limits a portfolio response to 10,000 timestamp groups and preserves incomplete/gap coverage instead of claiming the truncated chart is complete. Source money values remain integer decimal strings; plotted values are display projections.

Wallet history endpoints use local keyset cursors, not expiring upstream cursors. Current account snapshots and directory results can still refresh through the shared source cache. There is no per-visitor upstream wallet-history download. TVL history is reconciled hourly by default and extended with continuously recorded minute samples. Global public trade observations are kept separately from wallet trade history; they are not merged into a falsely exact global execution ledger.

From a worker shell with its existing environment, run `npm run ingest:status` for heartbeat, stream lifecycle diagnostics, queue counts and the oldest due job. Add `--` followed by a full wallet address for that wallet's checkpoints. The command exits nonzero if the saved collector heartbeat is older than 30 seconds. `/api/indexing` reads the worker's periodically saved aggregate and reports its timestamp; it does not perform a full queue scan for every caller. A healthy heartbeat alone does not establish that every history job is progressing: watch pending/failed counts, oldest due time, per-wallet last success and retained counts together. Full backfill time depends on source limits, wallet count and history depth.

The hosted collector continues when a developer's laptop sleeps or loses power. Do not reset checkpoints because a local session ended. Confirm the cloud heartbeat and advancing completed-job counts first. New-wallet discovery is a repeated, bounded directory sweep; less-active wallet cashflow/trade heads normally refresh every six hours, so current TVL can lead individual histories. Opening an affected wallet uses the existing temporary-priority mechanism to advance eligible jobs without deleting records or bypassing retry deadlines. `backfillComplete` in the indexing aggregate counts completed history jobs, not wallets.

## Assets and rolling 24-hour rankings

`GET /api/assets` serves saved BTC/ETH entry-notional open interest, notional long/short shares, at most 300 retained chart samples per asset, and observed activity for the last 24 hours. One collector request to `/state/house/current` every five seconds serves all viewers through the shared request budget. The source reports approximate USD entry notionals; its publication has a timestamp but no verified indexed block. The parser strips the optional bundled history series and uses the current head. OI samples are retained by minute, and a source-time regression cannot replace a newer saved publication. Samples describe what we observed and remain retained across source generation changes; they are not a reconstructed authoritative history for the latest source generation. This view does not open another price feed or fetch upstream history for each viewer.

The `asset-activity` loop resumes up to 500 retained observations per tick and refreshes asset aggregates every ten seconds. Live observations, idempotent analytics membership, minute buckets and SSE events commit together. Cross-source matching uses economic fingerprints and the greater occurrence count from either source; identical executions within one source retain their multiplicity. This remains provisional without canonical execution IDs. The durable v2 projection cursor advances with each projected record, allowing restarts and upgrades to resume without rescanning all history. The completed flag describes the local projection backfill only.

`GET /api/leaderboard?metric=pnl|volume|trades&page=0` returns 25 rows. PnL uses the source's `window=24h` and `totalWindowedPnl`; its other money fields do not have verified rolling-window semantics. Volume and trade-count modes query retained per-wallet minute aggregates plus exact boundary observations, cached for 20 seconds across replicas. Identical sort/page/prefix requests share a cache entry; distinct queries still aggregate the rolling window and need load testing before claiming capacity at millions of active wallet buckets. Their coverage remains partial. Observed counts include opens, closes and liquidations, not just completed positions. The optional `q` accepts an address prefix for observed rankings and names/addresses for source PnL. Invalid observed-name filters return 400. Leaderboard pagination can move as rankings change.

Both endpoints support gzip and ETag revalidation. Visible tabs poll every five seconds; hidden tabs pause. Saved snapshots remain readable during outages. Asset freshness combines market publication age, activity snapshot age, collector heartbeat, stream connection and recent/stream/projection errors; observed rankings use the same feed-health checks. A fresh heartbeat from another loop cannot make failed trade transports appear live. A protocol PnL request has its own source-cache freshness.

The analytics migration is additive (seven tables, no sequences). Deploy compatible worker/API code before the new frontend; with restricted runtime roles, migrate and apply the explicit grants above first. Existing raw observations and wallet history remain retained. This release adds no Render resources or plan changes. Independent accounting and load-capacity claims still require the launch checks below.

## Position holding time and leverage

`GET /api/position-metrics` and `GET /api/wallets/:address/position-metrics` serve saved sums and counts over retained closed/liquidated positions. Both means use the same valid, unambiguous cohort and weight each position equally; the global mean divides total sums by total positions, never by the number of wallets. Empty means are `null`. The UI labels global coverage as partial indexed history and reports sample/excluded counts. These are all-retained-history metrics, separate from the rolling 24-hour leaderboard. Current open-position rows come from the wallet snapshot and stay separate from closed metrics. See [definitions and verified source fields](POSITION_METRICS.md).

Four additive tables retain a pending-record queue, per-record contributions, wallet/global rollups and a durable legacy cursor. Each trade-history commit marks changed retained records in the same fenced transaction as its checkpoint. The collector processes at most 500 legacy keys and 500 queued records every five seconds, retaining progress across restarts. Each projected correction subtracts the prior contribution before adding its replacement. Aggregate sums are stored as exact decimal integers; only displayed means use floating-point numbers. API reads use keyed rollups and bounded queue/status checks, with no history scan or additional upstream requests. Existing available history is projected once; no source backfill is reset.

Deploy the additive migration with the API, then the compatible collector, then the frontend. Restricted runtime roles require the grants above before deployment. Confirm both metric endpoints, advancing or completed projection status, empty `null` means when appropriate, and ordinary history indexing. Rollback to an older collector stops marking corrections for this projection; reconcile its missed record keys before treating rollups as current again. No Render resource or plan changes are needed.

## Freshness, incidents and recovery

Distinguish process health, database availability, collector heartbeat, stream connectivity and source age. Empty trades and stale upstream data are different states. A successful HTTP response must not turn an old snapshot into “live.” Watch collector errors and response status alongside the last stored timestamp. The public-source beta cannot recover every missed execution from the short recent-trades window; after a prolonged source outage, preserve the gap in coverage.

The internal `stream-diagnostics` snapshot retains the latest lifecycle event and sanitized reason/code with client/subscription states. `npm run ingest:status` exposes it in the worker shell; it is not a public endpoint. Terminal disconnects and unsubscribes must be visible even when HTTP polling remains healthy. The Centrifuge client already retries ordinary temporary transport failures. Do not install a blanket reconnect loop that overrides explicit authentication, protocol, connection-limit or forced-disconnect refusals; diagnose the recorded reason before further recovery attempts.

For an upstream failure, keep cached content readable with its timestamp, inspect throttling/network errors, and reduce request pressure when necessary. Never reset source timestamps or substitute demo data. For a Redis failure, verify database-backed reads and stream resynchronization, then restore Redis; Redis is not the source of durable history. For a Postgres failure, inspect Render's HA event, allow clients to reconnect, and verify the worker reacquires its collector lock. HA asynchronously replicates and can lose the most recent writes during failover. It does not create complete upstream replay where none exists. [Render HA limitations](https://render.com/docs/postgresql-high-availability).

Before launch, prove the following with the deployed topology: collector restart, overlapping worker deploy, API instance restart while a browser is streaming, replay after a browser reconnect, slow-client disconnection, Redis interruption, database failover and backup restoration. A configured topology is not evidence these production paths have passed. Keep the source-backed coverage status visible throughout recovery.

Paid Postgres on Pro provides seven days of point-in-time recovery. Restore to a **new** database, verify stored observations, wallet records, raw pages/batches and indexing checkpoints, then switch both API and worker connections together. Stop the old worker before activating the new database's worker so only one database accepts new observations. Allow restored job leases to expire before expecting those jobs to resume. Preserve the old database until validation is complete; deletion also removes its associated recovery material. Do not use production as a restore target. [Render backups](https://render.com/docs/postgresql-backups).

PITR and the HA standby are not independent long-term backups. Before public launch, configure encrypted logical exports in an external bucket with restricted credentials and retention, then test a restore. Record the last successful backup time and tested recovery time. No external backup scheduler or object store is created by this Blueprint. Do not export credentials or user-supplied identifying data into public buckets.

## Capacity and operating gates

Database storage autoscaling is disabled for predictable billing. Alert at **70% and 85% disk utilization**, compute days remaining from recent growth, and expand before a backfill or projected week of ingestion exhausts space. Never silently delete wallet history to meet a limit. Render can suspend a full database. Storage increases are permanent and HA adds storage to both copies. [Render storage](https://render.com/docs/postgresql-creating-connecting#adding-storage).

Track API p95 latency, slow queries, pool waits, CPU/RAM, live connections, slow consumers, collector heartbeat/source age, history queue age and failures, upstream 429/5xx responses, stream reconnects, observation ingestion rate, database growth and egress per active viewer. Raw page/batch variants also consume storage; measure their growth during backfill. Alert on projected monthly spend at $350 and $450 against the current $500 ceiling. These thresholds are operating requirements; external alert delivery is not wired up by the app or Blueprint.

Before claiming launch capacity, test at least 500 browser streams, 10 million realistic observation rows and the greater of 100 representative incoming events/second or 10 times measured peak. Include history/backfill traffic while live traffic continues. Profile before increasing plans. The frontend targets a responsive shell and efficient batched updates; publish measured browser/device/network results rather than presenting these targets as achieved guarantees.

Future canonical ingestion needs verified deployment blocks, ABI/upgrade boundaries, uniquely keyed chain events, idempotent projections and gap reconciliation. A managed archive RPC is the next data capability to add when those inputs are ready. It is not necessary to purchase one merely to run this beta.

## Rollback

Keep each production commit and its environment changes recorded. Roll back API/worker/frontend code to a known compatible commit; the UI build embeds the API URL, so a frontend rollback also restores its old URL configuration. Use additive schema changes and keep at least one release of compatibility. A code rollback does not reverse a database migration, restore overwritten snapshots, or recreate missed upstream history. If data was corrupted, restore a separate database and reconcile coverage before switching traffic.

Do not attach persistent disks to the API or worker as a shortcut: replicas cannot share them and Render disk-backed services cannot scale horizontally. The database remains the durable shared store. [Persistent disk constraints](https://render.com/docs/disks).
