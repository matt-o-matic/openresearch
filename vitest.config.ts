import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@openresearch/core": path.join(rootDir, "packages/core/src/index.ts"),
      "@openresearch/adapters": path.join(rootDir, "packages/adapters/src/index.ts"),
      "@openresearch/storage": path.join(rootDir, "packages/storage/src/index.ts"),
      "@openresearch/api": path.join(rootDir, "apps/api/src/server.ts"),
      "@openresearch/worker": path.join(rootDir, "apps/worker/src/worker.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    testTimeout: 60_000,
  },
});
