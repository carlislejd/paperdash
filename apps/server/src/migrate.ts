import { createStore } from "./store.js";

const store = await createStore({ autoMigrate: true });
console.info(`Paperdash ${store.kind} schema ready.`);
await store.close();
