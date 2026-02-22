import { describe, expect, it } from "vitest";

import type { ModelProvider } from "./models.js";
import { OpenResearchConfigSchema } from "./config.js";
import type {
  ObjectStore,
  PipelineRunRow,
  PipelineSourceRow,
  PipelineStore,
  RunCheckpoint,
} from "./orchestrator.js";
import { runResearchPipeline } from "./orchestrator.js";
import { runArtifactKey } from "./artifacts.js";
import type { QuestionGraph } from "./goal-directed.js";

class MemoryObjectStore implements ObjectStore {
  private readonly json = new Map<string, unknown>();
  private readonly text = new Map<string, string>();
  private readonly bytes = new Map<string, Uint8Array>();

  async putJson(key: string, value: unknown): Promise<void> {
    this.json.set(key, value);
  }

  async putText(key: string, value: string): Promise<void> {
    this.text.set(key, value);
  }

  async putBytes(key: string, value: Uint8Array): Promise<void> {
    this.bytes.set(key, value);
  }

  async getJson<T>(key: string): Promise<T | null> {
    if (!this.json.has(key)) return null;
    return this.json.get(key) as T;
  }

  async getText(key: string): Promise<string | null> {
    return this.text.get(key) ?? null;
  }

  async getBytes(key: string): Promise<Uint8Array | null> {
    return this.bytes.get(key) ?? null;
  }
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type MemoryRunRow = PipelineRunRow & {
  plan?: unknown;
  error?: unknown;
};

class MemoryPipelineStore implements PipelineStore {
  private readonly runs = new Map<string, { row: MemoryRunRow }>();
  private readonly sources = new Map<string, PipelineSourceRow>();
  private sourceSeq = 0;

  readonly events: Array<{
    runId: string;
    level: "debug" | "info" | "warn" | "error";
    phase: string | undefined;
    eventType: string;
    message: string | undefined;
    data: unknown | undefined;
  }> = [];

  constructor(opts: {
    runId: string;
    userId: string;
    prompt: string;
    budgets: unknown;
    modelConfig: unknown;
    adapterConfig: unknown;
    checkpoint: RunCheckpoint;
  }) {
    this.runs.set(opts.runId, {
      row: {
        id: opts.runId,
        user_id: opts.userId,
        prompt: opts.prompt,
        status: "queued",
        phase: opts.checkpoint.nextPhase,
        citation_policy: "balanced",
        template: "research-memo",
        budgets: opts.budgets,
        model_config: opts.modelConfig,
        adapter_config: opts.adapterConfig,
        state: deepClone(opts.checkpoint),
      },
    });
  }

  async getRun(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return null;
    return deepClone(run.row);
  }

  async updateRun(input: Parameters<PipelineStore["updateRun"]>[0]): Promise<void> {
    const run = this.runs.get(input.runId);
    if (!run) return;
    if (input.status !== undefined) run.row.status = input.status;
    if (input.phase !== undefined) run.row.phase = input.phase;
    if (input.plan !== undefined) run.row.plan = deepClone(input.plan);
    if (input.state !== undefined) run.row.state = deepClone(input.state);
    if (input.error !== undefined) run.row.error = deepClone(input.error);
  }

  async addRunEvent(input: Parameters<PipelineStore["addRunEvent"]>[0]) {
    this.events.push({
      runId: input.runId,
      level: input.level,
      phase: input.phase,
      eventType: input.eventType,
      message: input.message,
      data: input.data,
    });
    return {};
  }

  async addUsageDelta(): Promise<void> {}

  async listSources(runId: string): Promise<PipelineSourceRow[]> {
    return Array.from(this.sources.values()).filter((s) => s.run_id === runId);
  }

  async createSource(input: { runId: string; url: string }): Promise<PipelineSourceRow> {
    this.sourceSeq += 1;
    const id = `src_${this.sourceSeq}`;
    const row: PipelineSourceRow = {
      id,
      run_id: input.runId,
      url: input.url,
      final_url: null,
      status: "pending",
      http_status: null,
      content_type: null,
      fetched_at: null,
      title: null,
      publisher: null,
      raw_body_key: null,
      render_text_key: null,
      render_html_key: null,
      render_trace_key: null,
      extract_key: null,
      error: null,
    };
    this.sources.set(id, row);
    return row;
  }

