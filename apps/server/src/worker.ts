import { createStore } from "./store.js";
import { Upstream } from "./upstream.js";
import { Collector } from "./collector.js";
import { ChangeBus } from "./bus.js";
import { config } from "./config.js";

const store = await createStore();
const bus = new ChangeBus(config.redisUrl);
const upstream = new Upstream(store);
const collector = new Collector(store, upstream, bus);
if (!(await collector.start())) {
  // Render deploy overlap: let the old worker finish rather than running two feeds.
  console.error(
    "Another collector currently holds the ingestion lease. Retry after its shutdown.",
  );
  bus.close();
  await upstream.close();
  await store.close();
  process.exit(1);
}
console.info(
  `Paperdash ingestion started (${store.kind}); public source observations, not a canonical chain index.`,
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await collector.stop();
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
