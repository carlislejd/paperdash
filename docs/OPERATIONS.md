# Running Paperdash

Paperdash is a public-source analytics beta. It reads the official Papertrade HTTP endpoints and public trade stream. It does not submit orders, connect a user's signing wallet, run a blockchain node, or currently decode canonical HyperEVM contract events.

Observed trades are retained in our database; protocol totals, account details and wallet histories are upstream snapshots with source timestamps and coverage limits. A connected stream is not proof of complete execution history. The upstream recent-trades feed is bounded, and its public stream does not provide canonical transaction identities. Do not describe this deployment as an independently reconciled ledger or a complete lifetime trade archive. The earlier [research plan](../research/DASHBOARD_PLAN.md) describes later canonical ingestion work; this document describes the implemented beta.

## Local development

Use Node 24 and the committed npm lockfile:

```sh
cp .env.example .env
npm ci
npm run dev
```

Vite serves the frontend at `http://127.0.0.1:5173` and proxies `/api` to the API on port 8787. With `DATABASE_URL` absent, the API runs its collector and a durable SQLite store. The example environment uses `.data/paperdash.sqlite`. Keep the database, `-wal` and `-shm` files together while running; stop the process before making a simple filesystem copy. Local collection fails visibly at `LOCAL_MAX_BYTES` rather than silently removing financial observations. Do not use local SQLite for multiple Render instances: their filesystems are ephemeral and not shared.

For local Postgres, set `DATABASE_URL`, run `npm run db:migrate`, then run `npm run dev` and `npm run dev:ingest` in separate terminals. The API defaults to no embedded collector when Postgres is configured. Redis is optional locally. Do not enable an embedded collector while intentionally running another collector against the same local store.

Production builds use `npm run build`; API and worker commands are `npm run start:api` and `npm run start:ingest`. `npm run db:migrate` is idempotent and serializes database migrations. Secrets belong in environment variables or the hosting dashboard. All `VITE_*` variables are public browser build inputs.

## Render deployment

The authoritative deployment file is [render.yaml](../render.yaml); [infra/render.blueprint.yaml](../infra/render.blueprint.yaml) is an identical convenience copy. CI verifies both against the saved official Render schema. Use a Pro workspace for database HA. All stateful/backend resources must stay in the same region; Oregon is a starting assumption to verify before creation. Creating these files does not provision anything.

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

The $35 egress example assumes 100 average concurrent viewers receiving 1 decimal KB/second for 30 days: 259.2 GB, less Pro's 25 GB included, at $0.15/GB. Page loads, downloads and external backup uploads add traffic. This is a workload estimate, not a measured rate or a price cap. At 1,000 average concurrent viewers that same stream costs roughly $385 in overages alone. [Bandwidth billing](https://render.com/docs/outbound-bandwidth).

Deploy steps:

1. Run the build, tests, and `render blueprints validate render.yaml`. Schema validation does not verify available account plans, repository access, runtime behavior or load capacity.
2. Connect the repository and review the Blueprint cost in the selected Pro workspace. The definition keeps automatic deployment and preview environments off. Do not turn on automatic deployments until CI passes on the production branch.
3. Deploy the Blueprint. Database connections and Redis URLs are internal references; their public IP allowlists are empty. The API runs the migration as a pre-deploy command. Initial API/worker startup also runs the idempotent migration so first-deploy ordering does not leave the worker behind.
4. Confirm `/health/ready`, the first stored protocol snapshot, collector status, wallet lookup and a browser stream connection. No upstream trade activity is a valid empty state, not an excuse to insert fixtures into production.
5. If custom domains are used, update the API's `CORS_ORIGIN` to the exact frontend origin, set the static site's `VITE_API_URL` to the public API origin, and rebuild the static site. Multiple allowed origins are comma separated. Blueprint URL references initially use Render's `onrender.com` URLs. Keep these changes in the Blueprint so a future sync does not replace them.
6. Complete the role hardening and recovery checks below before a broad public launch. Confirm the upstream operator's allowance for sustained polling of these undocumented public endpoints.