  async updateSource(input: Parameters<PipelineStore["updateSource"]>[0]): Promise<void> {
    const row = this.sources.get(input.sourceId);
    if (!row) return;
    if (input.status !== undefined) row.status = input.status;
    if (input.finalUrl !== undefined) row.final_url = input.finalUrl;
    if (input.httpStatus !== undefined) row.http_status = input.httpStatus;
    if (input.contentType !== undefined) row.content_type = input.contentType;
    if (input.fetchedAt !== undefined) row.fetched_at = input.fetchedAt;
    if (input.title !== undefined) row.title = input.title;
    if (input.publisher !== undefined) row.publisher = input.publisher;
    if (input.rawBodyKey !== undefined) row.raw_body_key = input.rawBodyKey;
    if (input.renderTextKey !== undefined) row.render_text_key = input.renderTextKey;
    if (input.renderHtmlKey !== undefined) row.render_html_key = input.renderHtmlKey;
    if (input.renderTraceKey !== undefined) row.render_trace_key = input.renderTraceKey;
    if (input.extractKey !== undefined) row.extract_key = input.extractKey;
    if (input.error !== undefined) row.error = input.error;
  }

  async addModelCall(): Promise<unknown> {
    return {};
  }

  async addCitation(): Promise<unknown> {
    return {};
  }
}

class QuestionGraphModelProvider implements ModelProvider {
  readonly name = "mock-question-graph";

  constructor(private readonly questionExtraction: unknown) {}

  async chat(req: Parameters<ModelProvider["chat"]>[0]) {
    const user = req.messages.find((m) => m.role === "user")?.content ?? "";

    if (user.includes("Generate a research plan")) {
      return {
        text: JSON.stringify({
          subquestions: [],
          queries: ["example query"],
          followUpTasks: [],
          continuePlanning: false,
        }),
        usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.01 },
        raw: { mock: true },
      };
    }

    if (user.includes("Extract core questions")) {
      return {
        text: JSON.stringify(this.questionExtraction),
        usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.01 },
        raw: { mock: true },
      };
    }

    if (user.includes('"citationPolicy"') && user.includes('"sources"') && user.includes('"targets"')) {
      return {
        text: JSON.stringify({
          summary: "Synthesis summary.",
          keyFindings: [{ id: "F1", text: "Finding.", citations: [] }],
          recommendations: ["Recommendation."],
          unknowns: [],
        }),
        usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.01 },
        raw: { mock: true },
      };
    }

    throw new Error(`Unhandled mock model request: ${user.slice(0, 120)}`);
  }
}

