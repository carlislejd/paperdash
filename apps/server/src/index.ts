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
if (collector && !(await collector.start()))
  app.log.warn(
    "Another collector owns the ingestion lease; serving persisted observations.",
  );
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  await collector?.stop();
  await upstream.close();
  bus.close();
  await store.close();
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
await app.listen({ host: config.host, port: config.port });
