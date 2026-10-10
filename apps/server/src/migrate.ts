import { createStore } from "./store.js";

// A missing owner secret must never turn a production migration into a
// successful local SQLite bootstrap. Development keeps the SQLite workflow.
if (process.env.NODE_ENV === "production") {
  let protocol: string | undefined;
  try {
    protocol = new URL(process.env.DATABASE_URL ?? "").protocol;
  } catch {
    // Do not include a potentially credential-bearing URL in the error.
  }
  if (protocol !== "postgres:" && protocol !== "postgresql:")
    throw new Error(
      "Production migrations require a PostgreSQL DATABASE_URL; no migration was run.",
    );
}

const store = await createStore({ autoMigrate: true });
try {
  console.info(`Paperdash ${store.kind} schema ready.`);
} finally {
  await store.close();
}
