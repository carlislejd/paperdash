-- Apply only after the owner migration and creation of the two runtime roles.
-- No credentials or LOGIN roles are created here. Variables are psql-quoted.
-- psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -v app_schema=public \
--   -v api_role=paperdash_api -v ingest_role=paperdash_ingest \
--   -f infra/runtime-grants.sql
-- The DATABASE_URL in this command is the owner connection in its private job.
-- Existing direct grants on the listed app objects are replaced atomically;
-- PUBLIC privileges, other schemas, and future objects are not changed.
BEGIN;
SELECT set_config('paperdash.handoff_api_role', :'api_role', true),
       set_config('paperdash.handoff_ingest_role', :'ingest_role', true),
       set_config('paperdash.handoff_schema', :'app_schema', true);
DO $handoff$
DECLARE
  api_name text := current_setting('paperdash.handoff_api_role');
  ingest_name text := current_setting('paperdash.handoff_ingest_role');
  schema_name text := current_setting('paperdash.handoff_schema');
BEGIN
  IF to_regrole(api_name) IS NULL OR to_regrole(ingest_name) IS NULL THEN
    RAISE EXCEPTION 'Required runtime roles must already exist: % and %', api_name, ingest_name;
  END IF;
  IF api_name = ingest_name THEN
    RAISE EXCEPTION 'API and ingestion must use separate runtime roles';
  END IF;
  IF to_regnamespace(schema_name) IS NULL THEN
    RAISE EXCEPTION 'Application schema does not exist: %', schema_name;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN (api_name,ingest_name)
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member IN (to_regrole(api_name),to_regrole(ingest_name))) THEN
    RAISE EXCEPTION 'Runtime roles must have no elevated role attributes or role memberships';
  END IF;
  IF has_schema_privilege(api_name,schema_name,'CREATE')
    OR has_schema_privilege(ingest_name,schema_name,'CREATE') THEN
    RAISE EXCEPTION 'Runtime roles must not have schema CREATE, including through PUBLIC; review existing privileges before retrying';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relnamespace=to_regnamespace(schema_name)
      AND relowner IN (to_regrole(api_name),to_regrole(ingest_name))) THEN
    RAISE EXCEPTION 'Runtime roles must not own application-schema objects';
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I,%I', current_database(), api_name, ingest_name);
END
$handoff$;


REVOKE ALL PRIVILEGES ON TABLE
  :"app_schema".paperdash_snapshots,
  :"app_schema".paperdash_wallet_watches,
  :"app_schema".paperdash_trade_observations,
  :"app_schema".paperdash_trade_inbox,
  :"app_schema".paperdash_trade_inbox_totals,
  :"app_schema".paperdash_trade_ingestion_gaps,
  :"app_schema".paperdash_samples,
  :"app_schema".paperdash_stream_events,
  :"app_schema".paperdash_history_wallets,
  :"app_schema".paperdash_history_jobs,
  :"app_schema".paperdash_history_records,
  :"app_schema".paperdash_history_pages,
  :"app_schema".paperdash_history_visits,
  :"app_schema".paperdash_history_points,
  :"app_schema".paperdash_history_portfolio_batches,
  :"app_schema".paperdash_history_corrections,
  :"app_schema".paperdash_analytics_members,
  :"app_schema".paperdash_analytics_fingerprints,
  :"app_schema".paperdash_analytics_minutes,
  :"app_schema".paperdash_analytics_oi_samples,
  :"app_schema".paperdash_analytics_wallet_fingerprints,
  :"app_schema".paperdash_analytics_wallet_minutes,
  :"app_schema".paperdash_analytics_state,
  :"app_schema".paperdash_position_metrics_queue,
  :"app_schema".paperdash_position_metrics_facts,
  :"app_schema".paperdash_position_metrics_rollups,
  :"app_schema".paperdash_position_metrics_state,
  :"app_schema".paperdash_market_prices,
  :"app_schema".paperdash_house_samples,
  :"app_schema".paperdash_liquidation_members,
  :"app_schema".paperdash_liquidation_fingerprints,
  :"app_schema".paperdash_liquidation_minutes,
  :"app_schema".paperdash_liquidation_events,
  :"app_schema".paperdash_liquidation_state
  FROM :"api_role", :"ingest_role";

REVOKE ALL PRIVILEGES ON SEQUENCE
  :"app_schema".paperdash_stream_events_id_seq,
  :"app_schema".paperdash_trade_inbox_seq_seq
  FROM :"api_role", :"ingest_role";

