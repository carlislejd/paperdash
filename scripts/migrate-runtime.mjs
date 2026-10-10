#!/usr/bin/env node
// Private owner job only. No credentials are created or printed here.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
const cwd = fileURLToPath(new URL("..", import.meta.url));
const host = process.env.MIGRATION_HOST;
const database = process.env.MIGRATION_DATABASE;
const owner = process.env.MIGRATION_OWNER;
const schema = process.env.MIGRATION_SCHEMA;
let connection;
let password;
let connectionOptions;
try {
  connection = new URL(process.env.DATABASE_URL ?? "");
  password = decodeURIComponent(connection.password);
  connectionOptions = connection.searchParams.get("options") ?? "";
} catch {}
if (
  process.env.NODE_ENV !== "production" ||
  !["postgres:", "postgresql:"].includes(connection?.protocol) ||
  password === undefined ||
  [...(connection?.searchParams.keys() ?? [])].some(
    (key) => !["sslmode", "options"].includes(key),
  ) ||
  connection?.searchParams.getAll("options").length > 1 ||
  connection?.searchParams.getAll("sslmode").length > 1 ||
  !host ||
  connection?.hostname !== host ||
  !database ||
  !owner ||
  !schema
) {
  console.error(
    "Migration refused: production PostgreSQL and matching MIGRATION_HOST and explicit MIGRATION_DATABASE, MIGRATION_OWNER and MIGRATION_SCHEMA are required.",
  );
  process.exit(1);
}
const migrationConnection = new URL(connection);
migrationConnection.searchParams.delete("options");
// Keep the password in the child environment, never in its process arguments.
connection.password = "";
// URLSearchParams uses '+' for spaces. libpq treats that '+' literally in URI
// options, unlike node-postgres. Pass decoded options through the environment
// so both clients use the same source search path; required bounds come last.
connection.searchParams.delete("options");
const env = {
  ...process.env,
  DATABASE_URL: migrationConnection.toString(),
  PGPASSWORD: password,
  PGCONNECT_TIMEOUT: "10",
  PGOPTIONS:
    `${connectionOptions} -c statement_timeout=10000 -c lock_timeout=10000`.trim(),
};
const psql = [
  "-X",
  "--no-password",
  "--dbname",
  connection.toString(),
  "-v",
  "ON_ERROR_STOP=1",
  "-v",
  `expected_database=${database}`,
  "-v",
  `expected_owner=${owner}`,
  "-v",
  `app_schema=${schema}`,
  "-v",
  "api_role=paperdash_api",
  "-v",
  "ingest_role=paperdash_ingest",
];
for (const [label, command, args, timeout] of [
  [
    "target preflight",
    "psql",
    [...psql, "-f", "infra/runtime-preflight.sql"],
    30000,
  ],
  [
    "schema migration",
    process.execPath,
    ["--import", "tsx", "apps/server/src/migrate.ts"],
    120000,
  ],
  [
    "runtime grants",
    "psql",
    [...psql, "-f", "infra/runtime-grants.sql"],
    30000,
  ],
]) {
  try {
    await exec(command, args, {
      cwd,
      env,
      timeout,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    console.info(`Paperdash ${label} passed.`);
  } catch {
    // execFile errors contain the command/output; never serialize those from a
    // credential-bearing job. A failed or timed-out stage prevents the next one.
    console.error(
      `Paperdash ${label} failed or timed out; no later stage was run. Review the private job configuration and database before retrying.`,
    );
    process.exitCode = 1;
    break;
  }
}
