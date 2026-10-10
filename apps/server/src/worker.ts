import { createStore } from "./store.js";
import { Upstream } from "./upstream.js";
import { Collector } from "./collector.js";
import { ChangeBus } from "./bus.js";
import { config } from "./config.js";
import { waitForCollectorLease } from "./collector-lifecycle.js";

const store = await createStore();
const bus = new ChangeBus(config.redisUrl);
const upstream = new Upstream(store);
const collector = new Collector(store, upstream, bus);
const shutdown = new AbortController();
let startup: Promise<boolean> = Promise.resolve(false);
let closing: Promise<void> | undefined;
function close(): Promise<void> {
  if (closing) return closing;
  shutdown.abort();
  closing = (async () => {
    await startup.catch(() => {});
    await collector.stop();
    await upstream.close();
    bus.close();
    await store.close();
  })();
  return closing;
}
process.once("SIGTERM", () => {
  void close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
});
process.once("SIGINT", () => {
  void close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
});
startup = waitForCollectorLease(collector, shutdown.signal, {
  onWaiting: () =>
    console.info(
      "Paperdash ingestion standing by until the previous collector releases its lease.",
    ),
});
try {
  if ((await startup) && !closing) {
    console.info(
      `Paperdash ingestion started (${store.kind}); public source observations, not a canonical chain index.`,
    );
  }
} catch (error) {
  await close();
  throw error;
}