describe("question graph dependency pruning", () => {
  it("transitively prunes overspecified dependencies without flattening the DAG", async () => {
    const runId = "run-question-graph-prune";
    const userId = "user";
    const prompt = "What are the most recent public guidelines on solar panel efficiency?";
    const objectStore = new MemoryObjectStore();
    const checkpoint: RunCheckpoint = {
      version: 1,
      nextPhase: "plan",
      counters: { searchCalls: 0, fetches: 0, renders: 0, modelCalls: 0 },
      artifacts: {},
      debug: { enabled: false },
    };

    const store = new MemoryPipelineStore({
      runId,
      userId,
      prompt,
      budgets: {
        maxRuntimeMs: 30_000,
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
      adapterConfig: { researchLoop: { enabled: false } },
      checkpoint,
    });

    const modelProvider = new QuestionGraphModelProvider({
      questions: [
        { text: "What does DOE say?", dependsOn: [] },
        { text: "What does IEA say?", dependsOn: ["q1"] },
        { text: "What does the EU say?", dependsOn: ["q1", "q2"] },
        { text: "What are common metrics?", dependsOn: ["q1", "q2", "q3"] },
      ],
    });

    const config = OpenResearchConfigSchema.parse({ env: "test" });

    await runResearchPipeline({
      runId,
      config,
      services: {
        store,
        objectStore,
        search: { name: "mock-search", async search() { return []; } },
        httpFetch: { name: "mock-http", async fetch(url: string) { return { ok: false as const, url, status: null, error: "not used" }; } },
        modelProvider,
      },
    });

    expect(store.events.some((e) => e.eventType === "question_graph_diagnostics")).toBe(true);
    expect(store.events.some((e) => e.eventType === "question_graph_dependencies_pruned")).toBe(false);

    const graph = await objectStore.getJson<QuestionGraph>(runArtifactKey(runId, "question-graph.json"));
    expect(graph).not.toBeNull();
    expect(graph?.questions[1]?.dependsOn).toEqual(["q1"]);
    expect(graph?.questions[2]?.dependsOn).toEqual(["q2"]);
    expect(graph?.questions[3]?.dependsOn).toEqual(["q3"]);
    const diagnostics = await objectStore.getJson<{
      prunedEdges: Array<{ from: string; to: string; reason: string }>;
    }>(runArtifactKey(runId, "question-graph-diagnostics.json"));
    expect((diagnostics?.prunedEdges.length ?? 0) > 0).toBe(true);
  });

  it("keeps dependencies when strong dependency cues are present", async () => {
    const runId = "run-question-graph-keep";
    const userId = "user";
    const prompt = "Answer questions that build on each other.";
    const objectStore = new MemoryObjectStore();
    const checkpoint: RunCheckpoint = {
      version: 1,
      nextPhase: "plan",
      counters: { searchCalls: 0, fetches: 0, renders: 0, modelCalls: 0 },
      artifacts: {},
      debug: { enabled: false },
    };

    const store = new MemoryPipelineStore({
      runId,
      userId,
      prompt,
      budgets: {
        maxRuntimeMs: 30_000,
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
      adapterConfig: { researchLoop: { enabled: false } },
      checkpoint,
    });

    const modelProvider = new QuestionGraphModelProvider({
      questions: [
        { text: "Define X.", dependsOn: [] },
        { text: "Based on the answer, derive Y.", dependsOn: ["q1"] },
        { text: "Using that result, compute Z.", dependsOn: ["q2"] },
      ],
    });

    const config = OpenResearchConfigSchema.parse({ env: "test" });

    await runResearchPipeline({
      runId,
      config,
      services: {
        store,
        objectStore,
        search: { name: "mock-search", async search() { return []; } },
        httpFetch: { name: "mock-http", async fetch(url: string) { return { ok: false as const, url, status: null, error: "not used" }; } },
        modelProvider,
      },
    });

    expect(store.events.some((e) => e.eventType === "question_graph_dependencies_pruned")).toBe(
      false
    );

    const graph = await objectStore.getJson<QuestionGraph>(runArtifactKey(runId, "question-graph.json"));
    expect(graph).not.toBeNull();
    expect(graph?.questions.some((q) => q.dependsOn.length > 0)).toBe(true);
  });

  it("infers dependency chains from flat question output with sequence cues", async () => {
    const runId = "run-question-graph-infer";
    const userId = "user";
    const prompt = "Research TechR2 and Meta overlap, then identify contacts and draft outreach.";
    const objectStore = new MemoryObjectStore();
    const checkpoint: RunCheckpoint = {
      version: 1,
      nextPhase: "plan",
      counters: { searchCalls: 0, fetches: 0, renders: 0, modelCalls: 0 },
      artifacts: {},
      debug: { enabled: false },
    };

    const store = new MemoryPipelineStore({
      runId,
      userId,
      prompt,
      budgets: {
        maxRuntimeMs: 30_000,
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
      adapterConfig: { researchLoop: { enabled: false } },
      checkpoint,
    });

    const modelProvider = new QuestionGraphModelProvider({
      questions: [
        { text: "Find out what TechR2 does", dependsOn: [] },
        { text: "Find out what Meta needs", dependsOn: [] },
        { text: "Identify overlaps", dependsOn: [] },
        { text: "Find people at Meta who care", dependsOn: [] },
        { text: "Draft emails to each person", dependsOn: [] },
      ],
    });

    const config = OpenResearchConfigSchema.parse({ env: "test" });

    await runResearchPipeline({
      runId,
      config,
      services: {
        store,
        objectStore,
        search: { name: "mock-search", async search() { return []; } },
        httpFetch: { name: "mock-http", async fetch(url: string) { return { ok: false as const, url, status: null, error: "not used" }; } },
        modelProvider,
      },
    });

    const graph = await objectStore.getJson<QuestionGraph>(runArtifactKey(runId, "question-graph.json"));
    expect(graph).not.toBeNull();
    expect(graph?.questions[0]?.dependsOn).toEqual([]);
    expect(graph?.questions[1]?.dependsOn).toEqual([]);
    expect(graph?.questions[2]?.dependsOn).toEqual(["q1", "q2"]);
    expect(graph?.questions[3]?.dependsOn).toEqual(["q3"]);
    expect(graph?.questions[4]?.dependsOn).toEqual(["q4"]);
    expect(store.events.some((e) => e.eventType === "question_graph_diagnostics")).toBe(true);
    const diagnostics = await objectStore.getJson<{
      inferredEdges: Array<{ from: string; to: string; reason: string }>;
    }>(runArtifactKey(runId, "question-graph-diagnostics.json"));
    expect((diagnostics?.inferredEdges.length ?? 0) > 0).toBe(true);
  });
});
