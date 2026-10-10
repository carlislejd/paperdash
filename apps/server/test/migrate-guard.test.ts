import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  createStore: vi.fn(),
  close: vi.fn(),
}));
vi.mock("../src/store.js", () => ({ createStore: database.createStore }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  database.close.mockResolvedValue(undefined);
  database.createStore.mockResolvedValue({
    kind: "postgres",
    close: database.close,
  });
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.stubEnv("NODE_ENV", "production");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("production migration target guard", () => {
  it.each([
    undefined,
    "",
    "not-a-url",
    "sqlite:///tmp/schema.db",
    "https://user:secret@example.test/database",
  ])(
    "rejects missing or non-PostgreSQL targets before opening any store (%s)",
    async (url) => {
      vi.stubEnv("DATABASE_URL", url);
      await expect(import("../src/migrate.js")).rejects.toThrow(
        "Production migrations require a PostgreSQL DATABASE_URL; no migration was run.",
      );
      expect(database.createStore).not.toHaveBeenCalled();
      expect(console.info).not.toHaveBeenCalled();
    },
  );

  it.each(["postgres:", "postgresql:"])(
    "runs the explicit owner migration and closes the store for %s URLs",
    async (protocol) => {
      vi.stubEnv(
        "DATABASE_URL",
        `${protocol}//owner:secret@db.example.test/paperdash`,
      );
      await import("../src/migrate.js");
      expect(database.createStore).toHaveBeenCalledExactlyOnceWith({
        autoMigrate: true,
      });
      expect(database.close).toHaveBeenCalledOnce();
      expect(console.info).toHaveBeenCalledExactlyOnceWith(
        "Paperdash postgres schema ready.",
      );
    },
  );

  it("preserves an intentional SQLite development migration without DATABASE_URL", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", undefined);
    database.createStore.mockResolvedValueOnce({
      kind: "local",
      close: database.close,
    });
    await import("../src/migrate.js");
    expect(database.createStore).toHaveBeenCalledExactlyOnceWith({
      autoMigrate: true,
    });
    expect(database.close).toHaveBeenCalledOnce();
    expect(console.info).toHaveBeenCalledExactlyOnceWith(
      "Paperdash local schema ready.",
    );
  });

  it("does not report success when the PostgreSQL migration fails", async () => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgres://owner:secret@db.example.test/paperdash",
    );
    database.createStore.mockRejectedValueOnce(
      new Error("permission denied for schema public"),
    );
    await expect(import("../src/migrate.js")).rejects.toThrow(
      "permission denied",
    );
    expect(console.info).not.toHaveBeenCalled();
  });
});