The API binds `HOST=0.0.0.0` and Render's provided `PORT`. `EMBEDDED_COLLECTOR=false` keeps upstream polling in the dedicated worker. The collector's database advisory lock prevents parallel active collectors during overlapping deploys. It needs a direct Postgres connection; do not move that session onto a transaction pool.

## Environment contract

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection; omitted only for local SQLite |
| `REDIS_URL` | Optional cache/fan-out connection; enabled in Render |
| `AUTO_MIGRATE` | `true` for initial owner bootstrap; `false` after runtime roles are restricted |
| `HOST`, `PORT` | API bind address and port; local port 8787 |
| `CORS_ORIGIN` | Exact, comma-separated allowed frontend origins |
| `VITE_API_URL` | Public API origin compiled into frontend; empty uses same-origin requests |
| `EMBEDDED_COLLECTOR` | Override local API collector; `false` for production API |
| `UPSTREAM_ORIGIN` | Official HTTP source, default `https://exchange.papertrade.xyz` |
| `STREAM_URL` | Official Centrifuge source, default `wss://stream.papertrade.xyz/connection/websocket` |
| `SUMMARY_INTERVAL_MS` | Summary cadence; default 2000 |
| `RECENT_INTERVAL_MS` | Recent-trade fallback cadence; default 10000 |
| `DIRECTORY_INTERVAL_MS` | Account directory cadence; default 30000 |
| `HISTORY_INTERVAL_MS` | Protocol history cadence; default 60000 |
| `DATA_DIR` | Local SQLite directory; use `.data` |
| `LOCAL_MAX_BYTES` | Local collection limit; default 536870912 bytes |

Polling values are configuration, not permission to exceed upstream rate limits. Increase intervals when upstream requests throttle or operator guidance requires it; verify that any app freshness thresholds remain appropriate. Chain RPC URLs, contract manifests and archive credentials are deliberately absent from the runtime configuration because the current collector does not implement those adapters.

## Runtime database roles

The initial Blueprint injects the managed database owner's connection into both services. This makes schema bootstrap runnable, but grants more permission than a public API should retain. **It is not a least-privilege production setup.** The API writes on-demand wallet snapshots, so a strictly read-only role would break its cache.

Before broad launch, create separate API and ingestion login roles from an owner session on the private network. The following `psql` commands match the current four-table schema; the `\password` commands prompt without putting passwords in shell history:

```sql
CREATE ROLE paperdash_api LOGIN;
CREATE ROLE paperdash_ingest LOGIN;
\password paperdash_api
\password paperdash_ingest
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO paperdash_api, paperdash_ingest;
GRANT SELECT ON paperdash_snapshots, paperdash_trade_observations,
  paperdash_samples, paperdash_stream_events TO paperdash_api, paperdash_ingest;
GRANT INSERT, UPDATE ON paperdash_snapshots TO paperdash_api;
GRANT INSERT, UPDATE ON paperdash_snapshots, paperdash_samples TO paperdash_ingest;
GRANT INSERT ON paperdash_trade_observations, paperdash_stream_events TO paperdash_ingest;
GRANT DELETE ON paperdash_stream_events TO paperdash_ingest;
GRANT USAGE, SELECT ON SEQUENCE paperdash_stream_events_id_seq TO paperdash_ingest;
```

Neither runtime role needs `CREATE`, `ALTER`, `DROP`, ownership or access to unrelated schemas. New tables/sequences require explicit reviewed grants. Store the two role URLs separately in Render, replace the two `fromDatabase` entries with `sync: false`, and set `AUTO_MIGRATE=false` in both services. Keep the database's internal host/database name; only the URL-encoded username/password change.

Move migrations to a one-off deployment step that receives the owner connection separately; remove the API's `preDeployCommand` once its runtime URL is restricted. Run the migration before rolling out compatible API/worker code, then deploy with runtime roles and smoke-test wallet reads and cache writes. Never keep a schema-owner secret in an API runtime merely to run migrations. PostgreSQL `LISTEN` or session advisory locks require direct connections; API query pools may later use managed PgBouncer independently. [Connection pooling](https://render.com/docs/postgresql-connection-pooling).

