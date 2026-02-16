import { afterEach, describe, expect, it } from "vitest";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  const prev = {
    OPENRESEARCH_CONFIG: process.env.OPENRESEARCH_CONFIG,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    BRAVE_API_KEY: process.env.BRAVE_API_KEY,
    DATABASE_URL: process.env.DATABASE_URL,
    OPENRESEARCH_TEST_UA: process.env.OPENRESEARCH_TEST_UA,
  };

  afterEach(() => {
    process.env.OPENRESEARCH_CONFIG = prev.OPENRESEARCH_CONFIG;
    process.env.OPENROUTER_API_KEY = prev.OPENROUTER_API_KEY;
    process.env.BRAVE_API_KEY = prev.BRAVE_API_KEY;
    process.env.DATABASE_URL = prev.DATABASE_URL;
    process.env.OPENRESEARCH_TEST_UA = prev.OPENRESEARCH_TEST_UA;
  });

  it("resolves env:VAR references and omits missing vars", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openresearch-config-"));
    try {
      const configPath = path.join(dir, "openresearch.config.json");
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            openRouter: { apiKey: "env:OPENROUTER_API_KEY" },
            search: { brave: { apiKey: "env:BRAVE_API_KEY" } },
            postgres: { url: "env:DATABASE_URL" },
            safety: { userAgent: "env:OPENRESEARCH_TEST_UA" },
          },
          null,
          2
        )
      );

      delete process.env.OPENROUTER_API_KEY;
      delete process.env.BRAVE_API_KEY;
      delete process.env.DATABASE_URL;
      process.env.OPENRESEARCH_TEST_UA = "ua-from-envref";
      process.env.OPENRESEARCH_CONFIG = configPath;

      const config = await loadConfig();
      expect(config.safety.userAgent).toBe("ua-from-envref");
      expect(config.openRouter.apiKey).toBeUndefined();
      expect(config.search.brave.apiKey).toBeUndefined();
      expect(config.postgres.url).toBe(
        "postgres://openresearch:openresearch@localhost:5432/openresearch"
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
