# Runtime database role handoff

Status: preparation only, October 10, 2026. The grant policy and production migration guard have passed local PostgreSQL tests. No production roles, credentials, grants or migration services have been created. Schedule this separately from the feature rollout.

## What exists

A bounded read-only query of production `pg_roles`, memberships and table ownership found that `paperdash_db_user` owns all 24 application tables in deployed `fb243da`, has `CREATEROLE` and `CREATEDB`, and has no role memberships. There are no `paperdash_api` or `paperdash_ingest` logins. Other logins belong to Render's database administration/monitoring machinery; do not repurpose them. No passwords or password hashes were read.

There is **no verified existing credential that provides the desired runtime separation**. Reusing the owner login with `SET ROLE` leaves the original authenticated identity able to regain its privileges. Revoking ordinary table grants does not remove an owner's inherent control. Render's **New default credential** is a credential-rotation workflow; it also changes which user future Blueprint connection-string syncs select. It is not a substitute for reviewed application roles. [PostgreSQL role switching](https://www.postgresql.org/docs/18/sql-set-role.html), [ownership privileges](https://www.postgresql.org/docs/18/ddl-priv.html), [Render credential management](https://render.com/docs/postgresql-credentials).

## Prepare before changing runtime connections

1. Keep the completed production export and record a fresh baseline: readiness, stream health, retained record counts and indexing checkpoints. Test this change on an isolated copy first.
2. Use [the executable grant policy](../infra/runtime-grants.sql), retaining one-time login creation as a separate step. Its current 30-table policy is transactional and fails on absent/elevated roles, owner memberships, runtime-owned objects or inherited schema CREATE. It changes only the two roles' explicit application grants, and never creates credentials or revokes shared PUBLIC rights. Reconcile it against each exact release.
3. Re-run the passing [PostgreSQL role integration test](../apps/server/test/runtime-roles-postgres.test.ts) at the intended release. It applies the actual policy file and exercises API reads/cache writes/wallet prioritization and collector checkpoint/projection/retention paths. Both runtime roles are denied application DDL; API raw writes and sequence access are denied; immutable raw pages/batches cannot be updated or deleted. Repeated policy application removes an overbroad column grant, and inherited PUBLIC schema CREATE is rejected without altering PUBLIC rights. Isolated Render login authentication and rolling lease handoff still need verification before production cutover.
4. Prepare a dedicated private migration service in Oregon. A Render cron service supports **Trigger Run** and costs at least $1/month plus active compute. Use Node 24, `npm ci --include=dev && npm run build:api`, auto-deploy off, `NODE_ENV=production`, and an exact tested commit containing the migration guard released in `00e2bc6`. Its nine passing tests verify that production `db:migrate` rejects missing, malformed or non-PostgreSQL `DATABASE_URL` values before opening a store. Its command must migrate, apply reviewed grants and exit nonzero on failure; separately preflight the intended database/schema. Only this service receives the existing owner connection; it does not run an API or collector. A sparse valid schedule may repeat only the pinned, idempotent operation. Do not trigger while another run is active: Render cancels that run. [Cron behavior and billing](https://render.com/docs/cronjobs).

An API-based one-off job is unsuitable for separating secrets: Render copies all environment variables from its base service. A migration job must use the dedicated migration service as its base. Future CI needs a separately reviewed Render authentication setup and must wait for successful migration completion before rolling services. [One-off job environment](https://render.com/docs/one-off-jobs).

After the PostgreSQL-only migration guard is released, the dedicated owner's job runs these commands with fail-fast shell behavior and a preflight that checks its intended database. `/usr/bin/psql` was present in the current Render Node runtime; verify it again in the chosen job image. Neither command creates the two login roles:

```sh
set -eu
: "${DATABASE_URL:?A private owner PostgreSQL connection is required}"
npm run db:migrate
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v app_schema=public -v api_role=paperdash_api -v ingest_role=paperdash_ingest \
  -f infra/runtime-grants.sql
```

The independent code review and a local PostgreSQL integration test validated this API permission minimum using disposable NOLOGIN roles and `SET ROLE`. Production login/authentication and deployment with these roles remain untested. Prefix every table name below with `paperdash_`:

| Permission | Tables |
| --- | --- |
| SELECT | `snapshots`, `stream_events`, `history_wallets`, `history_jobs`, `history_records`, `history_corrections`, `history_points`, `analytics_state`, `analytics_wallet_fingerprints`, `analytics_wallet_minutes`, `position_metrics_queue`, `position_metrics_rollups`, `position_metrics_state`, `market_prices`, `house_samples`, `liquidation_state`, `liquidation_events` |
| INSERT | `snapshots`, `history_wallets`, `history_jobs` |
| UPDATE | `snapshots`, `history_wallets`, `history_jobs`, `history_corrections` |

Some SELECT grants support startup schema checks rather than public routes. No API DELETE, sequence access, raw trade/page/batch/fact reads, or house/liquidation writes are needed. The passing test uses UPDATE narrowed to `snapshots(payload,received_at)`, `history_wallets(priority,active_until,last_seen)`, and `next_run` on jobs/corrections. [The executable local policy test](../apps/server/test/runtime-roles-postgres.test.ts) also exercises collector writes and negative DDL/raw-write checks, and specifies the reviewed worker grants. Preserve those tests when adding tables or SQL paths.

## Operator credential handoff and cutover

1. From a private owner session, provision the two reviewed login roles with no superuser, database-creation, role-creation, replication or RLS-bypass privileges. An operator enters unique role passwords through private interactive prompts and stores them in the approved secret manager. Do not put passwords in SQL files, chat, commands, logs or the repository.
2. Apply the reviewed grants with the owner identity. Complete the isolated permission tests before touching production service environment values.
3. Run the dedicated migration/grant service against production at the intended release; record its commit and successful run ID. Preserve current table ownership and records.
4. The operator enters each role's internal connection URL into its own Render service: [API environment](https://dashboard.render.com/web/srv-db4sq6g473hc739111lg/env) and [collector environment](https://dashboard.render.com/worker/srv-db4sq6g473hc739111jg/env). Keep the production host/database unchanged. Change both Blueprint `DATABASE_URL` definitions to `sync: false`, set `AUTO_MIGRATE=false`, and remove the API `preDeployCommand`. The owner URL must no longer exist in either runtime environment or shared environment group.
5. Roll API first, verify all three replicas and real profile/cache operations, then roll the collector and verify normal lease handoff, advancing ingestion and unchanged retained counts. Check effective roles and required grants without printing connection strings. Keep external database access blocked.

For each later release: deploy the tested migration build, run migration plus explicit new grants to successful completion, then roll compatible API, collector and frontend code. A permission failure is a release blocker, not a reason to restore owner access to a public runtime. Fix the narrow grant or roll back compatible code; never reset data or checkpoints. The migration service and new credentials remain unprovisioned until this handoff is scheduled.
