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
  sourceEvidenceKey,
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

class TodoListModelProvider implements ModelProvider {
  readonly name = "mock-todo-list";

  async chat(req: Parameters<ModelProvider["chat"]>[0]) {
    const user = req.messages.find((m) => m.role === "user")?.content ?? "";

    if (user.includes("Generate a research plan")) {
      return {
        text: JSON.stringify({
          subquestions: [
            "Map official efficiency guidance by agency.",
            "Identify evidence for certification standards updates.",
            "Find real-world implementation edge cases.",
          ],
          queries: [
            "official solar panel efficiency guidance site:energy.gov",
            "IEC 61215 revision solar module certification",
            "IEA solar PV installation edge cases 2024",
          ],
          followUpTasks: [],
        }),
        usage: { inputTokens: 6, outputTokens: 10, costUsd: 0.01 },
        raw: { mock: true },
      };
    }

    if (user.includes('"sources"') && user.includes('"keyFindings"')) {
      return {
        text: JSON.stringify({
          summary: "To-do driven synthesis summary.",
          keyFindings: [
            {
              id: "F1",
              text: "Finding grounded in sources from explicit plan priorities.",
              citations: [{ source: "S1", quoteId: "Q1" }],
            },
          ],
          unknowns: [],
        }),
        usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.02 },
        raw: { mock: true },
      };
    }

    throw new Error(`Unhandled todo-list mock model request: ${user.slice(0, 80)}`);
  }
}

class LoopingPlanModelProvider implements ModelProvider {
  readonly name = "mock-looping";
  public planCallCount = 0;

  constructor(
    private readonly alwaysFollowUp = true,
    private readonly alwaysContinue = true
  ) {}

  async chat(req: Parameters<ModelProvider["chat"]>[0]) {
    const user = req.messages.find((m) => m.role === "user")?.content ?? "";

    if (user.includes("Generate a research plan")) {
      this.planCallCount += 1;
      const followUpTasks = this.alwaysFollowUp
        ? Array.from({ length: 20 }, (_, i) => `Follow-up task ${i + 1}`)
        : [];
      const result = {
        subquestions: [`Subquestion ${this.planCallCount}`],
        queries: [`query ${this.planCallCount}`],
        followUpTasks,
        continuePlanning: this.alwaysContinue && this.alwaysFollowUp,
      };
      return {
        text: JSON.stringify(result),
        usage: { inputTokens: 5, outputTokens: 10, costUsd: 0.01 },
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
              text: "Finding grounded in S1.",
              citations: [{ source: "S1", quoteId: "Q1" }],
            },
          ],
          unknowns: [],
        }),
        usage: { inputTokens: 30, outputTokens: 40, costUsd: 0.02 },
        raw: { mock: true },
      };
    }

    throw new Error(`Unhandled looping model request: ${user.slice(0, 80)}`);
  }
}

class TrackingSynthesisModelProvider implements ModelProvider {
  readonly name = "mock-synthesis";
  public seenOutputTokens: Array<number | undefined> = [];

  async chat(req: Parameters<ModelProvider["chat"]>[0]) {
    this.seenOutputTokens.push(req.maxTokens);
    return {
      text: JSON.stringify({
        summary: "Trimmed summary.",
        keyFindings: [
          {
            id: "F1",
            text: "Long-form synthesis anchored in provided sources.",
            citations: [{ source: "S1", quoteId: "Q1" }],
          },
        ],
        unknowns: [],
      }),
      usage: { inputTokens: 9, outputTokens: 24, costUsd: 0.02 },
      raw: { mock: true },
    };
  }
}

class ReviewLoopModelProvider implements ModelProvider {
  readonly name = "mock-review-loop";
  public synthCallCount = 0;
  public reviewCallCount = 0;
  public synthesisRequests: Array<{
    refinementPass?: number;
    hasReviewFeedback: boolean;
    reviewFeedback?: unknown;
    reviewStatus?: string;
  }> = [];

