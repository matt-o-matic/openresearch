import { describe, expect, it } from "vitest";

import type { BudgetConfig, PhaseModelConfig, ResearchLoopConfig, ThinkingMode } from "./config.js";
import type { HttpFetchAdapter, SearchAdapter } from "./adapters.js";
import type { ModelProvider } from "./models.js";
import type { LabeledSource, SynthesisOutput } from "./memo.js";
import type { ObjectStore, PipelineRunRow, PipelineSourceRow, PipelineStore, RunCheckpoint } from "./orchestrator.js";
import {
  iterationCompressionKey,
  iterationGapAnalysisKey,
  iterationGapDiagnosticsKey,
  iterationPlanKey,
  iterationRetrievalKey,
  runPlanKey,
} from "./artifacts.js";
import {
  runResearchLoop,
  type GapAnalysisNormalizationDiagnostics,
  type GapAnalysisOutput,
  type IterationReviewOutput,
  type RetrievalOutput,
  type LoopSteps,
} from "./research-loop.js";

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

  constructor(opts: { runId: string; userId: string; prompt: string; state: RunCheckpoint }) {
    this.runs.set(opts.runId, {
      row: {
        id: opts.runId,
        user_id: opts.userId,
        prompt: opts.prompt,
        status: "running",
        phase: "retrieve",
        citation_policy: "balanced",
        template: "research-memo",
        budgets: {},
        model_config: {},
        adapter_config: {},
        state: deepClone(opts.state),
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

function baseBudgetConfig(overrides?: Partial<BudgetConfig>): BudgetConfig {
  return {
    maxRuntimeMs: 60_000,
    maxSources: 10,
    maxFetches: 20,
    maxBrowserRenders: 0,
    fetchConcurrency: 1,
    extractConcurrency: 1,
    ...overrides,
  };
}

function baseModels(): PhaseModelConfig {
  return {
    planner: "mock/planner",
    synthesizer: "mock/synth",
    verifier: "mock/verify",
    verifierStrong: "mock/verify-strong",
  };
}

function baseLoopConfig(overrides?: Partial<ResearchLoopConfig>): ResearchLoopConfig {
  return {
    enabled: true,
    maxIterations: 5,
    mode: "auto",
    switchToHybridAfterRejects: 2,
    dynamicOutlineEnabled: true,
    ...overrides,
  };
}

function baseCheckpoint(runId: string): RunCheckpoint {
  return {
    version: 1,
    nextPhase: "retrieve",
    counters: {
      searchCalls: 0,
      fetches: 0,
      renders: 0,
      modelCalls: 0,
    },
    artifacts: {
      planKey: runPlanKey(runId),
    },
    debug: {
      enabled: false,
    },
  };
}

function makeStaticServices(input: { store: PipelineStore; objectStore: ObjectStore; modelProvider?: ModelProvider }) {
  const search: SearchAdapter = {
    name: "mock-search",
    async search() {
      return [];
    },
  };
  const httpFetch: HttpFetchAdapter = {
    name: "mock-http",
    async fetch(url: string) {
      return { ok: false as const, url, status: null, error: "not used" };
    },
  };
  return {
    store: input.store,
    objectStore: input.objectStore,
    search,
    httpFetch,
    ...(input.modelProvider ? { modelProvider: input.modelProvider } : {}),
  };
}

function labeledSourcesFromStore(checkpoint: RunCheckpoint, sources: PipelineSourceRow[]): LabeledSource[] {
  const labelMap = (checkpoint.sourceLabels ?? {}) as Record<string, string>;
  let nextLabelIndex = Object.keys(labelMap).length + 1;
  for (const s of sources) {
    if (!labelMap[s.id]) {
      labelMap[s.id] = `S${nextLabelIndex}`;
      nextLabelIndex += 1;
    }
  }
  checkpoint.sourceLabels = labelMap;

  return sources.map((s) => ({
    label: labelMap[s.id] ?? "S?",
    sourceId: s.id,
    url: s.url,
    title: s.title,
    publisher: s.publisher,
    fetchedAt: typeof s.fetched_at === "string" ? s.fetched_at : s.fetched_at ? s.fetched_at.toISOString() : null,
    quotes: [],
  }));
}

function synthesisSnapshot(input: { summary: string; sources: LabeledSource[]; findingId: string }): SynthesisOutput {
  const firstSource = input.sources.at(0);
  return {
    summary: input.summary,
    keyFindings: [
      {
        id: input.findingId,
        text: `Finding ${input.findingId}`,
        citations: firstSource ? [{ source: firstSource.label }] : [],
      },
    ],
    unknowns: [],
  };
}

describe("runResearchLoop", () => {
  const citationPolicy = "balanced" as const;
  const thinkingMode: ThinkingMode = "high";

  it("derives sourcesPerIteration and resolves unanswerable questions after focus cap", async () => {
    const runId = "run-iteration-cap";
    const userId = "user";
    const prompt = "Test prompt";
    const checkpoint = baseCheckpoint(runId);
    const objectStore = new MemoryObjectStore();

    await objectStore.putJson(runPlanKey(runId), { queries: ["q1"] });

    const store = new MemoryPipelineStore({ runId, userId, prompt, state: checkpoint });

    let capturedMaxSelectedUrls = -1;
    let retrieveCalls = 0;

    const modelProvider: ModelProvider = { name: "mock", async chat() { throw new Error("not used"); } };

    const steps: LoopSteps = {
      retrieve: async (input) => {
        retrieveCalls += 1;
        capturedMaxSelectedUrls = input.maxSelectedUrls;
        const selectedUrls = Array.from({ length: input.maxSelectedUrls }, (_, i) => `https://example.com/${i + 1}`);
        const out: RetrievalOutput = { queries: [], selectedUrls };
        return out;
      },
      fetch: async () => {},
      extract: async () => {},
      loadLabeledSources: async (input) => {
        const sources = await input.store.listSources(runId);
        return labeledSourcesFromStore(input.checkpoint, sources);
      },
      synthesize: async (input) => {
        return synthesisSnapshot({ summary: "iteration synthesis", sources: input.sources, findingId: "F1" });
      },
      review: async () => {
        const out: IterationReviewOutput = {
          verdict: "accept",
          unsupportedConclusions: [],
          missingEvidence: [],
          requestedRevisions: [],
        };
        return out;
      },
      callModelJsonLogged: async <T>() => {
        const out: GapAnalysisOutput = { questionUpdates: [], nextQueries: ["q-next"], nextTasks: [], stop: false };
        return out as unknown as T;
      },
    };

    const budgets = baseBudgetConfig({ maxSources: 101 });
    const loopConfig = baseLoopConfig({ maxIterations: 1 });

    const result = await runResearchLoop({
      runId,
      userId,
      prompt,
      citationPolicy,
      budgets,
      models: baseModels(),
      thinkingMode,
      loopConfig,
      deadlineMs: Date.now() + 60_000,
      services: makeStaticServices({ store, objectStore, modelProvider }),
      checkpoint,
      synthesis: {
        maxInputTokens: 120_000,
        maxOutputTokens: 5_000,
        contextWindowTokens: 120_000,
        requestedMaxInputTokens: 120_000,
        requestedMaxOutputTokens: 5_000,
      },
      steps,
    });

    expect(retrieveCalls).toBe(2);
    expect(capturedMaxSelectedUrls).toBe(21);
    expect(result.stopReason).toBe("questions_answered");
    expect(result.mode).toBe("incremental");
    expect(await objectStore.getJson(iterationCompressionKey(runId, 1))).not.toBeNull();
  });

  it("runs compression + gap-analysis without invoking in-loop synthesis writing/review", async () => {
    const runId = "run-no-inline-synthesis";
    const userId = "user";
    const prompt = "Test prompt";
    const checkpoint = baseCheckpoint(runId);
    const objectStore = new MemoryObjectStore();

    await objectStore.putJson(runPlanKey(runId), { queries: ["q1"] });

    const store = new MemoryPipelineStore({ runId, userId, prompt, state: checkpoint });
    const modelProvider: ModelProvider = { name: "mock", async chat() { throw new Error("not used"); } };

    let synthesizeCalls = 0;
    let reviewCalls = 0;
    let gapCalls = 0;
    const steps: LoopSteps = {
      retrieve: async () => {
        const out: RetrievalOutput = { queries: [], selectedUrls: ["https://example.com/inline-synthesis-check"] };
        return out;
      },
      fetch: async () => {},
      extract: async () => {},
      loadLabeledSources: async (input) => {
        const sources = await input.store.listSources(runId);
        return labeledSourcesFromStore(input.checkpoint, sources);
      },
      synthesize: async (input) => {
        synthesizeCalls += 1;
        return synthesisSnapshot({ summary: "should not run", sources: input.sources, findingId: "F1" });
      },
      review: async () => {
        reviewCalls += 1;
        const out: IterationReviewOutput = {
          verdict: "accept",
          unsupportedConclusions: [],
          missingEvidence: [],
          requestedRevisions: [],
        };
        return out;
      },
      callModelJsonLogged: async <T>() => {
        gapCalls += 1;
        const out: GapAnalysisOutput = {
          questionUpdates: [],
          nextQueries: [],
          nextTasks: [],
          stop: true,
          stopReason: "complete",
        };
        return out as unknown as T;
      },
    };

    const result = await runResearchLoop({
      runId,
      userId,
      prompt,
      citationPolicy,
      budgets: baseBudgetConfig({ maxSources: 2 }),
      models: baseModels(),
      thinkingMode,
      loopConfig: baseLoopConfig({ maxIterations: 2 }),
      deadlineMs: Date.now() + 60_000,
      services: makeStaticServices({ store, objectStore, modelProvider }),
      checkpoint,
      synthesis: {
        maxInputTokens: 120_000,
        maxOutputTokens: 5_000,
        contextWindowTokens: 120_000,
        requestedMaxInputTokens: 120_000,
        requestedMaxOutputTokens: 5_000,
      },
      steps,
    });

    expect(result.stopReason).toBe("gap_analysis_stop");
    expect(gapCalls).toBeGreaterThanOrEqual(1);
    expect(synthesizeCalls).toBe(0);
    expect(reviewCalls).toBe(0);
    expect(await objectStore.getJson(iterationCompressionKey(runId, 1))).not.toBeNull();
    expect(await objectStore.getJson(iterationGapAnalysisKey(runId, 1))).not.toBeNull();
  });

  it("stops when gap analysis requests stop and persists a plan version artifact", async () => {
    const runId = "run-gap-stop";
    const userId = "user";
    const prompt = "Test prompt";
    const checkpoint = baseCheckpoint(runId);
    const objectStore = new MemoryObjectStore();

    await objectStore.putJson(runPlanKey(runId), { queries: ["q1"] });

    const store = new MemoryPipelineStore({ runId, userId, prompt, state: checkpoint });
    const modelProvider: ModelProvider = { name: "mock", async chat() { throw new Error("not used"); } };

    const steps: LoopSteps = {
      retrieve: async (input) => {
        const out: RetrievalOutput = { queries: [], selectedUrls: [`https://example.com/${input.maxSelectedUrls}`] };
        return out;
      },
      fetch: async () => {},
      extract: async () => {},
      loadLabeledSources: async (input) => {
        const sources = await input.store.listSources(runId);
        return labeledSourcesFromStore(input.checkpoint, sources);
      },
      synthesize: async (input) => {
        return synthesisSnapshot({ summary: "iteration synthesis", sources: input.sources, findingId: "F1" });
      },
      review: async () => {
        const out: IterationReviewOutput = {
          verdict: "accept",
          unsupportedConclusions: [],
          missingEvidence: [],
          requestedRevisions: [],
        };
        return out;
      },
      callModelJsonLogged: async <T>() => {
        const out: GapAnalysisOutput = {
          questionUpdates: [],
          nextQueries: [],
          nextTasks: [],
          stop: true,
          stopReason: "complete",
        };
        return out as unknown as T;
      },
    };

    const result = await runResearchLoop({
      runId,
      userId,
      prompt,
      citationPolicy,
      budgets: baseBudgetConfig({ maxSources: 10 }),
      models: baseModels(),
      thinkingMode,
      loopConfig: baseLoopConfig({ maxIterations: 5 }),
      deadlineMs: Date.now() + 60_000,
      services: makeStaticServices({ store, objectStore, modelProvider }),
      checkpoint,
      synthesis: {
        maxInputTokens: 120_000,
        maxOutputTokens: 5_000,
        contextWindowTokens: 120_000,
        requestedMaxInputTokens: 120_000,
        requestedMaxOutputTokens: 5_000,
      },
      steps,
    });

    expect(["gap_analysis_stop", "questions_answered"]).toContain(result.stopReason);
    expect(await objectStore.getJson(iterationPlanKey(runId, 1))).not.toBeNull();
  });

  it("uses nextQueries for retrieval and only falls back to normalized nextTasks when queries are empty", async () => {
    const runId = "run-task-fallback-queries";
    const userId = "user";
    const prompt = "Test prompt";
    const checkpoint = baseCheckpoint(runId);
    const objectStore = new MemoryObjectStore();

    await objectStore.putJson(runPlanKey(runId), { queries: ["initial query"] });

    const store = new MemoryPipelineStore({ runId, userId, prompt, state: checkpoint });
    const modelProvider: ModelProvider = { name: "mock", async chat() { throw new Error("not used"); } };

    const retrieveQueriesSeen: string[][] = [];
    let gapCall = 0;
    const steps: LoopSteps = {
      retrieve: async (input) => {
        retrieveQueriesSeen.push([...input.queries]);
        const out: RetrievalOutput = {
          queries: [],
          selectedUrls: [`https://example.com/fallback-${retrieveQueriesSeen.length}`],
        };
        return out;
      },
      fetch: async () => {},
      extract: async () => {},
      loadLabeledSources: async (input) => {
        const sources = await input.store.listSources(runId);
        return labeledSourcesFromStore(input.checkpoint, sources);
      },
      synthesize: async (input) => {
        return synthesisSnapshot({ summary: "iteration synthesis", sources: input.sources, findingId: "F1" });
      },
      review: async () => {
        const out: IterationReviewOutput = {
          verdict: "accept",
          unsupportedConclusions: [],
          missingEvidence: [],
          requestedRevisions: [],
        };
        return out;
      },
      callModelJsonLogged: async <T>() => {
        gapCall += 1;
        const out: GapAnalysisOutput =
          gapCall === 1
            ? {
                questionUpdates: [],
                nextQueries: [],
                nextTasks: ["search renewable energy procurement ohio"],
                stop: false,
              }
            : {
                questionUpdates: [],
                nextQueries: [],
                nextTasks: [],
                stop: true,
                stopReason: "complete",
              };
        return out as unknown as T;
      },
    };

    const result = await runResearchLoop({
      runId,
      userId,
      prompt,
      citationPolicy,
      budgets: baseBudgetConfig({ maxSources: 10 }),
      models: baseModels(),
      thinkingMode,
      loopConfig: baseLoopConfig({ maxIterations: 3 }),
      deadlineMs: Date.now() + 60_000,
      services: makeStaticServices({ store, objectStore, modelProvider }),
      checkpoint,
      synthesis: {
        maxInputTokens: 120_000,
        maxOutputTokens: 5_000,
        contextWindowTokens: 120_000,
        requestedMaxInputTokens: 120_000,
        requestedMaxOutputTokens: 5_000,
      },
      steps,
    });

    expect(["gap_analysis_stop", "questions_answered"]).toContain(result.stopReason);
    expect(retrieveQueriesSeen[0]).toEqual(["initial query"]);
    expect(retrieveQueriesSeen[1]).toEqual(["renewable energy procurement ohio"]);

    const fallbackSelectionEvent = store.events.find(
      (event) =>
        event.eventType === "research_iteration_query_selection" &&
        event.data &&
        typeof event.data === "object" &&
        (event.data as { usedTaskFallback?: unknown }).usedTaskFallback === true
    );
    expect(fallbackSelectionEvent).toBeDefined();
  });

  it("accepts empty gap-analysis stopReason when stop is false and continues", async () => {
    const runId = "run-gap-stop-empty-allowed";
    const userId = "user";
    const prompt = "Test prompt";
    const checkpoint = baseCheckpoint(runId);
    const objectStore = new MemoryObjectStore();

    await objectStore.putJson(runPlanKey(runId), { queries: ["q1"] });

    const store = new MemoryPipelineStore({ runId, userId, prompt, state: checkpoint });
    const modelProvider: ModelProvider = { name: "mock", async chat() { throw new Error("not used"); } };

    let callCount = 0;
    let retrieveCalls = 0;
    const steps: LoopSteps = {
      retrieve: async (input) => {
        retrieveCalls += 1;
        const out: RetrievalOutput = { queries: [], selectedUrls: [`https://example.com/${input.maxSelectedUrls}-${retrieveCalls}`] };
        return out;
      },
      fetch: async () => {},
      extract: async () => {},
      loadLabeledSources: async (input) => {
        const sources = await input.store.listSources(runId);
        return labeledSourcesFromStore(input.checkpoint, sources);
      },
      synthesize: async (input) => {
        return synthesisSnapshot({
          summary: `iteration ${callCount + 1} synthesis`,
          sources: input.sources,
          findingId: `F${callCount}`,
        });
      },
      review: async () => {
        const out: IterationReviewOutput = {
          verdict: "accept",
          unsupportedConclusions: [],
          missingEvidence: [],
          requestedRevisions: [],
        };
        return out;
      },
      callModelJsonLogged: async <T>() => {
        callCount += 1;
        const out: GapAnalysisOutput =
          callCount === 1
            ? { questionUpdates: [], nextQueries: ["q-next"], nextTasks: [], stop: false, stopReason: "" }
            : { questionUpdates: [], nextQueries: [], nextTasks: [], stop: true, stopReason: "complete" };
        return out as unknown as T;
      },
    };

    const result = await runResearchLoop({
      runId,
      userId,
      prompt,
      citationPolicy,
      budgets: baseBudgetConfig({ maxSources: 2 }),
      models: baseModels(),
      thinkingMode,
      loopConfig: baseLoopConfig({ maxIterations: 2 }),
      deadlineMs: Date.now() + 60_000,
      services: makeStaticServices({ store, objectStore, modelProvider }),
      checkpoint,
      synthesis: {
        maxInputTokens: 120_000,
        maxOutputTokens: 5_000,
        contextWindowTokens: 120_000,
        requestedMaxInputTokens: 120_000,
        requestedMaxOutputTokens: 5_000,
      },
      steps,
    });

    expect(result.stopReason).toBe("questions_answered");
    expect(retrieveCalls).toBe(2);
    expect(callCount).toBe(2);
  });

  it("accepts whitespace-only gap-analysis stopReason when stop is false and continues", async () => {
    const runId = "run-gap-stop-whitespace-allowed";
    const userId = "user";
    const prompt = "Test prompt";
    const checkpoint = baseCheckpoint(runId);
    const objectStore = new MemoryObjectStore();

    await objectStore.putJson(runPlanKey(runId), { queries: ["q1"] });

    const store = new MemoryPipelineStore({ runId, userId, prompt, state: checkpoint });
    const modelProvider: ModelProvider = { name: "mock", async chat() { throw new Error("not used"); } };

    let callCount = 0;
    let retrieveCalls = 0;
    const steps: LoopSteps = {
      retrieve: async (input) => {
        retrieveCalls += 1;
        const out: RetrievalOutput = { queries: [], selectedUrls: [`https://example.com/${input.maxSelectedUrls}-${retrieveCalls}`] };
        return out;
      },
      fetch: async () => {},
      extract: async () => {},
      loadLabeledSources: async (input) => {
        const sources = await input.store.listSources(runId);
        return labeledSourcesFromStore(input.checkpoint, sources);
      },
      synthesize: async (input) => {
        return synthesisSnapshot({
          summary: `iteration ${callCount + 1} synthesis`,
          sources: input.sources,
          findingId: `F${callCount}`,
        });
      },
      review: async () => {
        const out: IterationReviewOutput = {
          verdict: "accept",
          unsupportedConclusions: [],
          missingEvidence: [],
          requestedRevisions: [],
        };
        return out;
      },
      callModelJsonLogged: async <T>() => {
        callCount += 1;
        const out: GapAnalysisOutput =
          callCount === 1
            ? { questionUpdates: [], nextQueries: ["q-next"], nextTasks: [], stop: false, stopReason: "   " }
            : { questionUpdates: [], nextQueries: [], nextTasks: [], stop: true, stopReason: "complete" };
        return out as unknown as T;
      },
    };

    const result = await runResearchLoop({
      runId,
      userId,
      prompt,
      citationPolicy,
      budgets: baseBudgetConfig({ maxSources: 2 }),
      models: baseModels(),
      thinkingMode,
      loopConfig: baseLoopConfig({ maxIterations: 2 }),
      deadlineMs: Date.now() + 60_000,
      services: makeStaticServices({ store, objectStore, modelProvider }),
      checkpoint,
      synthesis: {
        maxInputTokens: 120_000,
        maxOutputTokens: 5_000,
        contextWindowTokens: 120_000,
        requestedMaxInputTokens: 120_000,
        requestedMaxOutputTokens: 5_000,
      },
      steps,
    });

    expect(result.stopReason).toBe("questions_answered");
    expect(retrieveCalls).toBe(2);
    expect(callCount).toBe(2);
  });

  it("normalizes gap-analysis schema drift and persists normalization diagnostics", async () => {
    const runId = "run-gap-normalization-diagnostics";
    const userId = "user";
    const prompt = "Test prompt";
    const checkpoint = baseCheckpoint(runId);
    const objectStore = new MemoryObjectStore();

    await objectStore.putJson(runPlanKey(runId), { queries: ["q1"] });

    const store = new MemoryPipelineStore({ runId, userId, prompt, state: checkpoint });
    const modelProvider: ModelProvider = { name: "mock", async chat() { throw new Error("not used"); } };

    let gapCalls = 0;
    const steps: LoopSteps = {
      retrieve: async () => {
        const out: RetrievalOutput = { queries: [], selectedUrls: ["https://example.com/source"] };
        return out;
      },
      fetch: async () => {},
      extract: async () => {},
      loadLabeledSources: async (input) => {
        const sources = await input.store.listSources(runId);
        return labeledSourcesFromStore(input.checkpoint, sources);
      },
      synthesize: async (input) => {
        return synthesisSnapshot({ summary: "iteration synthesis", sources: input.sources, findingId: "F1" });
      },
      review: async () => {
        const out: IterationReviewOutput = {
          verdict: "accept",
          unsupportedConclusions: [],
          missingEvidence: [],
          requestedRevisions: [],
        };
        return out;
      },
      callModelJsonLogged: async <T>() => {
        gapCalls += 1;
        const out = {
          questionUpdates: [
            {
              id: "q1",
              status: "answered",
              evidence: [{ source: "S1", quoteId: "   ", note: "Evidence note" }],
              confidence: 1.4,
            },
          ],
          nextQueries: ["  follow up  ", "", "follow up"],
          nextTasks: ["  task  ", " "],
          planNotes: ["  note  ", "note"],
          stop: false,
          stopReason: "   ",
          outlinePlan: {
            version: 2,
            rationale: "Normalize me",
            sections: [
              {
                id: "summary",
                heading: "Summary",
                intent: "Short overview",
                dependsOnQuestionIds: [],
              },
            ],
            notes: [],
          },
        };
        return out as unknown as T;
      },
    };

    const result = await runResearchLoop({
      runId,
      userId,
      prompt,
      citationPolicy,
      budgets: baseBudgetConfig({ maxSources: 1 }),
      models: baseModels(),
      thinkingMode,
      loopConfig: baseLoopConfig({ maxIterations: 1 }),
      deadlineMs: Date.now() + 60_000,
      services: makeStaticServices({ store, objectStore, modelProvider }),
      checkpoint,
      synthesis: {
        maxInputTokens: 120_000,
        maxOutputTokens: 5_000,
        contextWindowTokens: 120_000,
        requestedMaxInputTokens: 120_000,
        requestedMaxOutputTokens: 5_000,
      },
      steps,
    });

    expect(result.stopReason).toBe("questions_answered");
    expect(gapCalls).toBe(1);

    const gap = await objectStore.getJson<GapAnalysisOutput>(iterationGapAnalysisKey(runId, 1));
    expect(gap).not.toBeNull();
    expect(gap?.outlinePlan?.version).toBe(1);
    expect(gap?.questionUpdates[0]?.confidence).toBe(1);
    expect(gap?.questionUpdates[0]?.evidence[0]?.quoteId).toBeUndefined();
    expect(gap?.nextQueries).toEqual(["follow up"]);
    expect(gap?.nextTasks).toEqual(["task"]);
    expect(gap?.planNotes).toEqual(["note"]);
    expect(gap?.stopReason).toBeUndefined();

    const diagnostics =
      await objectStore.getJson<GapAnalysisNormalizationDiagnostics>(iterationGapDiagnosticsKey(runId, 1));
    expect(diagnostics?.changed).toBe(true);
    expect(diagnostics?.outlineVersionCoerced).toBe(true);
    expect(diagnostics?.dropped.emptyQuoteIds).toBe(1);
    expect(diagnostics?.clampedConfidenceCount).toBe(1);
    expect(diagnostics?.dropped.stopReasonEmpty).toBe(true);
    expect(diagnostics?.fallbackUsed).toBe(false);
    expect(store.events.some((event) => event.eventType === "gap_analysis_normalized")).toBe(true);
  });

  it("uses deterministic gap fallback when gap-analysis call throws", async () => {
    const runId = "run-gap-fallback-on-throw";
    const userId = "user";
    const prompt = "Test prompt";
    const checkpoint = baseCheckpoint(runId);
    const objectStore = new MemoryObjectStore();

    await objectStore.putJson(runPlanKey(runId), { queries: ["q1"] });

    const store = new MemoryPipelineStore({ runId, userId, prompt, state: checkpoint });
    const modelProvider: ModelProvider = { name: "mock", async chat() { throw new Error("not used"); } };

    const steps: LoopSteps = {
      retrieve: async () => {
        const out: RetrievalOutput = { queries: [], selectedUrls: ["https://example.com/source"] };
        return out;
      },
      fetch: async () => {},
      extract: async () => {},
      loadLabeledSources: async (input) => {
        const sources = await input.store.listSources(runId);
        return labeledSourcesFromStore(input.checkpoint, sources);
      },
      synthesize: async (input) => {
        return synthesisSnapshot({ summary: "iteration synthesis", sources: input.sources, findingId: "F1" });
      },
      review: async () => {
        const out: IterationReviewOutput = {
          verdict: "accept",
          unsupportedConclusions: [],
          missingEvidence: [],
          requestedRevisions: [],
        };
        return out;
      },
      callModelJsonLogged: async <T>() => {
        void ({} as T);
        throw new Error("synthetic gap-analysis failure");
      },
    };

    const result = await runResearchLoop({
      runId,
      userId,
      prompt,
      citationPolicy,
      budgets: baseBudgetConfig({ maxSources: 1 }),
      models: baseModels(),
      thinkingMode,
      loopConfig: baseLoopConfig({ maxIterations: 1 }),
      deadlineMs: Date.now() + 60_000,
      services: makeStaticServices({ store, objectStore, modelProvider }),
      checkpoint,
      synthesis: {
        maxInputTokens: 120_000,
        maxOutputTokens: 5_000,
        contextWindowTokens: 120_000,
        requestedMaxInputTokens: 120_000,
        requestedMaxOutputTokens: 5_000,
      },
      steps,
    });

    expect(result.stopReason).toBe("gap_analysis_stop");
    const gap = await objectStore.getJson<GapAnalysisOutput>(iterationGapAnalysisKey(runId, 1));
    expect(gap?.stop).toBe(true);
    expect(gap?.stopReason).toBe("gap_analysis_schema_error");
    const diagnostics =
      await objectStore.getJson<GapAnalysisNormalizationDiagnostics>(iterationGapDiagnosticsKey(runId, 1));
    expect(diagnostics?.fallbackUsed).toBe(true);
    expect(diagnostics?.parseError?.message).toContain("synthetic gap-analysis failure");
    expect(store.events.some((event) => event.eventType === "gap_analysis_fallback_used")).toBe(true);
  });

  it("fails open when stop=true payload has empty stopReason and writes fallback diagnostics", async () => {
    const runId = "run-gap-stop-empty-fallback";
    const userId = "user";
    const prompt = "Test prompt";
    const checkpoint = baseCheckpoint(runId);
    const objectStore = new MemoryObjectStore();

    await objectStore.putJson(runPlanKey(runId), { queries: ["q1"] });

    const store = new MemoryPipelineStore({ runId, userId, prompt, state: checkpoint });
    const modelProvider: ModelProvider = { name: "mock", async chat() { throw new Error("not used"); } };

    const steps: LoopSteps = {
      retrieve: async () => {
        const out: RetrievalOutput = { queries: [], selectedUrls: ["https://example.com/source"] };
        return out;
      },
      fetch: async () => {},
      extract: async () => {},
      loadLabeledSources: async (input) => {
        const sources = await input.store.listSources(runId);
        return labeledSourcesFromStore(input.checkpoint, sources);
      },
      synthesize: async () => {
        return synthesisSnapshot({ summary: "iteration synthesis", sources: [], findingId: "F1" });
      },
      review: async () => {
        const out: IterationReviewOutput = {
          verdict: "accept",
          unsupportedConclusions: [],
          missingEvidence: [],
          requestedRevisions: [],
        };
        return out;
      },
      callModelJsonLogged: async <T>() => {
        const out: GapAnalysisOutput = { questionUpdates: [], nextQueries: [], nextTasks: [], stop: true, stopReason: "" };
        return out as unknown as T;
      },
    };

    const result = await runResearchLoop({
      runId,
      userId,
      prompt,
      citationPolicy,
      budgets: baseBudgetConfig({ maxSources: 10 }),
      models: baseModels(),
      thinkingMode,
      loopConfig: baseLoopConfig({ maxIterations: 1 }),
      deadlineMs: Date.now() + 60_000,
      services: makeStaticServices({ store, objectStore, modelProvider }),
      checkpoint,
      synthesis: {
        maxInputTokens: 120_000,
        maxOutputTokens: 5_000,
        contextWindowTokens: 120_000,
        requestedMaxInputTokens: 120_000,
        requestedMaxOutputTokens: 5_000,
      },
      steps,
    });

    expect(result.stopReason).toBe("gap_analysis_stop");
    const gap = await objectStore.getJson<GapAnalysisOutput>(iterationGapAnalysisKey(runId, 1));
    expect(gap?.stop).toBe(true);
    expect(gap?.stopReason).toBe("gap_analysis_schema_error");
    expect((gap?.planNotes ?? [])[0]).toContain("Gap analysis failed schema validation");

    const diagnostics =
      await objectStore.getJson<GapAnalysisNormalizationDiagnostics>(iterationGapDiagnosticsKey(runId, 1));
    expect(diagnostics?.fallbackUsed).toBe(true);
    expect(diagnostics?.parseError?.message).toContain("stopReason is required when stop is true");
    expect(store.events.some((event) => event.eventType === "gap_analysis_fallback_used")).toBe(true);
  });

  it("skips fetch/extract when retrieval yields zero URLs and still runs gap analysis stop", async () => {
    const runId = "run-no-new-sources";
    const userId = "user";
    const prompt = "Test prompt";
    const checkpoint = baseCheckpoint(runId);
    const objectStore = new MemoryObjectStore();

    await objectStore.putJson(runPlanKey(runId), { queries: ["q1"] });

    const store = new MemoryPipelineStore({ runId, userId, prompt, state: checkpoint });
    const modelProvider: ModelProvider = { name: "mock", async chat() { throw new Error("not used"); } };

    let fetchCalls = 0;
    let extractCalls = 0;

    const steps: LoopSteps = {
      retrieve: async () => {
        const out: RetrievalOutput = { queries: [], selectedUrls: [] };
        return out;
      },
      fetch: async () => {
        fetchCalls += 1;
      },
      extract: async () => {
        extractCalls += 1;
      },
      loadLabeledSources: async (input) => {
        const sources = await input.store.listSources(runId);
        return labeledSourcesFromStore(input.checkpoint, sources);
      },
      synthesize: async (input) => {
        return synthesisSnapshot({ summary: "fallback synthesis", sources: input.sources, findingId: "F1" });
      },
      review: async () => {
        const out: IterationReviewOutput = {
          verdict: "accept",
          unsupportedConclusions: [],
          missingEvidence: [],
          requestedRevisions: [],
        };
        return out;
      },
      callModelJsonLogged: async <T>() => {
        const out: GapAnalysisOutput = {
          questionUpdates: [],
          nextQueries: [],
          nextTasks: [],
          stop: true,
          stopReason: "complete",
        };
        return out as unknown as T;
      },
    };

    const result = await runResearchLoop({
      runId,
      userId,
      prompt,
      citationPolicy,
      budgets: baseBudgetConfig({ maxSources: 10 }),
      models: baseModels(),
      thinkingMode,
      loopConfig: baseLoopConfig({ maxIterations: 5 }),
      deadlineMs: Date.now() + 60_000,
      services: makeStaticServices({ store, objectStore, modelProvider }),
      checkpoint,
      synthesis: {
        maxInputTokens: 120_000,
        maxOutputTokens: 5_000,
        contextWindowTokens: 120_000,
        requestedMaxInputTokens: 120_000,
        requestedMaxOutputTokens: 5_000,
      },
      steps,
    });

    expect(result.stopReason).toBe("gap_analysis_stop");
    expect(fetchCalls).toBe(0);
    expect(extractCalls).toBe(0);
  });

  it("marks open questions unanswerable after focus cap (instead of diminishing_returns)", async () => {
    const runId = "run-diminishing-returns";
    const userId = "user";
    const prompt = "Test prompt";
    const checkpoint = baseCheckpoint(runId);
    const objectStore = new MemoryObjectStore();

    await objectStore.putJson(runPlanKey(runId), { queries: ["q1"] });

    const store = new MemoryPipelineStore({ runId, userId, prompt, state: checkpoint });
    const modelProvider: ModelProvider = { name: "mock", async chat() { throw new Error("not used"); } };

    let retrieveCall = 0;
    let gapCall = 0;

    const steps: LoopSteps = {
      retrieve: async () => {
        retrieveCall += 1;
        const out: RetrievalOutput = {
          queries: [],
          selectedUrls: [`https://example.com/diminish-${retrieveCall}`],
        };
        return out;
      },
      fetch: async () => {},
      extract: async () => {},
      loadLabeledSources: async (input) => {
        const sources = await input.store.listSources(runId);
        return labeledSourcesFromStore(input.checkpoint, sources);
      },
      synthesize: async (input) => {
        return synthesisSnapshot({
          summary: "iteration synthesis",
          sources: input.sources,
          findingId: `F${retrieveCall}`,
        });
      },
      review: async () => {
        const out: IterationReviewOutput = {
          verdict: "accept",
          unsupportedConclusions: [],
          missingEvidence: [],
          requestedRevisions: [],
        };
        return out;
      },
      callModelJsonLogged: async <T>() => {
        gapCall += 1;
        const out: GapAnalysisOutput =
          gapCall === 1
            ? { questionUpdates: [], nextQueries: ["q2"], nextTasks: [], stop: false }
            : { questionUpdates: [], nextQueries: [], nextTasks: [], stop: false };
        return out as unknown as T;
      },
    };

    const result = await runResearchLoop({
      runId,
      userId,
      prompt,
      citationPolicy,
      budgets: baseBudgetConfig({ maxSources: 10 }),
      models: baseModels(),
      thinkingMode,
      loopConfig: baseLoopConfig({ maxIterations: 5 }),
      deadlineMs: Date.now() + 60_000,
      services: makeStaticServices({ store, objectStore, modelProvider }),
      checkpoint,
      synthesis: {
        maxInputTokens: 120_000,
        maxOutputTokens: 5_000,
        contextWindowTokens: 120_000,
        requestedMaxInputTokens: 120_000,
        requestedMaxOutputTokens: 5_000,
      },
      steps,
    });

    expect(result.stopReason).toBe("questions_answered");
    expect(checkpoint.researchLoop?.iterationCountCompleted).toBe(2);
    expect(checkpoint.questionGraph?.questions.find((q) => q.id === "q1")?.status).toBe("unanswerable");
    const capEvent = store.events.find((event) => event.eventType === "question_marked_unanswerable");
    expect(capEvent).toBeDefined();
    const capEventData = capEvent?.data as
      | {
          reason?: string;
          reasons?: {
            focus_round_cap_low_confidence?: number;
            focus_round_cap_missing_source_evidence?: number;
          };
          questions?: Array<{ id: string; reason: string }>;
        }
      | undefined;
    expect(capEventData?.reason).toBe("focus_round_cap_low_confidence");
    expect(capEventData?.reasons?.focus_round_cap_low_confidence).toBe(1);
    expect(capEventData?.questions?.[0]?.id).toBe("q1");
    expect(capEventData?.questions?.[0]?.reason).toBe("focus_round_cap_low_confidence");
  });

  it("marks focus-capped questions answered when confidence >= 0.5 and source-backed evidence exists", async () => {
    const runId = "run-focus-cap-answered";
    const userId = "user";
    const prompt = "Test prompt";
    const checkpoint = baseCheckpoint(runId);
    const objectStore = new MemoryObjectStore();

    await objectStore.putJson(runPlanKey(runId), { queries: ["q1"] });

    const store = new MemoryPipelineStore({ runId, userId, prompt, state: checkpoint });
    const modelProvider: ModelProvider = { name: "mock", async chat() { throw new Error("not used"); } };

    let retrieveCalls = 0;
    let gapCalls = 0;

    const steps: LoopSteps = {
      retrieve: async () => {
        retrieveCalls += 1;
        const out: RetrievalOutput = {
          queries: [],
          selectedUrls: [`https://example.com/focus-cap-answered-${retrieveCalls}`],
        };
        return out;
      },
      fetch: async () => {},
      extract: async () => {},
      loadLabeledSources: async (input) => {
        const sources = await input.store.listSources(runId);
        return labeledSourcesFromStore(input.checkpoint, sources);
      },
      synthesize: async (input) => {
        return synthesisSnapshot({
          summary: "iteration synthesis",
          sources: input.sources,
          findingId: `F${retrieveCalls}`,
        });
      },
      review: async () => {
        const out: IterationReviewOutput = {
          verdict: "accept",
          unsupportedConclusions: [],
          missingEvidence: [],
          requestedRevisions: [],
        };
        return out;
      },
      callModelJsonLogged: async <T>() => {
        gapCalls += 1;
        const out: GapAnalysisOutput =
          gapCalls === 1
            ? {
                questionUpdates: [
                  {
                    id: "q1",
                    status: "partial",
                    confidence: 0.7,
                    evidence: [{ source: "S1", note: "supported evidence" }],
                  },
                ],
                nextQueries: ["q-follow-up"],
                nextTasks: [],
                stop: false,
              }
            : { questionUpdates: [], nextQueries: [], nextTasks: [], stop: false };
        return out as unknown as T;
      },
    };

    const result = await runResearchLoop({
      runId,
      userId,
      prompt,
      citationPolicy,
      budgets: baseBudgetConfig({ maxSources: 10 }),
      models: baseModels(),
      thinkingMode,
      loopConfig: baseLoopConfig({ maxIterations: 5 }),
      deadlineMs: Date.now() + 60_000,
      services: makeStaticServices({ store, objectStore, modelProvider }),
      checkpoint,
      synthesis: {
        maxInputTokens: 120_000,
        maxOutputTokens: 5_000,
        contextWindowTokens: 120_000,
        requestedMaxInputTokens: 120_000,
        requestedMaxOutputTokens: 5_000,
      },
      steps,
    });

    expect(result.stopReason).toBe("questions_answered");
    expect(retrieveCalls).toBe(2);
    expect(checkpoint.researchLoop?.iterationCountCompleted).toBe(2);
    expect(checkpoint.questionGraph?.questions.find((q) => q.id === "q1")?.status).toBe("answered");
    expect(checkpoint.questionGraph?.questions.find((q) => q.id === "q1")?.updatedAtIteration).toBe(2);

    const answeredEvent = store.events.find(
      (event) => event.eventType === "question_marked_answered_after_focus_cap"
    );
    expect(answeredEvent).toBeDefined();
    const answeredEventData = answeredEvent?.data as
      | {
          reason?: string;
          questions?: Array<{ id: string; hasSourceEvidence: boolean; reason: string }>;
        }
      | undefined;
    expect(answeredEventData?.reason).toBe("focus_round_cap_confident_with_source");
    expect(answeredEventData?.questions?.[0]?.id).toBe("q1");
    expect(answeredEventData?.questions?.[0]?.hasSourceEvidence).toBe(true);
    expect(answeredEventData?.questions?.[0]?.reason).toBe("focus_round_cap_confident_with_source");
    expect(store.events.some((event) => event.eventType === "question_marked_unanswerable")).toBe(false);
  });

  it("marks focus-capped questions unanswerable when confidence >= 0.5 but source-backed evidence is missing", async () => {
    const runId = "run-focus-cap-missing-source-evidence";
    const userId = "user";
    const prompt = "Test prompt";
    const checkpoint = baseCheckpoint(runId);
    const objectStore = new MemoryObjectStore();

    await objectStore.putJson(runPlanKey(runId), { queries: ["q1"] });

    const store = new MemoryPipelineStore({ runId, userId, prompt, state: checkpoint });
    const modelProvider: ModelProvider = { name: "mock", async chat() { throw new Error("not used"); } };

    let retrieveCalls = 0;
    let gapCalls = 0;

    const steps: LoopSteps = {
      retrieve: async () => {
        retrieveCalls += 1;
        const out: RetrievalOutput = {
          queries: [],
          selectedUrls: [`https://example.com/focus-cap-missing-source-${retrieveCalls}`],
        };
        return out;
      },
      fetch: async () => {},
      extract: async () => {},
      loadLabeledSources: async (input) => {
        const sources = await input.store.listSources(runId);
        return labeledSourcesFromStore(input.checkpoint, sources);
      },
      synthesize: async (input) => {
        return synthesisSnapshot({
          summary: "iteration synthesis",
          sources: input.sources,
          findingId: `F${retrieveCalls}`,
        });
      },
      review: async () => {
        const out: IterationReviewOutput = {
          verdict: "accept",
          unsupportedConclusions: [],
          missingEvidence: [],
          requestedRevisions: [],
        };
        return out;
      },
      callModelJsonLogged: async <T>() => {
        gapCalls += 1;
        const out: GapAnalysisOutput =
          gapCalls === 1
            ? {
                questionUpdates: [
                  {
                    id: "q1",
                    status: "partial",
                    confidence: 0.7,
                    evidence: [{ note: "confidence present but no source label" }],
                  },
                ],
                nextQueries: ["q-follow-up"],
                nextTasks: [],
                stop: false,
              }
            : { questionUpdates: [], nextQueries: [], nextTasks: [], stop: false };
        return out as unknown as T;
      },
    };

    const result = await runResearchLoop({
      runId,
      userId,
      prompt,
      citationPolicy,
      budgets: baseBudgetConfig({ maxSources: 10 }),
      models: baseModels(),
      thinkingMode,
      loopConfig: baseLoopConfig({ maxIterations: 5 }),
      deadlineMs: Date.now() + 60_000,
      services: makeStaticServices({ store, objectStore, modelProvider }),
      checkpoint,
      synthesis: {
        maxInputTokens: 120_000,
        maxOutputTokens: 5_000,
        contextWindowTokens: 120_000,
        requestedMaxInputTokens: 120_000,
        requestedMaxOutputTokens: 5_000,
      },
      steps,
    });

    expect(result.stopReason).toBe("questions_answered");
    expect(retrieveCalls).toBe(2);
    expect(checkpoint.researchLoop?.iterationCountCompleted).toBe(2);
    expect(checkpoint.questionGraph?.questions.find((q) => q.id === "q1")?.status).toBe("unanswerable");
    expect(checkpoint.questionGraph?.questions.find((q) => q.id === "q1")?.updatedAtIteration).toBe(2);

    const unanswerableEvent = store.events.find(
      (event) => event.eventType === "question_marked_unanswerable"
    );
    expect(unanswerableEvent).toBeDefined();
    const unanswerableEventData = unanswerableEvent?.data as
      | {
          reason?: string;
          reasons?: {
            focus_round_cap_low_confidence?: number;
            focus_round_cap_missing_source_evidence?: number;
          };
          questions?: Array<{ id: string; hasSourceEvidence: boolean; reason: string }>;
        }
      | undefined;
    expect(unanswerableEventData?.reason).toBe("focus_round_cap_missing_source_evidence");
    expect(unanswerableEventData?.reasons?.focus_round_cap_low_confidence).toBe(0);
    expect(unanswerableEventData?.reasons?.focus_round_cap_missing_source_evidence).toBe(1);
    expect(unanswerableEventData?.questions?.[0]?.id).toBe("q1");
    expect(unanswerableEventData?.questions?.[0]?.hasSourceEvidence).toBe(false);
    expect(unanswerableEventData?.questions?.[0]?.reason).toBe(
      "focus_round_cap_missing_source_evidence"
    );
    expect(store.events.some((event) => event.eventType === "question_marked_answered_after_focus_cap")).toBe(
      false
    );
  });

  it("unblocks dependent questions after focus-cap auto-answer and progresses downstream", async () => {
    const runId = "run-focus-cap-dependency-progression";
    const userId = "user";
    const prompt = "Test prompt";
    const checkpoint = baseCheckpoint(runId);
    checkpoint.questionGraph = {
      validated: true,
      questions: [
        { id: "q1", text: "Question 1", dependsOn: [], status: "unanswered", evidence: [] },
        { id: "q2", text: "Question 2", dependsOn: ["q1"], status: "unanswered", evidence: [] },
      ],
    };
    const objectStore = new MemoryObjectStore();

    await objectStore.putJson(runPlanKey(runId), { queries: ["q1"] });

    const store = new MemoryPipelineStore({ runId, userId, prompt, state: checkpoint });
    const modelProvider: ModelProvider = { name: "mock", async chat() { throw new Error("not used"); } };

    let retrieveCalls = 0;
    let gapCalls = 0;

    const steps: LoopSteps = {
      retrieve: async () => {
        retrieveCalls += 1;
        const out: RetrievalOutput = {
          queries: [],
          selectedUrls: [`https://example.com/focus-cap-deps-${retrieveCalls}`],
        };
        return out;
      },
      fetch: async () => {},
      extract: async () => {},
      loadLabeledSources: async (input) => {
        const sources = await input.store.listSources(runId);
        return labeledSourcesFromStore(input.checkpoint, sources);
      },
      synthesize: async (input) => {
        return synthesisSnapshot({
          summary: "iteration synthesis",
          sources: input.sources,
          findingId: `F${retrieveCalls}`,
        });
      },
      review: async () => {
        const out: IterationReviewOutput = {
          verdict: "accept",
          unsupportedConclusions: [],
          missingEvidence: [],
          requestedRevisions: [],
        };
        return out;
      },
      callModelJsonLogged: async <T>() => {
        gapCalls += 1;
        if (gapCalls === 1) {
          const out: GapAnalysisOutput = {
            questionUpdates: [
              {
                id: "q1",
                status: "partial",
                confidence: 0.7,
                evidence: [{ source: "S1", note: "support q1" }],
              },
            ],
            nextQueries: ["q2-follow-up"],
            nextTasks: [],
            stop: false,
          };
          return out as unknown as T;
        }

        if (gapCalls === 2) {
          const out: GapAnalysisOutput = {
            questionUpdates: [{ id: "q2", status: "answered", evidence: [{ source: "S2" }] }],
            nextQueries: ["q2-follow-up-2"],
            nextTasks: [],
            stop: false,
          };
          return out as unknown as T;
        }

        const out: GapAnalysisOutput = {
          questionUpdates: [{ id: "q2", status: "answered", evidence: [{ source: "S2" }] }],
          nextQueries: [],
          nextTasks: [],
          stop: false,
        };
        return out as unknown as T;
      },
    };

    const result = await runResearchLoop({
      runId,
      userId,
      prompt,
      citationPolicy,
      budgets: baseBudgetConfig({ maxSources: 10 }),
      models: baseModels(),
      thinkingMode,
      loopConfig: baseLoopConfig({ maxIterations: 5 }),
      deadlineMs: Date.now() + 60_000,
      services: makeStaticServices({ store, objectStore, modelProvider }),
      checkpoint,
      synthesis: {
        maxInputTokens: 120_000,
        maxOutputTokens: 5_000,
        contextWindowTokens: 120_000,
        requestedMaxInputTokens: 120_000,
        requestedMaxOutputTokens: 5_000,
      },
      steps,
    });

    expect(result.stopReason).toBe("questions_answered");
    expect(retrieveCalls).toBe(3);
    expect(checkpoint.questionGraph?.questions.find((q) => q.id === "q1")?.status).toBe("answered");
    expect(checkpoint.questionGraph?.questions.find((q) => q.id === "q1")?.updatedAtIteration).toBe(2);
    expect(checkpoint.questionGraph?.questions.find((q) => q.id === "q2")?.status).toBe("answered");
    expect(checkpoint.questionGraph?.questions.find((q) => q.id === "q2")?.updatedAtIteration).toBe(3);
  });

  it("stops with budget_exhausted when no source headroom remains", async () => {
    const runId = "run-budget-exhausted";
    const userId = "user";
    const prompt = "Test prompt";
    const checkpoint = baseCheckpoint(runId);
    const objectStore = new MemoryObjectStore();

    await objectStore.putJson(runPlanKey(runId), { queries: ["q1"] });

    const store = new MemoryPipelineStore({ runId, userId, prompt, state: checkpoint });
    await store.createSource({ runId, url: "https://example.com/existing" });

    const modelProvider: ModelProvider = { name: "mock", async chat() { throw new Error("not used"); } };
    let retrieveCalls = 0;

    const steps: LoopSteps = {
      retrieve: async () => {
        retrieveCalls += 1;
        const out: RetrievalOutput = { queries: [], selectedUrls: ["https://example.com/new"] };
        return out;
      },
      fetch: async () => {},
      extract: async () => {},
      loadLabeledSources: async (input) => {
        const sources = await input.store.listSources(runId);
        return labeledSourcesFromStore(input.checkpoint, sources);
      },
      synthesize: async (input) => {
        return synthesisSnapshot({ summary: "fallback synthesis", sources: input.sources, findingId: "F1" });
      },
      review: async () => {
        const out: IterationReviewOutput = {
          verdict: "accept",
          unsupportedConclusions: [],
          missingEvidence: [],
          requestedRevisions: [],
        };
        return out;
      },
      callModelJsonLogged: async <T>() => {
        const out: GapAnalysisOutput = {
          questionUpdates: [],
          nextQueries: [],
          nextTasks: [],
          stop: true,
          stopReason: "complete",
        };
        return out as unknown as T;
      },
    };

    const result = await runResearchLoop({
      runId,
      userId,
      prompt,
      citationPolicy,
      budgets: baseBudgetConfig({ maxSources: 1 }),
      models: baseModels(),
      thinkingMode,
      loopConfig: baseLoopConfig({ maxIterations: 5 }),
      deadlineMs: Date.now() + 60_000,
      services: makeStaticServices({ store, objectStore, modelProvider }),
      checkpoint,
      synthesis: {
        maxInputTokens: 120_000,
        maxOutputTokens: 5_000,
        contextWindowTokens: 120_000,
        requestedMaxInputTokens: 120_000,
        requestedMaxOutputTokens: 5_000,
      },
      steps,
    });

    expect(result.stopReason).toBe("budget_exhausted");
    expect(retrieveCalls).toBe(0);
  });

  it("keeps incremental mode and persists compression snapshots across iterations", async () => {
    const runId = "run-mode-switch";
    const userId = "user";
    const prompt = "Test prompt";
    const checkpoint = baseCheckpoint(runId);
    checkpoint.questionGraph = {
      validated: true,
      questions: [
        { id: "q1", text: "Question 1", dependsOn: [], status: "unanswered", evidence: [] },
        { id: "q2", text: "Question 2", dependsOn: ["q1"], status: "unanswered", evidence: [] },
      ],
    };
    const objectStore = new MemoryObjectStore();

    await objectStore.putJson(runPlanKey(runId), { queries: ["q1"] });

    const store = new MemoryPipelineStore({ runId, userId, prompt, state: checkpoint });
    const modelProvider: ModelProvider = { name: "mock", async chat() { throw new Error("not used"); } };

    const retrieveSeenSizes: number[] = [];
    const reviewModels: string[] = [];

    let retrieveCall = 0;
    let reviewCall = 0;
    let gapCall = 0;

    const steps: LoopSteps = {
      retrieve: async (input) => {
        retrieveCall += 1;
        retrieveSeenSizes.push(input.seenUrls.size);
        const url = `https://example.com/src-${retrieveCall}`;
        const out: RetrievalOutput = { queries: [], selectedUrls: [url] };
        return out;
      },
      fetch: async () => {},
      extract: async () => {},
      loadLabeledSources: async (input) => {
        const sources = await input.store.listSources(runId);
        return labeledSourcesFromStore(input.checkpoint, sources);
      },
      review: async (input) => {
        reviewCall += 1;
        reviewModels.push(input.model);
        const verdicts: Array<IterationReviewOutput["verdict"]> = ["reject", "accept", "reject", "accept", "accept"];
        const out: IterationReviewOutput = {
          verdict: verdicts[reviewCall - 1] ?? "accept",
          unsupportedConclusions: [],
          missingEvidence: [],
          requestedRevisions: [],
        };
        return out;
      },
      callModelJsonLogged: async <T>() => {
        gapCall += 1;
        const out: GapAnalysisOutput = {
          questionUpdates: [],
          nextQueries: [`q${gapCall + 1}`],
          nextTasks: [],
          stop: false,
        };
        return out as unknown as T;
      },
    };

    const result = await runResearchLoop({
      runId,
      userId,
      prompt,
      citationPolicy,
      budgets: baseBudgetConfig({ maxSources: 4 }),
      models: baseModels(),
      thinkingMode,
      loopConfig: baseLoopConfig({ maxIterations: 4, mode: "auto", switchToHybridAfterRejects: 2 }),
      deadlineMs: Date.now() + 60_000,
      services: makeStaticServices({ store, objectStore, modelProvider }),
      checkpoint,
      synthesis: {
        maxInputTokens: 120_000,
        maxOutputTokens: 5_000,
        contextWindowTokens: 120_000,
        requestedMaxInputTokens: 120_000,
        requestedMaxOutputTokens: 5_000,
      },
      steps,
    });

    expect(result.mode).toBe("incremental");
    expect(reviewModels).toEqual([]);

    expect(checkpoint.researchLoop).toBeDefined();
    const loopState = checkpoint.researchLoop as NonNullable<RunCheckpoint["researchLoop"]>;
    expect(loopState.mode).toBe("incremental");
    expect(await objectStore.getJson(iterationCompressionKey(runId, 1))).not.toBeNull();
    expect(await objectStore.getJson(iterationCompressionKey(runId, 2))).not.toBeNull();
    expect(await objectStore.getJson(iterationCompressionKey(runId, 3))).not.toBeNull();
    expect(await objectStore.getJson(iterationCompressionKey(runId, 4))).not.toBeNull();

    expect(retrieveSeenSizes[0]).toBe(0);
    expect(retrieveSeenSizes[1]).toBeGreaterThan(0);
  });

  it("resumes an in-progress iteration using cached retrieval artifacts without duplicating sources", async () => {
    const runId = "run-resume";
    const userId = "user";
    const prompt = "Test prompt";
    const checkpoint = baseCheckpoint(runId);
    const objectStore = new MemoryObjectStore();

    await objectStore.putJson(runPlanKey(runId), { queries: ["q1"] });

    const store = new MemoryPipelineStore({ runId, userId, prompt, state: checkpoint });
    const modelProvider: ModelProvider = { name: "mock", async chat() { throw new Error("not used"); } };

    let retrieveCalls = 0;
    let createSourceCalls = 0;
    let fetchCalls = 0;
    let shouldThrowFetch = true;

    const steps: LoopSteps = {
      retrieve: async () => {
        retrieveCalls += 1;
        const out: RetrievalOutput = { queries: [], selectedUrls: ["https://example.com/resume-1"] };
        return out;
      },
      fetch: async () => {
        fetchCalls += 1;
        if (shouldThrowFetch) {
          shouldThrowFetch = false;
          throw new Error("simulated crash");
        }
      },
      extract: async () => {},
      loadLabeledSources: async (input) => {
        const sources = await input.store.listSources(runId);
        return labeledSourcesFromStore(input.checkpoint, sources);
      },
      synthesize: async (input) => {
        return synthesisSnapshot({ summary: "iteration synthesis", sources: input.sources, findingId: "F1" });
      },
      review: async () => {
        const out: IterationReviewOutput = {
          verdict: "accept",
          unsupportedConclusions: [],
          missingEvidence: [],
          requestedRevisions: [],
        };
        return out;
      },
      callModelJsonLogged: async <T>() => {
        const out: GapAnalysisOutput = { questionUpdates: [], nextQueries: [], nextTasks: [], stop: true, stopReason: "complete" };
        return out as unknown as T;
      },
    };

    const budgets = baseBudgetConfig({ maxSources: 2 });
    const loopConfig = baseLoopConfig({ maxIterations: 1 });

    const originalCreateSource = store.createSource.bind(store);
    store.createSource = async (input) => {
      createSourceCalls += 1;
      return originalCreateSource(input);
    };

    await expect(
      runResearchLoop({
        runId,
        userId,
        prompt,
        citationPolicy,
        budgets,
        models: baseModels(),
        thinkingMode,
        loopConfig,
        deadlineMs: Date.now() + 60_000,
        services: makeStaticServices({ store, objectStore, modelProvider }),
        checkpoint,
        synthesis: {
          maxInputTokens: 120_000,
          maxOutputTokens: 5_000,
          contextWindowTokens: 120_000,
          requestedMaxInputTokens: 120_000,
          requestedMaxOutputTokens: 5_000,
        },
        steps,
      })
    ).rejects.toThrow("simulated crash");

    expect(retrieveCalls).toBe(1);
    expect(createSourceCalls).toBe(1);
    expect(await objectStore.getJson(iterationRetrievalKey(runId, 1))).not.toBeNull();

    const resumedCheckpoint = deepClone(checkpoint);
    const result = await runResearchLoop({
      runId,
      userId,
      prompt,
      citationPolicy,
      budgets,
      models: baseModels(),
      thinkingMode,
      loopConfig,
      deadlineMs: Date.now() + 60_000,
      services: makeStaticServices({ store, objectStore, modelProvider }),
      checkpoint: resumedCheckpoint,
      synthesis: {
        maxInputTokens: 120_000,
        maxOutputTokens: 5_000,
        contextWindowTokens: 120_000,
        requestedMaxInputTokens: 120_000,
        requestedMaxOutputTokens: 5_000,
      },
      steps,
    });

    expect(result.stopReason).toBe("gap_analysis_stop");
    expect(retrieveCalls).toBe(1);
    expect(createSourceCalls).toBe(1);
    expect(fetchCalls).toBe(2);
  });

  it("stops with questions_answered when all questions are answered with evidence", async () => {
    const runId = "run-questions-answered";
    const userId = "user";
    const prompt = "Test prompt";
    const checkpoint = baseCheckpoint(runId);
    checkpoint.questionGraph = {
      validated: true,
      questions: [
        { id: "q1", text: "Question 1", dependsOn: [], status: "unanswered", evidence: [] },
        { id: "q2", text: "Question 2", dependsOn: [], status: "unanswered", evidence: [] },
      ],
    };
    const objectStore = new MemoryObjectStore();

    await objectStore.putJson(runPlanKey(runId), { queries: ["q1"] });

    const store = new MemoryPipelineStore({ runId, userId, prompt, state: checkpoint });
    const modelProvider: ModelProvider = { name: "mock", async chat() { throw new Error("not used"); } };

    let gapCalls = 0;

    const steps: LoopSteps = {
      retrieve: async () => {
        const out: RetrievalOutput = { queries: [], selectedUrls: ["https://example.com/src-1"] };
        return out;
      },
      fetch: async () => {},
      extract: async () => {},
      loadLabeledSources: async (input) => {
        const sources = await input.store.listSources(runId);
        return labeledSourcesFromStore(input.checkpoint, sources);
      },
      synthesize: async (input) => {
        return synthesisSnapshot({ summary: "iteration synthesis", sources: input.sources, findingId: "F1" });
      },
      review: async () => {
        const out: IterationReviewOutput = {
          verdict: "accept",
          unsupportedConclusions: [],
          missingEvidence: [],
          requestedRevisions: [],
        };
        return out;
      },
      callModelJsonLogged: async <T>() => {
        gapCalls += 1;
        const out: GapAnalysisOutput = {
          questionUpdates: [
            { id: "q1", status: "answered", evidence: [{ source: "S1" }] },
            { id: "q2", status: "answered", evidence: [{ source: "S1" }] },
          ],
          nextQueries: ["should be ignored"],
          nextTasks: [],
          stop: false,
        };
        return out as unknown as T;
      },
    };

    const result = await runResearchLoop({
      runId,
      userId,
      prompt,
      citationPolicy,
      budgets: baseBudgetConfig({ maxSources: 10 }),
      models: baseModels(),
      thinkingMode,
      loopConfig: baseLoopConfig({ maxIterations: 5 }),
      deadlineMs: Date.now() + 60_000,
      services: makeStaticServices({ store, objectStore, modelProvider }),
      checkpoint,
      synthesis: {
        maxInputTokens: 120_000,
        maxOutputTokens: 5_000,
        contextWindowTokens: 120_000,
        requestedMaxInputTokens: 120_000,
        requestedMaxOutputTokens: 5_000,
      },
      steps,
    });

    expect(result.stopReason).toBe("questions_answered");
    expect(gapCalls).toBe(1);
    expect(checkpoint.questionGraph?.questions.every((q) => q.status === "answered")).toBe(true);
  });

  it("respects question dependencies and unlocks answers across iterations", async () => {
    const runId = "run-question-deps";
    const userId = "user";
    const prompt = "Test prompt";
    const checkpoint = baseCheckpoint(runId);
    checkpoint.questionGraph = {
      validated: true,
      questions: [
        { id: "q1", text: "Question 1", dependsOn: [], status: "unanswered", evidence: [] },
        { id: "q2", text: "Question 2", dependsOn: ["q1"], status: "unanswered", evidence: [] },
      ],
    };
    const objectStore = new MemoryObjectStore();

    await objectStore.putJson(runPlanKey(runId), { queries: ["q1"] });

    const store = new MemoryPipelineStore({ runId, userId, prompt, state: checkpoint });
    const modelProvider: ModelProvider = { name: "mock", async chat() { throw new Error("not used"); } };

    let retrieveCalls = 0;
    let gapCalls = 0;

    const steps: LoopSteps = {
      retrieve: async () => {
        retrieveCalls += 1;
        const out: RetrievalOutput = {
          queries: [],
          selectedUrls: [`https://example.com/src-${retrieveCalls}`],
        };
        return out;
      },
      fetch: async () => {},
      extract: async () => {},
      loadLabeledSources: async (input) => {
        const sources = await input.store.listSources(runId);
        return labeledSourcesFromStore(input.checkpoint, sources);
      },
      synthesize: async (input) => {
        return synthesisSnapshot({ summary: "iteration synthesis", sources: input.sources, findingId: "F1" });
      },
      review: async () => {
        const out: IterationReviewOutput = {
          verdict: "accept",
          unsupportedConclusions: [],
          missingEvidence: [],
          requestedRevisions: [],
        };
        return out;
      },
      callModelJsonLogged: async <T>() => {
        gapCalls += 1;
        if (gapCalls === 1) {
          const out: GapAnalysisOutput = {
            questionUpdates: [
              { id: "q1", status: "answered", evidence: [{ source: "S1" }] },
              { id: "q2", status: "answered", evidence: [{ source: "S1" }] },
            ],
            nextQueries: ["q-next"],
            nextTasks: [],
            stop: false,
          };
          return out as unknown as T;
        }

        const out: GapAnalysisOutput = {
          questionUpdates: [{ id: "q2", status: "answered", evidence: [{ source: "S1" }] }],
          nextQueries: [],
          nextTasks: [],
          stop: false,
        };
        return out as unknown as T;
      },
    };

    const result = await runResearchLoop({
      runId,
      userId,
      prompt,
      citationPolicy,
      budgets: baseBudgetConfig({ maxSources: 10 }),
      models: baseModels(),
      thinkingMode,
      loopConfig: baseLoopConfig({ maxIterations: 2 }),
      deadlineMs: Date.now() + 60_000,
      services: makeStaticServices({ store, objectStore, modelProvider }),
      checkpoint,
      synthesis: {
        maxInputTokens: 120_000,
        maxOutputTokens: 5_000,
        contextWindowTokens: 120_000,
        requestedMaxInputTokens: 120_000,
        requestedMaxOutputTokens: 5_000,
      },
      steps,
    });

    expect(result.stopReason).toBe("questions_answered");
    expect(retrieveCalls).toBe(2);
    expect(checkpoint.questionGraph?.questions.find((q) => q.id === "q1")?.updatedAtIteration).toBe(1);
    expect(checkpoint.questionGraph?.questions.find((q) => q.id === "q2")?.updatedAtIteration).toBe(2);
  });

  it("ignores deadlineMs for iteration scheduling (still runs gap analysis)", async () => {
    const runId = "run-ignore-deadline";
    const userId = "user";
    const prompt = "Test prompt";
    const checkpoint = baseCheckpoint(runId);
    const objectStore = new MemoryObjectStore();

    await objectStore.putJson(runPlanKey(runId), { queries: ["q1"] });

    const store = new MemoryPipelineStore({ runId, userId, prompt, state: checkpoint });
    const modelProvider: ModelProvider = { name: "mock", async chat() { throw new Error("not used"); } };

    let reviewCalls = 0;
    let gapCalls = 0;

    const steps: LoopSteps = {
      retrieve: async () => {
        const out: RetrievalOutput = { queries: [], selectedUrls: ["https://example.com/src-1"] };
        return out;
      },
      fetch: async () => {},
      extract: async () => {},
      loadLabeledSources: async (input) => {
        const sources = await input.store.listSources(runId);
        return labeledSourcesFromStore(input.checkpoint, sources);
      },
      synthesize: async (input) => {
        return synthesisSnapshot({ summary: "iteration synthesis", sources: input.sources, findingId: "F1" });
      },
      review: async () => {
        reviewCalls += 1;
        const out: IterationReviewOutput = {
          verdict: "accept",
          unsupportedConclusions: [],
          missingEvidence: [],
          requestedRevisions: [],
        };
        return out;
      },
      callModelJsonLogged: async <T>() => {
        gapCalls += 1;
        const out: GapAnalysisOutput = {
          questionUpdates: [],
          nextQueries: ["q-next"],
          nextTasks: [],
          stop: false,
        };
        return out as unknown as T;
      },
    };

    const result = await runResearchLoop({
      runId,
      userId,
      prompt,
      citationPolicy,
      budgets: baseBudgetConfig({ maxSources: 2 }),
      models: baseModels(),
      thinkingMode,
      loopConfig: baseLoopConfig({ maxIterations: 5 }),
      deadlineMs: Date.now() + 1,
      services: makeStaticServices({ store, objectStore, modelProvider }),
      checkpoint,
      synthesis: {
        maxInputTokens: 120_000,
        maxOutputTokens: 5_000,
        contextWindowTokens: 120_000,
        requestedMaxInputTokens: 120_000,
        requestedMaxOutputTokens: 5_000,
      },
      steps,
    });

    expect(result.stopReason).toBe("questions_answered");
    expect(reviewCalls).toBe(0);
    expect(gapCalls).toBeGreaterThan(0);
    expect(await objectStore.getJson(iterationCompressionKey(runId, 1))).not.toBeNull();
  });
});