## Freshness, incidents and recovery

Distinguish process health, database availability, collector heartbeat, stream connectivity and source age. Empty trades and stale upstream data are different states. A successful HTTP response must not turn an old snapshot into “live.” Watch collector errors and response status alongside the last stored timestamp. The public-source beta cannot recover every missed execution from the short recent-trades window; after a prolonged source outage, preserve the gap in coverage.

For an upstream failure, keep cached content readable with its timestamp, inspect throttling/network errors, and reduce request pressure when necessary. Never reset source timestamps or substitute demo data. For a Redis failure, verify database-backed reads and stream resynchronization, then restore Redis; Redis is not the source of durable history. For a Postgres failure, inspect Render's HA event, allow clients to reconnect, and verify the worker reacquires its collector lock. HA asynchronously replicates and can lose the most recent writes during failover. It does not create complete upstream replay where none exists. [Render HA limitations](https://render.com/docs/postgresql-high-availability).

Before launch, prove the following with the deployed topology: collector restart, overlapping worker deploy, API instance restart while a browser is streaming, replay after a browser reconnect, slow-client disconnection, Redis interruption, database failover and backup restoration. A configured topology is not evidence these production paths have passed. Keep the source-backed coverage status visible throughout recovery.

Paid Postgres on Pro provides seven days of point-in-time recovery. Restore to a **new** database, verify stored snapshots/trade observations and migrations, then switch both API and worker connections together. Stop the old worker before activating the new database's worker so only one database accepts new observations. Preserve the old database until validation is complete; deletion also removes its associated recovery material. Do not use production as a restore target. [Render backups](https://render.com/docs/postgresql-backups).

PITR and the HA standby are not independent long-term backups. Before public launch, configure encrypted logical exports in an external bucket with restricted credentials and retention, then test a restore. Record the last successful backup time and tested recovery time. No external backup scheduler or object store is created by this Blueprint. Do not export credentials or user-supplied identifying data into public buckets.

## Capacity and operating gates

Database storage autoscaling is disabled for predictable billing. Alert at **70% and 85% disk utilization**, compute days remaining from recent growth, and expand before a backfill or projected week of ingestion exhausts space. Never silently delete wallet history to meet a limit. Render can suspend a full database. Storage increases are permanent and HA adds storage to both copies. [Render storage](https://render.com/docs/postgresql-creating-connecting#adding-storage).

Track API p95 latency, slow queries, pool waits, CPU/RAM, live connections, slow consumers, collector heartbeat/source age, upstream 429/5xx responses, stream reconnects, observation ingestion rate, database growth and egress per active viewer. Alert on projected monthly spend at $350 and $450 against the current $500 ceiling. These thresholds are operating requirements; external alert delivery is not wired up by the app or Blueprint.

Before claiming launch capacity, test at least 500 browser streams, 10 million realistic observation rows and the greater of 100 representative incoming events/second or 10 times measured peak. Include history/backfill traffic while live traffic continues. Profile before increasing plans. The frontend targets a responsive shell and efficient batched updates; publish measured browser/device/network results rather than presenting these targets as achieved guarantees.

Future canonical ingestion needs verified deployment blocks, ABI/upgrade boundaries, uniquely keyed chain events, idempotent projections and gap reconciliation. A managed archive RPC is the next data capability to add when those inputs are ready. It is not necessary to purchase one merely to run this beta.

## Rollback

Keep each production commit and its environment changes recorded. Roll back API/worker/frontend code to a known compatible commit; the UI build embeds the API URL, so a frontend rollback also restores its old URL configuration. Use additive schema changes and keep at least one release of compatibility. A code rollback does not reverse a database migration, restore overwritten snapshots, or recreate missed upstream history. If data was corrupted, restore a separate database and reconcile coverage before switching traffic.

Do not attach persistent disks to the API or worker as a shortcut: replicas cannot share them and Render disk-backed services cannot scale horizontally. The database remains the durable shared store. [Persistent disk constraints](https://render.com/docs/disks).
