import { createStore } from "./store.js";
import { Upstream } from "./upstream.js";
import { Collector } from "./collector.js";
import { ChangeBus } from "./bus.js";
import { buildApi } from "./api.js";
import { config } from "./config.js";

const store = await createStore();
const upstream = new Upstream(store);
const bus = new ChangeBus(config.redisUrl);
const app = await buildApi(store, upstream, bus);
const collector = config.embedded ? new Collector(store, upstream, bus) : null;
let startup: Promise<void> = Promise.resolve();
let closing: Promise<void> | undefined;
function close(): Promise<void> {
  if (closing) return closing;
  closing = (async () => {
    // Startup owns a possible lease/listening socket until its promise settles.
    await startup.catch(() => {});
    await app.close();
    await collector?.stop();
    await upstream.close();
    bus.close();
    await store.close();
  })();
  return closing;
}
process.on("SIGTERM", () => {
  void close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
});
process.on("SIGINT", () => {
  void close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
});
startup = (async () => {
  if (collector && !(await collector.start()))
    app.log.warn(
      "Another collector owns the ingestion lease; serving persisted observations.",
    );
  if (!closing) await app.listen({ host: config.host, port: config.port });
})();
try {
  await startup;
} catch (error) {
  await close();
  throw error;
}