  async chat(req: Parameters<ModelProvider["chat"]>[0]) {
    const user = req.messages.find((m) => m.role === "user")?.content ?? "";
    if (user.includes("Attack the report")) {
      this.reviewCallCount += 1;
      if (this.reviewCallCount === 1) {
        return {
          text: JSON.stringify({
            verdict: "revise",
            unsupportedConclusions: [
              {
                findingId: "F1",
                issue: "This conclusion lacks cross-source triangulation.",
                why: "Both sources are needed to support this causal claim.",
                strengtheningAlternative: "Track where each source confirms the mechanism separately.",
              },
            ],
            missingEvidence: ["Need explicit mechanism evidence in independent source families."],
            requestedRevisions: ["Add at least one explicit cross-source mechanism citation."],
          }),
          usage: { inputTokens: 12, outputTokens: 42, costUsd: 0.03 },
          raw: { mock: true },
        };
      }

      return {
        text: JSON.stringify({
          verdict: "accept",
          unsupportedConclusions: [],
          missingEvidence: [],
          requestedRevisions: [],
        }),
        usage: { inputTokens: 11, outputTokens: 20, costUsd: 0.02 },
        raw: { mock: true },
      };
    }

    this.synthCallCount += 1;
    try {
      const requestPayload = JSON.parse(user);
      if (requestPayload && typeof requestPayload === "object") {
        this.synthesisRequests.push({
          refinementPass: typeof requestPayload.refinementPass === "number" ? requestPayload.refinementPass : undefined,
          hasReviewFeedback: !!requestPayload.reviewFeedback,
          reviewFeedback: requestPayload.reviewFeedback,
          reviewStatus: requestPayload.reviewStatus,
        });
      }
    } catch {
      this.synthesisRequests.push({
        hasReviewFeedback: false,
      });
    }
    return {
      text: JSON.stringify({
        summary: Array.from({ length: 80 }, () =>
          "Synthesized conclusions for the two-source memo are consistent with observed system-level signals and long-form evidence collection."
        ).join(" "),
        sourceIndex: [
          { source: "S1", reliabilityAssessment: "High quality", rationale: "Primary source with direct telemetry." },
          { source: "S2", reliabilityAssessment: "Secondary corroboration", rationale: "Cross-validates source framing." },
          { source: "S3", reliabilityAssessment: "Additional corroboration", rationale: "Provides third-path validation." },
        ],
        thematicSynthesis: [
          {
            theme: "Cross-source consistency",
            observation: "Both sources report overlapping signal behavior.",
            inference: "This suggests the effect is robust across contexts.",
            implication: "Adopt implementation practices that preserve the shared controls.",
            citations: [{ source: "S1", quoteId: "Q1" }, { source: "S2", quoteId: "Q1" }],
          },
        ],
        keyFindings: Array.from({ length: 6 }, (_, i) => ({
          id: `F${i + 1}`,
          text: `Finding ${i + 1} based on both source families and aligned evidence path.`,
          citations: [{ source: "S1", quoteId: "Q1" }, { source: "S2", quoteId: "Q1" }],
        })),
        contradictions: [],
        recommendations: [
          "Scale pilot with controlled measurement gates.",
          "Create dual-source verification checkpoints.",
          "Track lag and throughput deltas weekly.",
          "Document edge cases where model assumptions break.",
        ],
        unknowns: ["Review cycle requested to reduce over-claiming from either source."],
        negativeSpace: {
          missingLinks: ["Need more longitudinal evidence."],
          unaskedQuestions: ["What failure modes trigger signal erosion?"],
          temporalBlindspots: ["Need to validate next-quarter stability."],
        },
        confidenceAppendix: [
          {
            type: "INFERRED",
            statement: "This synthetic claim depends on the overlap between source families.",
            alternativeInterpretations: ["Could be driven by a confounder not represented here."],
            evidenceNotes: "Shared patterns appear across both source snippets.",
          },
        ],
      }),
      usage: { inputTokens: 52, outputTokens: 300, costUsd: 0.05 },
      raw: { mock: true },
    };
  }
}

class FailingSynthesisModelProvider implements ModelProvider {
  readonly name = "mock-failing-synthesis";
  public requestCount = 0;

