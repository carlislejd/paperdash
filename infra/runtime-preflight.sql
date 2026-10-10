-- Private migration job: verify intent before any schema change.
-- This file creates no roles, credentials, tables or grants.
BEGIN;
SELECT set_config('paperdash.expected_database', :'expected_database', true),
       set_config('paperdash.expected_owner', :'expected_owner', true),
       set_config('paperdash.handoff_schema', :'app_schema', true),
       set_config('paperdash.handoff_api_role', :'api_role', true),
       set_config('paperdash.handoff_ingest_role', :'ingest_role', true);
DO $preflight$
DECLARE
  schema_name text := current_setting('paperdash.handoff_schema');
  api_name text := current_setting('paperdash.handoff_api_role');
  ingest_name text := current_setting('paperdash.handoff_ingest_role');
BEGIN
  IF current_database() <> current_setting('paperdash.expected_database')
      OR current_user <> current_setting('paperdash.expected_owner')
      OR session_user <> current_user THEN
    RAISE EXCEPTION 'Migration database or authenticated owner does not match the explicit target';
  END IF;
  IF current_schema() IS DISTINCT FROM schema_name OR to_regnamespace(schema_name) IS NULL THEN
    RAISE EXCEPTION 'Migration schema does not match the active search path';
  END IF;
  IF api_name = ingest_name OR to_regrole(api_name) IS NULL OR to_regrole(ingest_name) IS NULL THEN
    RAISE EXCEPTION 'Distinct runtime roles must already exist before migration';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN (api_name, ingest_name)
      AND (NOT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
      OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member IN (to_regrole(api_name), to_regrole(ingest_name))) THEN
    RAISE EXCEPTION 'Runtime logins must have no elevated attributes or memberships';
  END IF;
  IF has_schema_privilege(api_name, schema_name, 'CREATE')
      OR has_schema_privilege(ingest_name, schema_name, 'CREATE') THEN
    RAISE EXCEPTION 'Runtime roles must not have schema CREATE';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class
      WHERE relnamespace=to_regnamespace(schema_name)
        AND left(relname,10)='paperdash_'
        AND relowner <> to_regrole(current_user)) THEN
    RAISE EXCEPTION 'Application objects must belong to the expected migration owner';
  END IF;
END
$preflight$;
COMMIT;
