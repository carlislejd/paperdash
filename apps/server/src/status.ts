import { createStore } from "./store.js";
import { addressSchema } from "./schemas.js";

const store = await createStore({ autoMigrate: false });
try {
  const address = process.argv[2] ? addressSchema.parse(process.argv[2]) : null;
  const [heartbeat, stream, stats, jobs] = await Promise.all([
    store.get<{ at: number; errors: Record<string, string> }>(
      "collector-heartbeat",
    ),
    store.get("stream-diagnostics"),
    store.history.stats(),
    address ? store.history.getStatus(address) : null,
  ]);
  const healthy = Boolean(heartbeat && Date.now() - heartbeat.value.at < 30000);
  console.log(
    JSON.stringify(
      {
        persistence: store.kind,
        collectorHealthy: healthy,
        heartbeat: heartbeat?.value ?? null,
        stream: stream?.value ?? null,
        stats,
        ...(address ? { address, jobs } : {}),
      },
      null,
      2,
    ),
  );
  if (!healthy) process.exitCode = 1;
} finally {
  await store.close();
}