  async chat(req: Parameters<ModelProvider["chat"]>[0]) {
    this.requestCount += 1;
    const user = req.messages.find((m) => m.role === "user")?.content ?? "";

    if (user.includes("Generate a research plan")) {
      return {
        text: JSON.stringify({ subquestions: [], queries: ["example query"] }),
        usage: { inputTokens: 8, outputTokens: 10, costUsd: 0.01 },
        raw: { mock: true },
      };
    }

    if (user.includes("keyFindings") || user.includes('"sources"')) {
      throw new Error("Simulated provider failure during synthesis");
    }

    throw new Error(`Unhandled failing synthesis mock request: ${user.slice(0, 80)}`);
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

  it("caps planner pass count and follow-up tasks per pass using adapter config", async () => {
    const user = await store!.createUser({ role: "user" });
    const run = await store!.createRun({
      userId: user.id,
      prompt: "What is the future of AI agents?",
      budgets: {
        maxRuntimeMs: 60_000,
        maxSources: 0,
        maxFetches: 0,
        maxBrowserRenders: 0,
        fetchConcurrency: 1,
        extractConcurrency: 1,
      },
      modelConfig: {
        planner: "mock/planner",
        synthesizer: "mock/synth",
        verifier: "mock/verify",
        verifierStrong: "mock/verify-strong",
      },
      adapterConfig: {
        searchBackend: "searxng",
        thinkingMode: "high",
        enablePlaywright: false,
        debugCapture: false,
        agenticLoop: {
          maxPlanPasses: 5,
          maxFollowUpTasksPerPass: 10,
        },
        synthesis: {
          maxInputTokens: 1_000_000,
          maxOutputTokens: 500_000,
        },
      },
    });

    const objectStore = new FilesystemObjectStore({ rootPath: objectStoreRoot! });
    const modelProvider = new LoopingPlanModelProvider();
    const search = {
      name: "mock-search",
      async search() {
        return [];
      },
    };
    const httpFetch = {
      name: "mock-http",
      async fetch() {
        return {
          ok: false,
          url: "about:blank",
          status: 500,
          contentType: null,
          body: new TextEncoder().encode(""),
        };
      },
    };

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
          maxSources: 0,
          maxFetches: 0,
          maxBrowserRenders: 0,
          fetchConcurrency: 1,
          extractConcurrency: 1,
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
              agenticLoop: {
                maxPlanPasses: 5,
                maxFollowUpTasksPerPass: 10,
              },
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
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

    const events = await store!.listRunEvents(run.id, { limit: 100 });
    const capEvent = events.find((event) => event.event_type === "plan_loop_cap_reached");
    const trimEvent = events.find((event) => event.event_type === "plan_follow_ups_trimmed");
    expect(capEvent).toBeDefined();
    expect(trimEvent).toBeDefined();
    expect(trimEvent?.data).toMatchObject({
      requestedFollowUpTasks: 20,
      scheduledFollowUpTasks: 10,
      hardLimit: 10,
    });

    const client = new pg.Client({ connectionString: store!.databaseUrl });
    await client.connect();
    try {
      const planCalls = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM model_calls WHERE run_id = $1 AND phase = $2",
        [run.id, "plan"]
      );
      expect(Number(planCalls.rows[0]!.count)).toBe(5);
    } finally {
      await client.end();
    }
  }, 60_000);

  it("stops planning when continuePlanning is false even if follow-up tasks are present", async () => {
    const user = await store!.createUser({ role: "user" });
    const run = await store!.createRun({
      userId: user.id,
      prompt: "How can follow-up plans be constrained?",
      budgets: {
        maxRuntimeMs: 60_000,
        maxSources: 0,
        maxFetches: 0,
        maxBrowserRenders: 0,
        fetchConcurrency: 1,
        extractConcurrency: 1,
      },
      modelConfig: {
        planner: "mock-planner",
        synthesizer: "mock/synth",
        verifier: "mock/verify",
        verifierStrong: "mock/verify-strong",
      },
      adapterConfig: {
        searchBackend: "searxng",
        thinkingMode: "high",
        enablePlaywright: false,
        debugCapture: false,
        agenticLoop: {
          maxPlanPasses: 5,
          maxFollowUpTasksPerPass: 10,
        },
        synthesis: {
          maxInputTokens: 1_000_000,
          maxOutputTokens: 500_000,
        },
      },
    });

    const objectStore = new FilesystemObjectStore({ rootPath: objectStoreRoot! });
    const modelProvider = new LoopingPlanModelProvider(true, false);
    const search = {
      name: "mock-search",
      async search() {
        return [];
      },
    };
    const httpFetch = {
      name: "mock-http",
      async fetch() {
        return {
          ok: false,
          url: "about:blank",
          status: 500,
          contentType: null,
          body: new TextEncoder().encode(""),
        };
      },
    };

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
          planner: "mock-planner",
          synthesizer: "mock/synth",
          verifier: "mock/verify",
          verifierStrong: "mock/verify-strong",
        },
        budgets: {
          maxRuntimeMs: 60_000,
          maxSources: 0,
          maxFetches: 0,
          maxBrowserRenders: 0,
          fetchConcurrency: 1,
          extractConcurrency: 1,
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
                planner: "mock-planner",
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
                planner: "mock-planner",
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

    expect(modelProvider.planCallCount).toBe(1);
    const events = await store!.listRunEvents(run.id, { limit: 100 });
    const todoEvent = events.find((event) => event.event_type === "plan_todo_list_ready");
    expect(todoEvent).toBeDefined();
    expect(events.find((event) => event.event_type === "plan_loop_cap_reached")).toBeUndefined();
  }, 60_000);

