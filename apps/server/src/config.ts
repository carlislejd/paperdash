import "dotenv/config";

function integer(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${name}`);
  return value;
}
export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: integer("PORT", 8787, 1, 65535),
  databaseUrl: process.env.DATABASE_URL,
  autoMigrate: process.env.AUTO_MIGRATE !== "false",
  redisUrl: process.env.REDIS_URL,
  origins: (
    process.env.CORS_ORIGIN ?? "http://127.0.0.1:5173,http://localhost:5173"
  )
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean),
  embedded:
    process.env.EMBEDDED_COLLECTOR === "true" ||
    (!process.env.DATABASE_URL && process.env.EMBEDDED_COLLECTOR !== "false"),
  dataDir: process.env.DATA_DIR ?? "./.data",
  localMaxBytes: integer(
    "LOCAL_MAX_BYTES",
    536870912,
    1048576,
    Number.MAX_SAFE_INTEGER,
  ),
  upstream: process.env.UPSTREAM_ORIGIN ?? "https://exchange.papertrade.xyz",
  streamUrl:
    process.env.STREAM_URL ??
    "wss://stream.papertrade.xyz/connection/websocket",
  summaryInterval: integer("SUMMARY_INTERVAL_MS", 2000, 1000, 300000),
  recentInterval: integer("RECENT_INTERVAL_MS", 10000, 3000, 300000),
  directoryInterval: integer("DIRECTORY_INTERVAL_MS", 30000, 5000, 300000),
  historyInterval: integer("HISTORY_INTERVAL_MS", 60000, 10000, 3600000),
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected upstream failure";
}