-- Table-level REVOKE does not clear independently granted column privileges.
DO $columns$
DECLARE
  table_name text;
  columns_sql text;
  schema_name text := current_setting('paperdash.handoff_schema');
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'paperdash_snapshots',
    'paperdash_wallet_watches',
    'paperdash_trade_observations',
    'paperdash_trade_inbox',
    'paperdash_trade_inbox_totals',
    'paperdash_trade_ingestion_gaps',
    'paperdash_samples',
    'paperdash_stream_events',
    'paperdash_history_wallets',
    'paperdash_history_jobs',
    'paperdash_history_records',
    'paperdash_history_pages',
    'paperdash_history_visits',
    'paperdash_history_points',
    'paperdash_history_portfolio_batches',
    'paperdash_history_corrections',
    'paperdash_analytics_members',
    'paperdash_analytics_fingerprints',
    'paperdash_analytics_minutes',
    'paperdash_analytics_oi_samples',
    'paperdash_analytics_wallet_fingerprints',
    'paperdash_analytics_wallet_minutes',
    'paperdash_analytics_state',
    'paperdash_position_metrics_queue',
    'paperdash_position_metrics_facts',
    'paperdash_position_metrics_rollups',
    'paperdash_position_metrics_state',
    'paperdash_market_prices',
    'paperdash_house_samples',
    'paperdash_liquidation_members',
    'paperdash_liquidation_fingerprints',
    'paperdash_liquidation_minutes',
    'paperdash_liquidation_events',
    'paperdash_liquidation_state'
  ] LOOP
    SELECT string_agg(format('%I',attname),',' ORDER BY attnum) INTO columns_sql
      FROM pg_attribute
      WHERE attrelid=format('%I.%I',schema_name,table_name)::regclass
        AND attnum>0 AND NOT attisdropped;
    EXECUTE format(
      'REVOKE SELECT(%s),INSERT(%s),UPDATE(%s),REFERENCES(%s) ON TABLE %I.%I FROM %I,%I',
      columns_sql,columns_sql,columns_sql,columns_sql,schema_name,table_name,
      current_setting('paperdash.handoff_api_role'),current_setting('paperdash.handoff_ingest_role'));
  END LOOP;
END
$columns$;

GRANT USAGE ON SCHEMA :"app_schema" TO :"api_role", :"ingest_role";

-- API: retained reads, shared cache writes, and bounded scheduling priority.

GRANT SELECT ON TABLE
  :"app_schema".paperdash_snapshots,
  :"app_schema".paperdash_wallet_watches,
  :"app_schema".paperdash_trade_observations,
  :"app_schema".paperdash_stream_events,
  :"app_schema".paperdash_history_wallets,
  :"app_schema".paperdash_history_jobs,
  :"app_schema".paperdash_history_records,
  :"app_schema".paperdash_history_corrections,
  :"app_schema".paperdash_history_points,
  :"app_schema".paperdash_analytics_state,
  :"app_schema".paperdash_analytics_members,
  :"app_schema".paperdash_analytics_fingerprints,
  :"app_schema".paperdash_analytics_wallet_fingerprints,
  :"app_schema".paperdash_analytics_wallet_minutes,
  :"app_schema".paperdash_position_metrics_queue,
  :"app_schema".paperdash_position_metrics_rollups,
  :"app_schema".paperdash_position_metrics_state,
  :"app_schema".paperdash_market_prices,
  :"app_schema".paperdash_house_samples,
  :"app_schema".paperdash_liquidation_state,
  :"app_schema".paperdash_liquidation_events
  TO :"api_role";

GRANT INSERT ON TABLE
  :"app_schema".paperdash_snapshots,
  :"app_schema".paperdash_history_wallets,
  :"app_schema".paperdash_history_jobs
  TO :"api_role";

GRANT UPDATE(payload,received_at) ON TABLE
  :"app_schema".paperdash_snapshots
  TO :"api_role";

GRANT UPDATE(priority,active_until,last_seen) ON TABLE
  :"app_schema".paperdash_history_wallets
  TO :"api_role";

GRANT UPDATE(next_run) ON TABLE
  :"app_schema".paperdash_history_jobs,
  :"app_schema".paperdash_history_corrections
  TO :"api_role";

-- Viewers can request a bounded watch but cannot change collector scheduling.
GRANT INSERT(address,watch_until) ON TABLE
  :"app_schema".paperdash_wallet_watches
  TO :"api_role";

GRANT UPDATE(watch_until) ON TABLE
  :"app_schema".paperdash_wallet_watches
  TO :"api_role";

-- Worker: explicit current tables; never blanket grants on future objects.