  it("emits a rendered plan to-do list event after planning", async () => {
    const user = await store!.createUser({ role: "user" });
    const run = await store!.createRun({
      userId: user.id,
      prompt: "How should a business assess solar panel efficiency claims?",
      budgets: {
        maxRuntimeMs: 60_000,
        maxSources: 0,
        maxFetches: 0,
        maxBrowserRenders: 0,
        fetchConcurrency: 1,
        extractConcurrency: 1,
      },
      modelConfig: {
        planner: "mock/planner",
        synthesizer: "mock/synth",
        verifier: "mock/verify",
        verifierStrong: "mock/verify-strong",
      },
      adapterConfig: {
        searchBackend: "searxng",
        thinkingMode: "high",
        enablePlaywright: false,
        debugCapture: false,
        agenticLoop: {
          maxPlanPasses: 1,
          maxFollowUpTasksPerPass: 10,
        },
        synthesis: {
          maxInputTokens: 1_000_000,
          maxOutputTokens: 500_000,
        },
      },
    });

    const objectStore = new FilesystemObjectStore({ rootPath: objectStoreRoot! });
    const modelProvider = new TodoListModelProvider();
    const search = {
      name: "mock-search",
      async search() {
        return [];
      },
    };
    const httpFetch = {
      name: "mock-http",
      async fetch() {
        return {
          ok: false,
          url: "about:blank",
          status: 500,
          contentType: null,
          body: new TextEncoder().encode(""),
        };
      },
    };

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
          maxSources: 0,
          maxFetches: 0,
          maxBrowserRenders: 0,
          fetchConcurrency: 1,
          extractConcurrency: 1,
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

    const events = await store!.listRunEvents(run.id, { limit: 100 });
    const todoEvent = events.find((event) => event.event_type === "plan_todo_list_ready");
    expect(todoEvent).toBeDefined();
    expect(todoEvent?.message).toBe("Plan to-do list generated");
    const items = (todoEvent?.data as { items?: Array<{ text: string }> } | null)?.items;
    expect(items).toEqual([
      { index: 1, text: "Map official efficiency guidance by agency." },
      { index: 2, text: "Identify evidence for certification standards updates." },
      { index: 3, text: "Find real-world implementation edge cases." },
    ]);
    expect((todoEvent?.data as { queryHints?: string[] } | null)?.queryHints?.slice(0, 2)).toEqual([
      "official solar panel efficiency guidance site:energy.gov",
      "IEC 61215 revision solar module certification",
    ]);
    expect((todoEvent?.data as { passCount?: number; maxPlanPasses?: number } | null)?.passCount).toBe(1);
  }, 60_000);

