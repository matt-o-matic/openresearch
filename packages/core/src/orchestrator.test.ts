import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GenericContainer, Wait } from "testcontainers";
import pg from "pg";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CitationMap, VerificationReport } from "./index.js";
import type { ModelProvider } from "./models.js";
import {
  runCitationMapKey,
  runOutputKey,
  runVerificationJsonKey,
  runResearchPipeline,
} from "./index.js";
import { FilesystemObjectStore, PostgresStore } from "@openresearch/storage";

class MockModelProvider implements ModelProvider {
  readonly name = "mock";

  async chat(req: Parameters<ModelProvider["chat"]>[0]) {
    const user = req.messages.find((m) => m.role === "user")?.content ?? "";

    if (user.includes("Generate a research plan")) {
      return {
        text: JSON.stringify({ subquestions: [], queries: ["example query"] }),
        usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.01 },
        raw: { mock: true },
      };
    }

    if (user.includes('"sources"') && user.includes('"keyFindings"')) {
      return {
        text: JSON.stringify({
          summary: "Summary based on sources.",
          keyFindings: [
            {
              id: "F1",
              text: "Example claim grounded in S1.",
              citations: [{ source: "S1", quoteId: "Q1" }],
            },
          ],
          unknowns: [],
        }),
        usage: { inputTokens: 30, outputTokens: 40, costUsd: 0.02 },
        raw: { mock: true },
      };
    }

    throw new Error(`Unhandled mock model request: ${user.slice(0, 80)}`);
  }
}

describe("orchestrator", () => {
  let container: Awaited<ReturnType<GenericContainer["start"]>> | undefined;
  let store: PostgresStore | undefined;
  let objectStoreRoot: string | undefined;

  beforeAll(async () => {
    container = await new GenericContainer("postgres:16")
      .withEnvironment({
        POSTGRES_USER: "openresearch",
        POSTGRES_PASSWORD: "openresearch",
        POSTGRES_DB: "openresearch",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections"))
      .start();

    const databaseUrl = `postgres://openresearch:openresearch@${container.getHost()}:${container.getMappedPort(
      5432
    )}/openresearch`;

    store = new PostgresStore({ databaseUrl });
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await store.migrate();
        break;
      } catch (err) {
        if (Date.now() > deadline) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    objectStoreRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openresearch-obj-"));
  }, 60_000);

  afterAll(async () => {
    await store?.close();
    await container?.stop();
    if (objectStoreRoot) await fs.rm(objectStoreRoot, { recursive: true, force: true });
  });

  it("runs an end-to-end pipeline and writes artifacts + DB records", async () => {
    const user = await store!.createUser({ role: "user" });
    const run = await store!.createRun({
      userId: user.id,
      prompt: "Test prompt",
      budgets: {
        maxRuntimeMs: 60_000,
        maxSources: 2,
        maxFetches: 2,
        maxBrowserRenders: 0,
        fetchConcurrency: 2,
        extractConcurrency: 2,
      },
      modelConfig: {
        planner: "mock/planner",
        synthesizer: "mock/synth",
        verifier: "mock/verify",
        verifierStrong: "mock/verify-strong",
      },
    });

    const objectStore = new FilesystemObjectStore({ rootPath: objectStoreRoot! });

    const search = {
      name: "mock-search",
      async search() {
        return [
          { url: "https://example.com/a", title: "A", snippet: "Snippet A" },
          { url: "https://example.com/b", title: "B", snippet: "Snippet B" },
        ];
      },
    };

    const httpFetch = {
      name: "mock-http",
      async fetch(url: string) {
        const html = `<html><head><title>${url}</title></head><body><p>This is a test sentence. Another one.</p></body></html>`;
        return {
          ok: true as const,
          url,
          status: 200,
          contentType: "text/html",
          body: new TextEncoder().encode(html),
        };
      },
    };

    const modelProvider = new MockModelProvider();

    await runResearchPipeline({
      runId: run.id,
      config: {
        env: "test",
        server: { host: "0.0.0.0", port: 0 },
        worker: {
          maxConcurrentJobs: 1,
          pollIntervalMs: 1000,
          leaseDurationMs: 60_000,
          heartbeatIntervalMs: 10_000,
        },
        postgres: { url: store!.databaseUrl },
        objectStore: { type: "filesystem", rootPath: objectStoreRoot! },
        cache: { enabled: false, rootPath: path.join(objectStoreRoot!, "cache"), ttlDays: 1 },
        debug: { traceTtlDays: 1 },
        openRouter: {
          apiKey: undefined,
          baseUrl: "https://example.invalid",
          appName: "openresearch",
          appUrl: undefined,
        },
        search: {
          backend: "searxng",
          maxResultsPerQuery: 10,
          searxng: { baseUrl: "http://localhost:8080" },
          brave: { apiKey: undefined },
        },
        models: {
          planner: "mock/planner",
          synthesizer: "mock/synth",
          verifier: "mock/verify",
          verifierStrong: "mock/verify-strong",
        },
        budgets: {
          maxRuntimeMs: 60_000,
          maxSources: 2,
          maxFetches: 2,
          maxBrowserRenders: 0,
          fetchConcurrency: 2,
          extractConcurrency: 2,
        },
        citationPolicy: "balanced",
        policies: {
          defaultUserPolicy: {
            requestsPerMinute: 60,
            maxConcurrentJobs: 1,
            downgradeThreshold: {},
            braveSearchQuota: 0,
          },
          qualityProfiles: {
            full: {
              name: "full",
              searchBackend: "searxng",
              thinkingMode: "high",
              models: {
                planner: "mock/planner",
                synthesizer: "mock/synth",
                verifier: "mock/verify",
                verifierStrong: "mock/verify-strong",
              },
              budgets: {},
              enablePlaywright: false,
            },
            degraded: {
              name: "degraded",
              searchBackend: "searxng",
              thinkingMode: "low",
              models: {
                planner: "mock/planner",
                synthesizer: "mock/synth",
                verifier: "mock/verify",
                verifierStrong: "mock/verify-strong",
              },
              budgets: {},
              enablePlaywright: false,
            },
          },
        },
        safety: {
          allowedDomains: [],
          deniedDomains: [],
          userAgent: "openresearch-test",
          maxContentBytes: 1_000_000,
        },
      },
      services: {
        store: store!,
        objectStore,
        search,
        httpFetch,
        modelProvider,
      },
    });

    const completed = await store!.getRun(run.id);
    expect(completed?.status).toBe("completed");

    const output = await objectStore.getText(runOutputKey(run.id));
    expect(output).toContain("# Research memo");
    expect(output).toContain("[^S1]");

    const citationMap = await objectStore.getJson<CitationMap>(runCitationMapKey(run.id));
    expect(citationMap?.sources?.length).toBeGreaterThan(0);

    const verification = await objectStore.getJson<VerificationReport>(
      runVerificationJsonKey(run.id)
    );
    expect(verification?.version).toBe(1);

    const client = new pg.Client({ connectionString: store!.databaseUrl });
    await client.connect();
    try {
      const modelCalls = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM model_calls WHERE run_id = $1",
        [run.id]
      );
      expect(Number(modelCalls.rows[0]!.count)).toBeGreaterThan(0);

      const citations = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM citations WHERE run_id = $1",
        [run.id]
      );
      expect(Number(citations.rows[0]!.count)).toBeGreaterThan(0);
    } finally {
      await client.end();
    }
  }, 60_000);
});