GRANT SELECT ON TABLE
  :"app_schema".paperdash_snapshots,
  :"app_schema".paperdash_wallet_watches,
  :"app_schema".paperdash_trade_observations,
  :"app_schema".paperdash_trade_inbox,
  :"app_schema".paperdash_trade_inbox_totals,
  :"app_schema".paperdash_trade_ingestion_gaps,
  :"app_schema".paperdash_samples,
  :"app_schema".paperdash_stream_events,
  :"app_schema".paperdash_history_wallets,
  :"app_schema".paperdash_history_jobs,
  :"app_schema".paperdash_history_records,
  :"app_schema".paperdash_history_pages,
  :"app_schema".paperdash_history_visits,
  :"app_schema".paperdash_history_points,
  :"app_schema".paperdash_history_portfolio_batches,
  :"app_schema".paperdash_history_corrections,
  :"app_schema".paperdash_analytics_members,
  :"app_schema".paperdash_analytics_fingerprints,
  :"app_schema".paperdash_analytics_minutes,
  :"app_schema".paperdash_analytics_oi_samples,
  :"app_schema".paperdash_analytics_wallet_fingerprints,
  :"app_schema".paperdash_analytics_wallet_minutes,
  :"app_schema".paperdash_analytics_state,
  :"app_schema".paperdash_position_metrics_queue,
  :"app_schema".paperdash_position_metrics_facts,
  :"app_schema".paperdash_position_metrics_rollups,
  :"app_schema".paperdash_position_metrics_state,
  :"app_schema".paperdash_market_prices,
  :"app_schema".paperdash_house_samples,
  :"app_schema".paperdash_liquidation_members,
  :"app_schema".paperdash_liquidation_fingerprints,
  :"app_schema".paperdash_liquidation_minutes,
  :"app_schema".paperdash_liquidation_events,
  :"app_schema".paperdash_liquidation_state
  TO :"ingest_role";

GRANT INSERT,UPDATE ON TABLE
  :"app_schema".paperdash_snapshots,
  :"app_schema".paperdash_samples,
  :"app_schema".paperdash_history_wallets,
  :"app_schema".paperdash_history_jobs,
  :"app_schema".paperdash_history_records,
  :"app_schema".paperdash_history_points,
  :"app_schema".paperdash_history_corrections,
  :"app_schema".paperdash_analytics_fingerprints,
  :"app_schema".paperdash_analytics_minutes,
  :"app_schema".paperdash_analytics_oi_samples,
  :"app_schema".paperdash_analytics_wallet_fingerprints,
  :"app_schema".paperdash_analytics_wallet_minutes,
  :"app_schema".paperdash_position_metrics_queue,
  :"app_schema".paperdash_position_metrics_facts,
  :"app_schema".paperdash_position_metrics_rollups,
  :"app_schema".paperdash_market_prices,
  :"app_schema".paperdash_house_samples,
  :"app_schema".paperdash_liquidation_fingerprints,
  :"app_schema".paperdash_liquidation_minutes,
  :"app_schema".paperdash_liquidation_events
  TO :"ingest_role";

GRANT INSERT ON TABLE
  :"app_schema".paperdash_trade_observations,
  :"app_schema".paperdash_trade_inbox,
  :"app_schema".paperdash_trade_inbox_totals,
  :"app_schema".paperdash_trade_ingestion_gaps,
  :"app_schema".paperdash_stream_events,
  :"app_schema".paperdash_history_visits,
  :"app_schema".paperdash_history_pages,
  :"app_schema".paperdash_history_portfolio_batches,
  :"app_schema".paperdash_analytics_members,
  :"app_schema".paperdash_liquidation_members
  TO :"ingest_role";

GRANT UPDATE ON TABLE
  :"app_schema".paperdash_trade_inbox_totals,
  :"app_schema".paperdash_trade_ingestion_gaps,
  :"app_schema".paperdash_analytics_state,
  :"app_schema".paperdash_position_metrics_state,
  :"app_schema".paperdash_liquidation_state
  TO :"ingest_role";

GRANT UPDATE(next_run,failures) ON TABLE
  :"app_schema".paperdash_wallet_watches
  TO :"ingest_role";

GRANT DELETE ON TABLE
  :"app_schema".paperdash_wallet_watches,
  :"app_schema".paperdash_trade_inbox,
  :"app_schema".paperdash_stream_events,
  :"app_schema".paperdash_history_visits,
  :"app_schema".paperdash_history_corrections,
  :"app_schema".paperdash_history_points,
  :"app_schema".paperdash_position_metrics_queue,
  :"app_schema".paperdash_position_metrics_facts
  TO :"ingest_role";

GRANT USAGE ON SEQUENCE
  :"app_schema".paperdash_stream_events_id_seq,
  :"app_schema".paperdash_trade_inbox_seq_seq
  TO :"ingest_role";
COMMIT;