  it("passes synthesis output caps and trims oversized source context", async () => {
    const user = await store!.createUser({ role: "user" });
    const run = await store!.createRun({
      userId: user.id,
      prompt: "Large context test",
      budgets: {
        maxRuntimeMs: 60_000,
        maxSources: 1,
        maxFetches: 1,
        maxBrowserRenders: 0,
        fetchConcurrency: 1,
        extractConcurrency: 1,
      },
      modelConfig: {
        planner: "mock/planner",
        synthesizer: "mock/synth",
        verifier: "mock/verify",
        verifierStrong: "mock/verify-strong",
      },
      adapterConfig: {
        searchBackend: "searxng",
        thinkingMode: "high",
        enablePlaywright: false,
        debugCapture: false,
        agenticLoop: {
          maxPlanPasses: 1,
          maxFollowUpTasksPerPass: 10,
        },
        synthesis: {
          maxInputTokens: 120,
          maxOutputTokens: 500_000,
        },
      },
    });

    const source = await store!.createSource({ runId: run.id, url: "https://example.com/large" });
    const evidence = {
      contentText:
        "Artificial intelligence continues to expand in many domains, transforming workflows, communication, and software. ".repeat(
          200
        ),
      metadata: { title: "Source title", publisher: "Example", authors: [], publishedAt: null },
      quotes: [
        {
          text: "Artificial intelligence continues to expand in many domains, transforming workflows, communication, and software.",
          start: 0,
          end: 112,
        },
      ],
      chunks: [{ start: 0, end: 200, text: "A snippet" }],
    };

    await store!.updateSource({
      sourceId: source.id,
      status: "extracted",
      finalUrl: "https://example.com/large",
      title: evidence.metadata.title,
      publisher: evidence.metadata.publisher,
      extractKey: sourceEvidenceKey(run.id, source.id),
    });

    const objectStore = new FilesystemObjectStore({ rootPath: objectStoreRoot! });
    await objectStore.putJson(sourceEvidenceKey(run.id, source.id), evidence);

    await store!.updateRun({
      runId: run.id,
      state: {
        version: 1,
        nextPhase: "synthesize",
        counters: { searchCalls: 0, fetches: 0, renders: 0, modelCalls: 0 },
        artifacts: {},
        startedAt: new Date().toISOString(),
        debug: { enabled: false },
      },
    });

    const modelProvider = new TrackingSynthesisModelProvider();

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
          maxSources: 1,
          maxFetches: 1,
          maxBrowserRenders: 0,
          fetchConcurrency: 1,
          extractConcurrency: 1,
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
              agenticLoop: {
                maxPlanPasses: 1,
                maxFollowUpTasksPerPass: 10,
              },
              synthesis: { maxInputTokens: 120, maxOutputTokens: 500_000 },
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
        search: {
          name: "mock-search",
          async search() {
            return [];
          },
        },
        httpFetch: {
          name: "mock-http",
          async fetch() {
            return {
              ok: false,
              url: "about:blank",
              status: 500,
              contentType: null,
              body: new TextEncoder().encode(""),
            };
          },
        },
        modelProvider,
      },
    });

    expect(modelProvider.seenOutputTokens[0]).toBeLessThan(500_000);
    expect(modelProvider.seenOutputTokens[0]).toBeGreaterThan(0);

    const events = await store!.listRunEvents(run.id, { limit: 100 });
    const trimEvent = events.find(
      (event) =>
        event.event_type === "synthesis_context_trimmed" ||
        event.event_type === "synthesis_output_cap_applied"
    );
    expect(trimEvent?.data).toMatchObject({
      sourceCountBefore: 1,
      sourceCountAfter: 1,
    });

    const output = await objectStore.getText(runOutputKey(run.id));
    expect(output).toContain("[^S1]");
  }, 60_000);

  it("runs synthesis review loop and records reviewer-guided refinement", async () => {
    const user = await store!.createUser({ role: "user" });
    const run = await store!.createRun({
      userId: user.id,
      prompt: "Evaluate two sources with review feedback and ensure synthesized depth",
      budgets: {
        maxRuntimeMs: 60_000,
        maxSources: 2,
        maxFetches: 0,
        maxBrowserRenders: 0,
        fetchConcurrency: 1,
        extractConcurrency: 1,
      },
      modelConfig: {
        planner: "mock/planner",
        synthesizer: "mock/synth",
        verifier: "mock/verify",
        verifierStrong: "mock/verify-strong",
      },
    });

    const source1 = await store!.createSource({ runId: run.id, url: "https://example.com/review-a" });
    const source2 = await store!.createSource({ runId: run.id, url: "https://example.com/review-b" });
    const source3 = await store!.createSource({ runId: run.id, url: "https://example.com/review-c" });
    const evidence1 = {
      contentText: "A consistent policy signal appeared in both telemetry streams and operations logs.",
      metadata: { title: "Source A", publisher: "Example", authors: [], publishedAt: null },
      quotes: [
        {
          text: "A consistent policy signal appeared in both telemetry streams and operations logs.",
          start: 0,
          end: 77,
        },
      ],
      chunks: [{ start: 0, end: 77, text: "A consistent policy signal appeared in both telemetry streams." }],
    };
    const evidence2 = {
      contentText: "Independent reporting confirmed the same operational pattern across environments.",
      metadata: { title: "Source B", publisher: "Example", authors: [], publishedAt: null },
      quotes: [
        {
          text: "Independent reporting confirmed the same operational pattern across environments.",
          start: 0,
          end: 73,
        },
      ],
      chunks: [{ start: 0, end: 73, text: "Independent reporting confirmed the same operational pattern." }],
    };
    const evidence3 = {
      contentText: "Third-source signals independently validated the operational pattern under a separate regime.",
      metadata: { title: "Source C", publisher: "Example", authors: [], publishedAt: null },
      quotes: [
        {
          text: "Third-source signals independently validated the operational pattern under a separate regime.",
          start: 0,
          end: 88,
        },
      ],
      chunks: [{ start: 0, end: 88, text: "Third-source signals independently validated the same pattern." }],
    };
    await store!.updateSource({
      sourceId: source1.id,
      status: "extracted",
      finalUrl: "https://example.com/review-a",
      title: evidence1.metadata.title,
      publisher: evidence1.metadata.publisher,
      extractKey: sourceEvidenceKey(run.id, source1.id),
    });
    await store!.updateSource({
      sourceId: source2.id,
      status: "extracted",
      finalUrl: "https://example.com/review-b",
      title: evidence2.metadata.title,
      publisher: evidence2.metadata.publisher,
      extractKey: sourceEvidenceKey(run.id, source2.id),
    });
    await store!.updateSource({
      sourceId: source3.id,
      status: "extracted",
      finalUrl: "https://example.com/review-c",
      title: evidence3.metadata.title,
      publisher: evidence3.metadata.publisher,
      extractKey: sourceEvidenceKey(run.id, source3.id),
    });

    const objectStore = new FilesystemObjectStore({ rootPath: objectStoreRoot! });
    await objectStore.putJson(sourceEvidenceKey(run.id, source1.id), evidence1);
    await objectStore.putJson(sourceEvidenceKey(run.id, source2.id), evidence2);
    await objectStore.putJson(sourceEvidenceKey(run.id, source3.id), evidence3);

    await store!.updateRun({
      runId: run.id,
      state: {
        version: 1,
        nextPhase: "synthesize",
        counters: { searchCalls: 0, fetches: 0, renders: 0, modelCalls: 0 },
        artifacts: {},
        startedAt: new Date().toISOString(),
        debug: { enabled: false },
      },
    });

    const modelProvider = new ReviewLoopModelProvider();

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
          maxSources: 3,
          maxFetches: 0,
          maxBrowserRenders: 0,
          fetchConcurrency: 1,
          extractConcurrency: 1,
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
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
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
        search: {
          name: "mock-search",
          async search() {
            return [];
          },
        },
        httpFetch: {
          name: "mock-http",
          async fetch() {
            return {
              ok: false,
              url: "about:blank",
              status: 500,
              contentType: null,
              body: new TextEncoder().encode(""),
            };
          },
        },
        modelProvider,
      },
    });

    const events = await store!.listRunEvents(run.id, { limit: 200 });
    expect(events.find((event) => event.event_type === "synthesis_review_requested")).toBeDefined();
    const reviewFeedbackEvents = events.filter((event) => event.event_type === "synthesis_review_feedback");
    expect(reviewFeedbackEvents.length).toBeGreaterThanOrEqual(1);
    const hasUnsupportedFeedback = reviewFeedbackEvents.some((event) => {
      const data = event.data as { unsupportedConclusions?: unknown[] } | undefined;
      return Array.isArray(data?.unsupportedConclusions) && data.unsupportedConclusions.length > 0;
    });
    expect(hasUnsupportedFeedback).toBe(true);
    const firstSynthesisRequest = modelProvider.synthesisRequests.at(0);
    const refinedSynthesisRequest = modelProvider.synthesisRequests.slice(1).find((request) => request.hasReviewFeedback);
    expect(firstSynthesisRequest?.hasReviewFeedback).toBe(false);
    expect(refinedSynthesisRequest).toBeDefined();
    expect(refinedSynthesisRequest?.reviewFeedback).toMatchObject({
      verdict: "revise",
      unsupportedConclusions: [{ findingId: "F1" }],
      missingEvidence: ["Need explicit mechanism evidence in independent source families."],
      requestedRevisions: ["Add at least one explicit cross-source mechanism citation."],
      directives: ["Track where each source confirms the mechanism separately."],
    });
    expect(events.find((event) => event.event_type === "synthesis_refinement_succeeded")).toBeDefined();
    expect(modelProvider.synthCallCount).toBeGreaterThanOrEqual(2);
    expect(modelProvider.reviewCallCount).toBeGreaterThanOrEqual(1);
    const output = await objectStore.getText(runOutputKey(run.id));
    expect(output).toContain("Cross-source consistency");
  }, 60_000);

  it("writes a model response artifact for every logged model request", async () => {
    const user = await store!.createUser({ role: "user" });
    const run = await store!.createRun({
      userId: user.id,
      prompt: "Track model request/response artifacts on failures.",
      budgets: {
        maxRuntimeMs: 60_000,
        maxSources: 1,
        maxFetches: 0,
        maxBrowserRenders: 0,
        fetchConcurrency: 1,
        extractConcurrency: 1,
      },
      modelConfig: {
        planner: "mock/planner",
        synthesizer: "mock/synth",
        verifier: "mock/verify",
        verifierStrong: "mock/verify-strong",
      },
    });

    const source = await store!.createSource({ runId: run.id, url: "https://example.com/failing-synth-source" });
    await store!.updateSource({
      sourceId: source.id,
      status: "extracted",
      finalUrl: "https://example.com/failing-synth-source",
      title: "Failing Synth Source",
      publisher: "Example",
      extractKey: sourceEvidenceKey(run.id, source.id),
    });
    const evidence = {
      contentText: "A policy signal appears under both positive and negative conditions.",
      metadata: { title: "Failing Synth Source", publisher: "Example", authors: [], publishedAt: null },
      quotes: [
        {
          text: "A policy signal appears under both positive and negative conditions.",
          start: 0,
          end: 73,
        },
      ],
      chunks: [{ start: 0, end: 73, text: "A policy signal appears under both positive and negative conditions." }],
    };

    const objectStore = new FilesystemObjectStore({ rootPath: objectStoreRoot! });
    await objectStore.putJson(sourceEvidenceKey(run.id, source.id), evidence);

    await store!.updateRun({
      runId: run.id,
      state: {
        version: 1,
        nextPhase: "synthesize",
        counters: { searchCalls: 0, fetches: 0, renders: 0, modelCalls: 0 },
        artifacts: {},
        startedAt: new Date().toISOString(),
        debug: { enabled: false },
      },
    });

    const modelProvider = new FailingSynthesisModelProvider();

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
          maxSources: 1,
          maxFetches: 0,
          maxBrowserRenders: 0,
          fetchConcurrency: 1,
          extractConcurrency: 1,
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
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
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
        search: {
          name: "mock-search",
          async search() {
            return [];
          },
        },
        httpFetch: {
          name: "mock-http",
          async fetch() {
            return {
              ok: false,
              url: "about:blank",
              status: 500,
              contentType: null,
              body: new TextEncoder().encode(""),
            };
          },
        },
        modelProvider,
      },
    });

    const finalRun = await store!.getRun(run.id);
    expect(finalRun?.status).toBe("failed");

    expect(modelProvider.requestCount).toBeGreaterThan(0);

    const modelCallDir = path.join(objectStoreRoot!, "runs", run.id, "model-calls");
    const phaseEntries = await fs.readdir(modelCallDir, { withFileTypes: true });
    const requestedCalls = new Set<string>();
    const respondedCalls = new Set<string>();

    for (const phaseEntry of phaseEntries) {
      if (!phaseEntry.isDirectory()) continue;
      const phasePath = path.join(modelCallDir, phaseEntry.name);
      const phaseFiles = await fs.readdir(phasePath);
      for (const file of phaseFiles) {
        if (file.endsWith(".request.json")) {
          requestedCalls.add(`${phaseEntry.name}/${file.replace(/\.request\.json$/, "")}`);
        }
        if (file.endsWith(".response.json")) {
          respondedCalls.add(`${phaseEntry.name}/${file.replace(/\.response\.json$/, "")}`);
        }
      }
    }

    expect(requestedCalls.size).toBeGreaterThan(0);
    expect(respondedCalls.size).toBe(requestedCalls.size);
    const missingResponses = [...requestedCalls].filter((callId) => !respondedCalls.has(callId));
    expect(missingResponses).toEqual([]);
  }, 60_000);
});
