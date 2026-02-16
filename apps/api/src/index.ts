import { loadConfig } from "@openresearch/core";
import { FilesystemObjectStore, PostgresStore } from "@openresearch/storage";

import { buildApiServer } from "./server.js";

const config = await loadConfig();
const store = new PostgresStore({ databaseUrl: config.postgres.url });
await store.migrate();

const objectStore = new FilesystemObjectStore({ rootPath: config.objectStore.rootPath });
const app = await buildApiServer({ config, store, objectStore });

await app.listen({ port: config.server.port, host: config.server.host });
