import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const databaseUrl = process.env.TEST_DATABASE_URL;
const root = fileURLToPath(new URL("../../../", import.meta.url));

describe.skipIf(!databaseUrl)("private migration job target guard", () => {
  it("rejects the wrong database before DDL, then migrates and grants only the intended schema", async () => {
    const admin = new Pool({ connectionString: databaseUrl });
    const schema = `migration_job_${randomUUID().replaceAll("-", "")}`;
    const createdRoles: string[] = [];
    let createdSchema = false;
    try {
      const identity = (
        await admin.query(
          "SELECT current_database() AS db, current_user AS owner",
        )
      ).rows[0];
      // These fixed names are required by the production wrapper. Refuse to
      // repurpose existing logins; this test owns only roles it creates.
      for (const role of ["paperdash_api", "paperdash_ingest"]) {
        expect(
          (await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role]))
            .rowCount,
        ).toBe(0);
        await admin.query(
          `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
        );
        createdRoles.push(role);
      }
      await admin.query(`CREATE SCHEMA ${schema}`);
      createdSchema = true;
      const url = new URL(databaseUrl!);
      url.searchParams.set("options", `-c search_path=${schema}`);
      // WHATWG form encoding uses '+', which libpq must not receive literally
      // as startup options. Both psql and node must retain this same schema.
      expect(url.search).toContain("options=-c+search_path");
      const env = {
        ...process.env,
        NODE_ENV: "production",
        DATABASE_URL: url.toString(),
        MIGRATION_HOST: url.hostname,
        MIGRATION_DATABASE: identity.db,
        MIGRATION_OWNER: identity.owner,
        MIGRATION_SCHEMA: schema,
        PGOPTIONS: "-c search_path=wrong_inherited_schema",
      };
      async function run(overrides: Record<string, string> = {}) {
        return exec(process.execPath, ["scripts/migrate-runtime.mjs"], {
          cwd: root,
          env: { ...env, ...overrides },
          timeout: 20000,
          maxBuffer: 65536,
        });
      }
      for (const overrides of [
        { MIGRATION_HOST: "wrong-host.invalid" },
        { MIGRATION_DATABASE: "wrong_database" },
        { MIGRATION_OWNER: "wrong_owner" },
        { MIGRATION_SCHEMA: "wrong_schema" },
      ]) {
        await expect(run(overrides)).rejects.toMatchObject({ code: 1 });
        expect(
          (
            await admin.query(
              "SELECT 1 FROM pg_class WHERE relnamespace=to_regnamespace($1)",
              [schema],
            )
          ).rowCount,
        ).toBe(0);
      }
      const ambiguous = new URL(url);
      ambiguous.searchParams.append("options", "-c search_path=public");
      await expect(
        run({ DATABASE_URL: ambiguous.toString() }),
      ).rejects.toMatchObject({ code: 1 });
      expect(
        (
          await admin.query(
            "SELECT 1 FROM pg_class WHERE relnamespace=to_regnamespace($1)",
            [schema],
          )
        ).rowCount,
      ).toBe(0);
      await admin.query(`GRANT CREATE ON SCHEMA ${schema} TO paperdash_api`);
      await expect(run()).rejects.toMatchObject({ code: 1 });
      expect(
        (
          await admin.query(
            "SELECT 1 FROM pg_class WHERE relnamespace=to_regnamespace($1)",
            [schema],
          )
        ).rowCount,
      ).toBe(0);
      await admin.query(`REVOKE CREATE ON SCHEMA ${schema} FROM paperdash_api`);
      const first = await run();
      expect(first.stdout).toContain("Paperdash runtime grants passed.");
      expect(first.stdout + first.stderr).not.toContain(url.toString());
      const again = await run();
      expect(again.stdout).toContain("Paperdash runtime grants passed.");
      const checks = (
        await admin.query(
          `SELECT
        has_table_privilege('paperdash_api', $1, 'SELECT') AS can_read,
        has_table_privilege('paperdash_api', $1, 'DELETE') AS cannot_delete,
        has_schema_privilege('paperdash_ingest', $2, 'CREATE') AS cannot_create`,
          [`${schema}.paperdash_snapshots`, schema],
        )
      ).rows[0];
      expect(checks).toEqual({
        can_read: true,
        cannot_delete: false,
        cannot_create: false,
      });
    } finally {
      if (createdSchema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      for (const role of createdRoles) {
        // Only newly-created disposable roles can reach this cleanup path.
        await admin.query(`DROP OWNED BY ${role}`);
        await admin.query(`DROP ROLE ${role}`);
      }
      await admin.end();
    }
  }, 30000);
});
