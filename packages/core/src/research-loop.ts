import { z } from "zod";

import type { BudgetConfig, CitationPolicy, PhaseModelConfig, ResearchLoopConfig, ThinkingMode } from "./config.js";
import type { SearchAdapter, HttpFetchAdapter, BrowserRenderAdapter } from "./adapters.js";
import type { ExtractedEvidence } from "./extract.js";
import type { ChatMessage, ModelProvider } from "./models.js";
import type { LabeledSource, SynthesisOutput } from "./memo.js";
import { buildCitationMap } from "./memo.js";
import { validateCitations, type VerificationReport } from "./verify.js";
import {
  QuestionEvidenceSchema,
  QuestionGraphSchema,
  computeUnblockedQuestions,
  normalizeQuestionAnsweredRubric,
  validateQuestionGraph,
} from "./goal-directed.js";
import type { QuestionGraph, QuestionStatus } from "./goal-directed.js";
import {
  iterationCitationMapKey,
  iterationGapAnalysisKey,
  iterationPlanKey,
  iterationRetrievalKey,
  iterationReviewKey,
  iterationSynthesisKey,
  iterationVerificationJsonKey,
  iterationVerificationMarkdownKey,
  runPlanKey,
  runFinalSynthesisReviewKey,
  runSynthesisKey,
  sourceEvidenceKey,
} from "./artifacts.js";

import type { ObjectStore, PipelineSourceRow, PipelineStore, RunCheckpoint } from "./orchestrator.js";
import { normalizeUrl } from "./url.js";

export type ResearchLoopStopReason =
  | "gap_analysis_stop"
  | "questions_answered"
  | "diminishing_returns"
  | "no_new_sources"
  | "budget_exhausted"
  | "iteration_cap";

export type ResearchLoopOperationalMode = "incremental" | "hybrid";

export type ResearchLoopIterationState = {
  iteration: number;
  mode: ResearchLoopOperationalMode;
  startedAt: string;
  completedAt?: string;
  queries: string[];
  tasks: string[];
  selectedUrls: string[];
  sourceIds: string[];
  netNewSources: number;
  artifacts: {
    planKey: string;
    retrievalKey: string;
    synthesisKey: string;
    citationMapKey: string;
    verificationJsonKey: string;
    verificationMarkdownKey: string;
    reviewKey: string;
    gapAnalysisKey: string;
  };
  reviewVerdict?: "accept" | "revise" | "reject" | "unknown";
  gapAnalysisStop?: boolean;
  gapAnalysisStopReason?: string;
  stopReason?: ResearchLoopStopReason;
};

export type ResearchLoopCheckpointState = {
  version: 1;
  enabled: boolean;
  modeSetting: ResearchLoopConfig["mode"];
  mode: ResearchLoopOperationalMode;
  maxIterations: number;
  sourcesPerIteration?: number;
  switchToHybridAfterRejects: number;
  rejectCount: number;
  iterationCountCompleted: number;
  stopReason?: ResearchLoopStopReason;
  seenUrls: string[];
  seenQueries: string[];
  seenTasks: string[];
  unansweredStreaks: Record<string, number>;
  pending: { queries: string[]; tasks: string[] };
  lastSynthesisKey?: string;
  planVersionKeys: string[];
  lowValueIterationStreak: number;
  iterations: ResearchLoopIterationState[];
};

const InitialPlanSchema = z.object({
  subquestions: z.array(z.string()).default([]),
  queries: z.array(z.string()).default([]),
});

const GapAnalysisModelSchema = z.object({
  questionUpdates: z
    .array(
      z.object({
        id: z.string().min(1),
        status: z.enum(["unanswered", "partial", "answered", "unanswerable"]),
        evidence: z.array(QuestionEvidenceSchema).default([]),
        confidence: z.number().min(0).max(1).optional(),
      })
    )
    .default([]),
  nextQueries: z.array(z.string().min(1)).default([]),
  nextTasks: z.array(z.string().min(1)).default([]),
  stop: z.boolean().default(false),
  stopReason: z.string().optional(),
  planNotes: z.array(z.string().min(1)).optional(),
});
const GapAnalysisOutputSchema = GapAnalysisModelSchema.superRefine((value, ctx) => {
  if (value.stop && (!value.stopReason || !value.stopReason.trim())) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["stopReason"],
      message: "stopReason is required when stop is true",
    });
  }
});
export type GapAnalysisOutput = z.infer<typeof GapAnalysisOutputSchema>;

function normalizeGapAnalysisOutput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const cast = raw as Record<string, unknown>;
  if (typeof cast.stopReason !== "string") return raw;
  if (cast.stopReason.trim() !== "") return raw;
  const normalized: Record<string, unknown> = { ...cast };
  delete normalized.stopReason;
  return normalized;
}

const ReviewOutputSchema = z.object({
  verdict: z.enum(["accept", "revise", "reject"]),
  unsupportedConclusions: z.array(z.unknown()).default([]),
  missingEvidence: z.array(z.string()).default([]),
  requestedRevisions: z.array(z.string()).default([]),
  confidenceRisk: z.number().min(0).max(10).optional(),
});
export type IterationReviewOutput = z.infer<typeof ReviewOutputSchema>;

export type RetrievalOutput = {
  queries: Array<{
    query: string;
    results: Array<{ url: string; title?: string; snippet?: string }>;
  }>;
  selectedUrls: string[];
};

export type LoopSteps = {
  retrieve: (input: {
    runId: string;
    userId: string;
    budgets: BudgetConfig;
    queries: string[];
    search: SearchAdapter;
    store: PipelineStore;
    maxSelectedUrls: number;
    seenUrls: Set<string>;
  }) => Promise<RetrievalOutput>;
  fetch: (input: {
    runId: string;
    userId: string;
    budgets: BudgetConfig;
    checkpoint: RunCheckpoint;
    store: PipelineStore;
    objectStore: ObjectStore;
    httpFetch: HttpFetchAdapter;
    onlySourceIds?: string[];
  }) => Promise<void>;
  extract: (input: {
    runId: string;
    userId: string;
    budgets: BudgetConfig;
    checkpoint: RunCheckpoint;
    store: PipelineStore;
    objectStore: ObjectStore;
    browser: BrowserRenderAdapter | undefined;
    onlySourceIds?: string[];
  }) => Promise<void>;
  loadLabeledSources: (input: {
    runId: string;
    checkpoint: RunCheckpoint;
    store: PipelineStore;
    objectStore: ObjectStore;
  }) => Promise<LabeledSource[]>;
  synthesize: (input: {
    runId: string;
    userId: string;
    prompt: string;
    sources: LabeledSource[];
    citationPolicy: CitationPolicy;
    provider: ModelProvider | undefined;
    model: string;
    thinkingMode: ThinkingMode;
    maxInputTokens: number;
    maxOutputTokens: number;
    requestedMaxInputTokens: number;
    requestedMaxOutputTokens: number;
    synthesisContextWindowTokens: number;
    store: PipelineStore;
    objectStore: ObjectStore;
    checkpoint: RunCheckpoint;
    previousSynthesis?: SynthesisOutput;
    reviewPolicy?: "enforce" | "skip";
  }) => Promise<SynthesisOutput>;
  review: (input: {
    runId: string;
    userId: string;
    prompt: string;
    sources: LabeledSource[];
    synthesis: SynthesisOutput;
    provider: ModelProvider;
    model: string;
    thinkingMode: ThinkingMode;
    store: PipelineStore;
    objectStore: ObjectStore;
    checkpoint: RunCheckpoint;
  }) => Promise<IterationReviewOutput>;
  callModelJsonLogged: <TSchema extends z.ZodTypeAny>(input: {
    runId: string;
    userId: string;
    phase: string;
    persona?: string;
    provider: ModelProvider;
    model: string;
    messages: ChatMessage[];
    schema: TSchema;
    store: PipelineStore;
    objectStore: ObjectStore;
    checkpoint: RunCheckpoint;
    promptVersion: string;
    temperature?: number;
    maxTokens?: number;
    reasoningEffort: ThinkingMode;
  }) => Promise<z.output<TSchema>>;
};

function dedupeStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function deriveSourcesPerIteration(input: {
  maxSources: number;
  configured?: number;
}): number {
  const maxSources = Math.max(0, Math.floor(input.maxSources));
  if (typeof input.configured === "number" && Number.isFinite(input.configured) && input.configured > 0) {
    return Math.max(1, Math.floor(input.configured));
  }
  return Math.max(Math.ceil(maxSources / 5), 20);
}

function summarizeTopIssues(report: VerificationReport, limit: number): Array<{
  severity: string;
  code: string;
  message: string;
  claimId?: string;
  sourceLabel?: string;
}> {
  return report.issues.slice(0, Math.max(0, limit)).map((issue) => ({
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    ...(issue.claimId ? { claimId: issue.claimId } : {}),
    ...(issue.sourceLabel ? { sourceLabel: issue.sourceLabel } : {}),
  }));
}

function defaultLoopCheckpoint(input: {
  enabled: boolean;
  config: ResearchLoopConfig;
  initialQueries: string[];
}): ResearchLoopCheckpointState {
  const modeSetting = input.config.mode;
  const mode: ResearchLoopOperationalMode = modeSetting === "hybrid" ? "hybrid" : "incremental";
	  return {
	    version: 1,
	    enabled: input.enabled,
	    modeSetting,
	    mode,
	    maxIterations: Math.max(1, Math.floor(input.config.maxIterations)),
	    switchToHybridAfterRejects: Math.max(1, Math.floor(input.config.switchToHybridAfterRejects)),
	    rejectCount: 0,
	    iterationCountCompleted: 0,
	    seenUrls: [],
	    seenQueries: [],
	    seenTasks: [],
	    unansweredStreaks: {},
	    pending: { queries: dedupeStrings(input.initialQueries), tasks: [] },
	    planVersionKeys: [],
	    lowValueIterationStreak: 0,
	    iterations: [],
	    ...(input.config.sourcesPerIteration !== undefined
      ? { sourcesPerIteration: input.config.sourcesPerIteration }
      : {}),
  };
}

function coerceLoopCheckpointState(
  raw: unknown,
  fallback: ResearchLoopCheckpointState
): ResearchLoopCheckpointState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const o = raw as Partial<ResearchLoopCheckpointState>;
  const version = o.version === 1 ? 1 : 1;
  const maxIterations =
    typeof o.maxIterations === "number" && Number.isFinite(o.maxIterations) && o.maxIterations > 0
      ? Math.floor(o.maxIterations)
      : fallback.maxIterations;
  const rejectCount =
    typeof o.rejectCount === "number" && Number.isFinite(o.rejectCount) && o.rejectCount >= 0
      ? Math.floor(o.rejectCount)
      : fallback.rejectCount;
  const switchToHybridAfterRejects =
    typeof o.switchToHybridAfterRejects === "number" &&
    Number.isFinite(o.switchToHybridAfterRejects) &&
    o.switchToHybridAfterRejects > 0
      ? Math.floor(o.switchToHybridAfterRejects)
      : fallback.switchToHybridAfterRejects;

  const modeSetting = o.modeSetting === "auto" || o.modeSetting === "incremental" || o.modeSetting === "hybrid"
    ? o.modeSetting
    : fallback.modeSetting;
  const mode = o.mode === "hybrid" ? "hybrid" : "incremental";
	  const sourcesPerIteration =
	    typeof o.sourcesPerIteration === "number" && Number.isFinite(o.sourcesPerIteration) && o.sourcesPerIteration > 0
	      ? Math.floor(o.sourcesPerIteration)
	      : fallback.sourcesPerIteration;
  const lowValueIterationStreak =
    typeof o.lowValueIterationStreak === "number" &&
    Number.isFinite(o.lowValueIterationStreak) &&
    o.lowValueIterationStreak >= 0
      ? Math.floor(o.lowValueIterationStreak)
      : fallback.lowValueIterationStreak;
  const iterationCountCompleted =
    typeof o.iterationCountCompleted === "number" &&
    Number.isFinite(o.iterationCountCompleted) &&
    o.iterationCountCompleted >= 0
      ? Math.floor(o.iterationCountCompleted)
      : fallback.iterationCountCompleted;

	  const stopReason = o.stopReason;
	  const enabled = typeof o.enabled === "boolean" ? o.enabled : fallback.enabled;
	  const unansweredStreaks =
	    o.unansweredStreaks && typeof o.unansweredStreaks === "object" && !Array.isArray(o.unansweredStreaks)
	      ? Object.fromEntries(
	          Object.entries(o.unansweredStreaks as Record<string, unknown>)
	            .filter(([id, streak]) => {
	              const key = typeof id === "string" ? id.trim() : "";
	              return (
	                key.length > 0 &&
	                typeof streak === "number" &&
	                Number.isFinite(streak) &&
	                streak >= 0
	              );
	            })
	            .map(([id, streak]) => [id, Math.floor(streak as number)])
	        )
	      : fallback.unansweredStreaks;

	  return {
	    ...fallback,
	    version,
	    enabled,
	    modeSetting,
	    mode,
	    maxIterations,
	    switchToHybridAfterRejects,
	    rejectCount,
	    iterationCountCompleted,
	    ...(stopReason ? { stopReason } : {}),
	    seenUrls: Array.isArray(o.seenUrls) ? dedupeStrings(o.seenUrls) : fallback.seenUrls,
	    seenQueries: Array.isArray(o.seenQueries) ? dedupeStrings(o.seenQueries) : fallback.seenQueries,
	    seenTasks: Array.isArray(o.seenTasks) ? dedupeStrings(o.seenTasks) : fallback.seenTasks,
	    unansweredStreaks,
	    pending: o.pending && typeof o.pending === "object"
	      ? {
	          queries: Array.isArray((o.pending as { queries?: unknown }).queries)
	            ? dedupeStrings((o.pending as { queries: string[] }).queries)
	            : fallback.pending.queries,
          tasks: Array.isArray((o.pending as { tasks?: unknown }).tasks)
            ? dedupeStrings((o.pending as { tasks: string[] }).tasks)
            : fallback.pending.tasks,
        }
      : fallback.pending,
    planVersionKeys: Array.isArray(o.planVersionKeys) ? dedupeStrings(o.planVersionKeys) : fallback.planVersionKeys,
    iterations: Array.isArray(o.iterations) ? (o.iterations as ResearchLoopIterationState[]) : fallback.iterations,
    lowValueIterationStreak,
    ...(sourcesPerIteration !== undefined ? { sourcesPerIteration } : {}),
    ...(typeof o.lastSynthesisKey === "string"
      ? { lastSynthesisKey: o.lastSynthesisKey }
      : fallback.lastSynthesisKey
        ? { lastSynthesisKey: fallback.lastSynthesisKey }
        : {}),
  };
}

function normalizeSources(input: PipelineSourceRow[]): {
  sources: PipelineSourceRow[];
  urls: Set<string>;
  byUrl: Map<string, PipelineSourceRow>;
} {
  const urls = new Set<string>();
  const byUrl = new Map<string, PipelineSourceRow>();
  for (const source of input) {
    const rawUrl = typeof source.url === "string" ? source.url.trim() : "";
    const url = rawUrl ? normalizeUrl(rawUrl) : "";
    if (url) {
      urls.add(url);
      if (!byUrl.has(url)) byUrl.set(url, source);
    }
    const rawFinalUrl = typeof source.final_url === "string" ? source.final_url.trim() : "";
    const finalUrl = rawFinalUrl ? normalizeUrl(rawFinalUrl) : "";
    if (finalUrl) {
      urls.add(finalUrl);
      if (!byUrl.has(finalUrl)) byUrl.set(finalUrl, source);
    }
  }
  return { sources: input, urls, byUrl };
}

function selectOperationalMode(state: ResearchLoopCheckpointState): ResearchLoopOperationalMode {
  if (state.modeSetting === "hybrid") return "hybrid";
  if (state.modeSetting === "incremental") return "incremental";
  return state.mode;
}

function filterPendingAgainstSeen(input: {
  pending: { queries: string[]; tasks: string[] };
  seenQueries: Set<string>;
  seenTasks: Set<string>;
}): { queries: string[]; tasks: string[] } {
  const queries = dedupeStrings(input.pending.queries).filter((q) => !input.seenQueries.has(q));
  const tasks = dedupeStrings(input.pending.tasks).filter((t) => !input.seenTasks.has(t));
  return { queries, tasks };
}

function mapStopReasonFromGapAnalysis(output: GapAnalysisOutput): ResearchLoopStopReason {
  if (output.stopReason && output.stopReason.toLowerCase().includes("diminishing")) return "diminishing_returns";
  return "gap_analysis_stop";
}

function shouldStopForDiminishingReturns(input: {
  lowValueIterationStreak: number;
  nextStepsEmpty: boolean;
}): boolean {
  return input.lowValueIterationStreak >= 2 && input.nextStepsEmpty;
}

const LAND_THE_PLANE_FINALIZE_RESERVE_MS = 30_000;

function remainingTimeMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

function applyQuestionUpdates(input: {
  graph: QuestionGraph;
  updates: Array<{
    id: string;
    status: QuestionStatus;
    evidence: Array<z.infer<typeof QuestionEvidenceSchema>>;
    confidence?: number;
  }>;
  iteration: number;
}): QuestionGraph {
  const updateById = new Map(input.updates.map((u) => [u.id, u]));
  const questions = input.graph.questions.map((q) => {
    const update = updateById.get(q.id);
    if (!update) return q;
    return normalizeQuestionAnsweredRubric({
      ...q,
      status: update.status,
      evidence: update.evidence ?? [],
      ...(update.confidence !== undefined ? { confidence: update.confidence } : {}),
      updatedAtIteration: input.iteration,
    });
  });
  return validateQuestionGraph({ ...input.graph, questions });
}

function stopForQuestions(graph: QuestionGraph): boolean {
  const unblocked = computeUnblockedQuestions(graph);
  const isResolved = (status: QuestionStatus) => status === "answered" || status === "unanswerable";
  const unblockedOpen = unblocked.some((q) => !isResolved(q.status));
  if (unblockedOpen) return false;
  return graph.questions.every((q) => isResolved(q.status));
}

export async function runResearchLoop(input: {
  runId: string;
  userId: string;
  prompt: string;
  citationPolicy: CitationPolicy;
  budgets: BudgetConfig;
  models: PhaseModelConfig;
  thinkingMode: ThinkingMode;
  loopConfig: ResearchLoopConfig;
  deadlineMs: number;
  services: {
    store: PipelineStore;
    objectStore: ObjectStore;
    search: SearchAdapter;
    httpFetch: HttpFetchAdapter;
    browserRender?: BrowserRenderAdapter;
    modelProvider?: ModelProvider;
  };
  checkpoint: RunCheckpoint;
  synthesis: {
    maxInputTokens: number;
    maxOutputTokens: number;
    contextWindowTokens: number;
    requestedMaxInputTokens: number;
    requestedMaxOutputTokens: number;
  };
  steps: LoopSteps;
}): Promise<{
  stopReason: ResearchLoopStopReason;
  mode: ResearchLoopOperationalMode;
}> {
  const initialPlanKey = input.checkpoint.artifacts.planKey ?? runPlanKey(input.runId);
  const initialPlan =
    (await input.services.objectStore.getJson<unknown>(initialPlanKey)) ??
    (await input.services.objectStore.getJson<unknown>(runPlanKey(input.runId)));
  const parsedPlan = initialPlan ? InitialPlanSchema.safeParse(initialPlan).success
    ? InitialPlanSchema.parse(initialPlan)
    : InitialPlanSchema.parse({})
    : InitialPlanSchema.parse({});
  const initialQueries = dedupeStrings(parsedPlan.queries.length ? parsedPlan.queries : [input.prompt]);

  const baseState = defaultLoopCheckpoint({
    enabled: input.loopConfig.enabled,
    config: input.loopConfig,
    initialQueries,
  });

  const loopState = coerceLoopCheckpointState((input.checkpoint as { researchLoop?: unknown }).researchLoop, baseState);
  (input.checkpoint as { researchLoop?: ResearchLoopCheckpointState }).researchLoop = loopState;

  if (!loopState.enabled) {
    return { stopReason: "gap_analysis_stop", mode: "incremental" };
  }

  const checkpointQuestionGraph = (input.checkpoint as { questionGraph?: unknown }).questionGraph;
  let questionGraph: QuestionGraph = validateQuestionGraph(
    QuestionGraphSchema.safeParse(checkpointQuestionGraph).success
      ? QuestionGraphSchema.parse(checkpointQuestionGraph)
      : QuestionGraphSchema.parse({
          validated: true,
          questions: [
            {
              id: "q1",
              text: input.prompt,
              dependsOn: [],
              status: "unanswered",
              evidence: [],
            },
          ],
        })
  );
  (input.checkpoint as { questionGraph?: QuestionGraph }).questionGraph = questionGraph;

  let existing = normalizeSources(await input.services.store.listSources(input.runId));
  const seenUrls = new Set<string>([
    ...loopState.seenUrls.map((url) => normalizeUrl(url)),
    ...Array.from(existing.urls),
  ]);
  const seenQueries = new Set<string>(loopState.seenQueries);
  const seenTasks = new Set<string>(loopState.seenTasks);

  const sourcesPerIteration = deriveSourcesPerIteration({
    maxSources: input.budgets.maxSources,
    ...(loopState.sourcesPerIteration !== undefined
      ? { configured: loopState.sourcesPerIteration }
      : {}),
  });

  const ensureIterationEntry = (iteration: number): ResearchLoopIterationState => {
    const existingEntry = loopState.iterations.find((it) => it.iteration === iteration);
    if (existingEntry) return existingEntry;
    const mode = selectOperationalMode(loopState);
    const entry: ResearchLoopIterationState = {
      iteration,
      mode,
      startedAt: new Date().toISOString(),
      queries: [],
      tasks: [],
      selectedUrls: [],
      sourceIds: [],
      netNewSources: 0,
      artifacts: {
        planKey: iterationPlanKey(input.runId, iteration),
        retrievalKey: iterationRetrievalKey(input.runId, iteration),
        synthesisKey: iterationSynthesisKey(input.runId, iteration),
        citationMapKey: iterationCitationMapKey(input.runId, iteration),
        verificationJsonKey: iterationVerificationJsonKey(input.runId, iteration),
        verificationMarkdownKey: iterationVerificationMarkdownKey(input.runId, iteration),
        reviewKey: iterationReviewKey(input.runId, iteration),
        gapAnalysisKey: iterationGapAnalysisKey(input.runId, iteration),
      },
    };
    loopState.iterations.push(entry);
    return entry;
  };

  const persistCheckpoint = async (): Promise<void> => {
    await input.services.store.updateRun({ runId: input.runId, state: input.checkpoint });
  };

  const persistImmutableCheckpoint = async (opts: {
    kind: "iteration" | "finalize";
    iterationCompleted: number;
    sources?: LabeledSource[];
  }): Promise<void> => {
    if (!input.services.store.createRunCheckpoint) return;
    const synthesisState = (input.checkpoint as { synthesisState?: unknown }).synthesisState;
    const payload = {
      version: 1,
      runId: input.runId,
      createdAt: new Date().toISOString(),
      checkpointVersion: 1,
      kind: opts.kind,
      iterationCompleted: opts.iterationCompleted,
      pipelineCheckpoint: input.checkpoint,
      seenUrls: loopState.seenUrls,
      seenQueries: loopState.seenQueries,
      questionGraph,
      synthesisState,
      sourceArtifacts: (opts.sources ?? []).map((s) => ({
        label: s.label,
        sourceId: s.sourceId,
        url: s.url,
        title: s.title,
        publisher: s.publisher,
        fetchedAt: s.fetchedAt,
        evidenceKey: sourceEvidenceKey(input.runId, s.sourceId),
      })),
      mode: {
        modeSetting: loopState.modeSetting,
        mode: loopState.mode,
      },
      budgets: input.budgets,
      deadlineMs: input.deadlineMs,
    };

    try {
      await input.services.store.createRunCheckpoint({
        runId: input.runId,
        kind: opts.kind,
        checkpointVersion: 1,
        iterationCompleted: opts.iterationCompleted,
        payload,
      });
    } catch (err) {
      await input.services.store
        .addRunEvent({
          runId: input.runId,
          level: "warn",
          phase: "retrieve",
          eventType: "checkpoint_persist_failed",
          message: "Failed to persist immutable run checkpoint; continuing without it",
          data: {
            kind: opts.kind,
            iterationCompleted: opts.iterationCompleted,
            error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
          },
        })
        .catch(() => {});
    }
  };

  const persistIterationPlanVersion = async (iterationEntry: ResearchLoopIterationState, gap: GapAnalysisOutput, report: VerificationReport, review: IterationReviewOutput): Promise<void> => {
    const payload = {
      version: 1,
      runId: input.runId,
      iteration: iterationEntry.iteration,
      createdAt: new Date().toISOString(),
      initialPlanKey,
      mode: iterationEntry.mode,
      inputs: {
        queries: iterationEntry.queries,
        tasks: iterationEntry.tasks,
      },
      outputs: {
        questionUpdates: gap.questionUpdates ?? [],
        nextQueries: gap.nextQueries,
        nextTasks: gap.nextTasks,
        stop: gap.stop,
        stopReason: gap.stopReason ?? null,
        planNotes: gap.planNotes ?? [],
      },
      verification: {
        ok: report.ok,
        coverage: report.coverage,
        topIssues: summarizeTopIssues(report, 8),
      },
      reviewer: {
        verdict: review.verdict,
        missingEvidence: review.missingEvidence,
        requestedRevisions: review.requestedRevisions,
        confidenceRisk: review.confidenceRisk,
      },
    };
    await input.services.objectStore.putJson(iterationEntry.artifacts.planKey, payload);
    if (!loopState.planVersionKeys.includes(iterationEntry.artifacts.planKey)) {
      loopState.planVersionKeys.push(iterationEntry.artifacts.planKey);
    }
  };

  await input.services.store
    .addRunEvent({
      runId: input.runId,
      level: "info",
      phase: "retrieve",
      eventType: "research_loop_started",
      message: `Research loop started (enabled=true, maxIterations=${loopState.maxIterations}, sourcesPerIteration=${sourcesPerIteration}, mode=${loopState.modeSetting})`,
      data: {
        enabled: true,
        maxIterations: loopState.maxIterations,
        sourcesPerIteration,
        modeSetting: loopState.modeSetting,
      },
    })
    .catch(() => {});

  while (!loopState.stopReason && loopState.iterationCountCompleted < loopState.maxIterations) {
    if (remainingTimeMs(input.deadlineMs) <= LAND_THE_PLANE_FINALIZE_RESERVE_MS) {
      loopState.stopReason = "budget_exhausted";
      break;
    }

    existing = normalizeSources(await input.services.store.listSources(input.runId));
    for (const url of existing.urls) seenUrls.add(url);
    loopState.seenUrls = Array.from(seenUrls);

    const nextIteration = loopState.iterationCountCompleted + 1;
    const iterationEntry = ensureIterationEntry(nextIteration);
    iterationEntry.mode = selectOperationalMode(loopState);

    const remainingSources = Math.max(0, input.budgets.maxSources - existing.sources.length);
    const perIterationLimit = Math.min(remainingSources, sourcesPerIteration);
    if (perIterationLimit <= 0) {
      loopState.stopReason = "budget_exhausted";
      iterationEntry.stopReason = "budget_exhausted";
      iterationEntry.completedAt = new Date().toISOString();
      break;
    }

    if (input.checkpoint.counters.fetches >= input.budgets.maxFetches) {
      loopState.stopReason = "budget_exhausted";
      iterationEntry.stopReason = "budget_exhausted";
      iterationEntry.completedAt = new Date().toISOString();
      break;
    }

    const storedQueries = Array.isArray(iterationEntry.queries) ? dedupeStrings(iterationEntry.queries) : [];
    const storedTasks = Array.isArray(iterationEntry.tasks) ? dedupeStrings(iterationEntry.tasks) : [];
    const hasStoredSteps = storedQueries.length > 0 || storedTasks.length > 0;

    const pendingFiltered = hasStoredSteps
      ? { queries: storedQueries, tasks: storedTasks }
      : filterPendingAgainstSeen({
          pending: loopState.pending,
          seenQueries,
          seenTasks,
        });

    const nextQueries = pendingFiltered.queries.slice(0, 8);
    const nextTasks = pendingFiltered.tasks.slice(0, 8);
    if (nextQueries.length === 0 && nextTasks.length === 0) {
      loopState.stopReason = "diminishing_returns";
      iterationEntry.stopReason = "diminishing_returns";
      iterationEntry.completedAt = new Date().toISOString();
      break;
    }

    iterationEntry.queries = nextQueries;
    iterationEntry.tasks = nextTasks;

    await input.services.store
      .addRunEvent({
        runId: input.runId,
        level: "info",
        phase: "retrieve",
        eventType: "research_iteration_started",
        message: `Iteration ${iterationEntry.iteration}/${loopState.maxIterations} started (mode=${iterationEntry.mode}, remainingSources=${remainingSources})`,
        data: {
          iteration: iterationEntry.iteration,
          maxIterations: loopState.maxIterations,
          mode: iterationEntry.mode,
          remainingSources,
          perIterationSourceCap: perIterationLimit,
        },
      })
      .catch(() => {});

    const retrievalKey = iterationEntry.artifacts.retrievalKey;
    const retrieval =
      (await input.services.objectStore.getJson<RetrievalOutput>(retrievalKey)) ??
      (await (async () => {
        const combinedQueries = dedupeStrings([...iterationEntry.queries, ...iterationEntry.tasks]);
        const result = await input.steps.retrieve({
          runId: input.runId,
          userId: input.userId,
          budgets: input.budgets,
          queries: combinedQueries.length ? combinedQueries : initialQueries,
          search: input.services.search,
          store: input.services.store,
          maxSelectedUrls: perIterationLimit,
          seenUrls,
        });
        await input.services.objectStore.putJson(retrievalKey, result);
        return result;
      })());

    iterationEntry.selectedUrls = dedupeStrings(retrieval.selectedUrls);
    const selectedNewUrls = iterationEntry.selectedUrls.filter((url) => !seenUrls.has(url));
    for (const url of iterationEntry.selectedUrls) seenUrls.add(url);
    for (const q of iterationEntry.queries) seenQueries.add(q);
    for (const t of iterationEntry.tasks) seenTasks.add(t);
    loopState.seenUrls = Array.from(seenUrls);
    loopState.seenQueries = Array.from(seenQueries);
    loopState.seenTasks = Array.from(seenTasks);
    await persistCheckpoint();

    if (iterationEntry.selectedUrls.length === 0) {
      loopState.stopReason = "no_new_sources";
      iterationEntry.stopReason = "no_new_sources";
      iterationEntry.completedAt = new Date().toISOString();
      loopState.iterationCountCompleted = iterationEntry.iteration;
      await persistCheckpoint();
      await persistImmutableCheckpoint({
        kind: "iteration",
        iterationCompleted: loopState.iterationCountCompleted,
      });
      await input.services.store
        .addRunEvent({
          runId: input.runId,
          level: "warn",
          phase: "retrieve",
          eventType: "research_loop_no_new_sources",
          message: `Iteration ${iterationEntry.iteration} selected 0 net-new URLs; stopping loop`,
          data: { iteration: iterationEntry.iteration },
        })
        .catch(() => {});
      break;
    }

    const iterationSourceIds: string[] = [];
    for (const url of iterationEntry.selectedUrls) {
      const existingRow = existing.byUrl.get(url);
      if (existingRow) {
        iterationSourceIds.push(existingRow.id);
        continue;
      }
      const src = await input.services.store.createSource({ runId: input.runId, url });
      existing.byUrl.set(url, src as unknown as PipelineSourceRow);
      iterationSourceIds.push(src.id);
      existing.urls.add(url);
    }

    iterationEntry.sourceIds = dedupeStrings(iterationSourceIds);
    iterationEntry.netNewSources = selectedNewUrls.length;
    loopState.iterationCountCompleted = iterationEntry.iteration - 1;
    await persistCheckpoint();

    await input.steps.fetch({
      runId: input.runId,
      userId: input.userId,
      budgets: input.budgets,
      checkpoint: input.checkpoint,
      store: input.services.store,
      objectStore: input.services.objectStore,
      httpFetch: input.services.httpFetch,
      onlySourceIds: iterationEntry.sourceIds,
    });

    await input.steps.extract({
      runId: input.runId,
      userId: input.userId,
      budgets: input.budgets,
      checkpoint: input.checkpoint,
      store: input.services.store,
      objectStore: input.services.objectStore,
      browser: input.services.browserRender,
      onlySourceIds: iterationEntry.sourceIds,
    });

    existing = normalizeSources(await input.services.store.listSources(input.runId));
    for (const url of existing.urls) seenUrls.add(url);
    loopState.seenUrls = Array.from(seenUrls);
    await persistCheckpoint();

    const allLabeledSources = await input.steps.loadLabeledSources({
      runId: input.runId,
      checkpoint: input.checkpoint,
      store: input.services.store,
      objectStore: input.services.objectStore,
    });
    const promptSources = allLabeledSources.filter((s) => iterationEntry.sourceIds.includes(s.sourceId));

    const previousSynthesis =
      loopState.lastSynthesisKey
        ? await input.services.objectStore.getJson<SynthesisOutput>(loopState.lastSynthesisKey)
        : null;

    const fullContextRequested = (input.loopConfig as { fullContext?: boolean }).fullContext === true;
    const contextBudgetTokens = Math.max(
      0,
      input.synthesis.contextWindowTokens - Math.min(10_000, input.synthesis.maxOutputTokens) - 2_048
    );
    const fullContextActive = fullContextRequested && contextBudgetTokens >= 50_000;

    const synthesisSources = fullContextActive
      ? allLabeledSources
      : promptSources.length
        ? promptSources
        : allLabeledSources;

    const interimSynthesis = await input.steps.synthesize({
      runId: input.runId,
      userId: input.userId,
      prompt: input.prompt,
      sources: synthesisSources,
      citationPolicy: input.citationPolicy,
      provider: input.services.modelProvider,
      model: input.models.synthesizer,
      thinkingMode: input.thinkingMode,
      maxInputTokens: input.synthesis.maxInputTokens,
      maxOutputTokens: input.synthesis.maxOutputTokens,
      requestedMaxInputTokens: input.synthesis.requestedMaxInputTokens,
      requestedMaxOutputTokens: input.synthesis.requestedMaxOutputTokens,
      synthesisContextWindowTokens: input.synthesis.contextWindowTokens,
      store: input.services.store,
      objectStore: input.services.objectStore,
      checkpoint: input.checkpoint,
      reviewPolicy: "skip",
      ...(!fullContextActive && previousSynthesis ? { previousSynthesis } : {}),
    });

    await input.services.objectStore.putJson(iterationEntry.artifacts.synthesisKey, interimSynthesis);
    loopState.lastSynthesisKey = iterationEntry.artifacts.synthesisKey;
    (input.checkpoint as { synthesisState?: unknown }).synthesisState = {
      snapshotKey: iterationEntry.artifacts.synthesisKey,
      summary: interimSynthesis.summary,
    };
    await persistCheckpoint();

    if (iterationEntry.iteration === 1 || fullContextRequested) {
      await input.services.store
        .addRunEvent({
          runId: input.runId,
          level: "info",
          phase: "synthesize",
          eventType: "synthesis_context_mode",
          message: `Synthesis context mode: ${fullContextActive ? "full-context" : "summary+delta"} (contextBudgetTokens=${contextBudgetTokens})`,
          data: {
            iteration: iterationEntry.iteration,
            fullContextRequested,
            fullContextActive,
            contextBudgetTokens,
            sourceCount: synthesisSources.length,
            promptSourceCount: promptSources.length,
            totalSourceCount: allLabeledSources.length,
          },
        })
        .catch(() => {});
    }

    const citationMap = buildCitationMap({
      runId: input.runId,
      policy: input.citationPolicy,
      synthesis: interimSynthesis,
      sources: allLabeledSources,
    });

    const evidenceBySourceId: Record<string, ExtractedEvidence | undefined> = {};
    for (const source of allLabeledSources) {
      const ev = await input.services.objectStore.getJson<ExtractedEvidence>(
        sourceEvidenceKey(input.runId, source.sourceId)
      );
      evidenceBySourceId[source.sourceId] = ev ?? undefined;
    }

    const { report, markdown } = validateCitations({
      runId: input.runId,
      policy: input.citationPolicy,
      citationMap,
      evidenceBySourceId,
    });

    await input.services.objectStore.putJson(iterationEntry.artifacts.citationMapKey, citationMap);
    await input.services.objectStore.putJson(iterationEntry.artifacts.verificationJsonKey, report);
    await input.services.objectStore.putText(iterationEntry.artifacts.verificationMarkdownKey, markdown);

    const landThePlaneNow = remainingTimeMs(input.deadlineMs) <= LAND_THE_PLANE_FINALIZE_RESERVE_MS;

    let reviewOutput: IterationReviewOutput = {
      verdict: "accept",
      unsupportedConclusions: [],
      missingEvidence: [],
      requestedRevisions: [],
    };
    if (!landThePlaneNow && input.services.modelProvider) {
      const review = await input.steps.review({
        runId: input.runId,
        userId: input.userId,
        prompt: input.prompt,
        sources: allLabeledSources,
        synthesis: interimSynthesis,
        provider: input.services.modelProvider,
        model: input.models.verifier,
        thinkingMode: input.thinkingMode,
        store: input.services.store,
        objectStore: input.services.objectStore,
        checkpoint: input.checkpoint,
      });
      reviewOutput = ReviewOutputSchema.parse(review);
    }

    await input.services.objectStore.putJson(iterationEntry.artifacts.reviewKey, reviewOutput);
    iterationEntry.reviewVerdict = reviewOutput.verdict;

    await input.services.store
      .addRunEvent({
        runId: input.runId,
        level: "info",
        phase: "verify",
        eventType: "research_iteration_review_completed",
        message: `Iteration ${iterationEntry.iteration} review: ${reviewOutput.verdict}`,
        data: {
          iteration: iterationEntry.iteration,
          verdict: reviewOutput.verdict,
          missingEvidence: reviewOutput.missingEvidence.slice(0, 4),
          requestedRevisions: reviewOutput.requestedRevisions.slice(0, 4),
        },
      })
      .catch(() => {});

    if (landThePlaneNow) {
      loopState.stopReason = "budget_exhausted";
      iterationEntry.stopReason = "budget_exhausted";
      iterationEntry.completedAt = new Date().toISOString();
      loopState.iterationCountCompleted = iterationEntry.iteration;
      await persistCheckpoint();
      await persistImmutableCheckpoint({
        kind: "iteration",
        iterationCompleted: loopState.iterationCountCompleted,
        sources: allLabeledSources,
      });
      await input.services.store
        .addRunEvent({
          runId: input.runId,
          level: "warn",
          phase: "retrieve",
          eventType: "land_the_plane",
          message: `Landing the plane after iteration ${iterationEntry.iteration} (timeRemainingMs=${remainingTimeMs(input.deadlineMs)})`,
          data: {
            iteration: iterationEntry.iteration,
            timeRemainingMs: remainingTimeMs(input.deadlineMs),
          },
        })
        .catch(() => {});
      await input.services.store
        .addRunEvent({
          runId: input.runId,
          level: "info",
          phase: "retrieve",
          eventType: "research_iteration_completed",
          message: `Iteration ${iterationEntry.iteration} completed (netNewSources=${iterationEntry.netNewSources}, mode=${iterationEntry.mode}, stopReason=budget_exhausted)`,
          data: {
            iteration: iterationEntry.iteration,
            netNewSources: iterationEntry.netNewSources,
            mode: iterationEntry.mode,
            stopReason: "budget_exhausted",
          },
        })
        .catch(() => {});
      break;
    }

    if (reviewOutput.verdict === "reject") {
      loopState.rejectCount += 1;
      if (
        loopState.modeSetting === "auto" &&
        loopState.mode !== "hybrid" &&
        loopState.rejectCount >= loopState.switchToHybridAfterRejects
      ) {
        loopState.mode = "hybrid";
        await input.services.store
          .addRunEvent({
            runId: input.runId,
            level: "warn",
            phase: "synthesize",
            eventType: "research_loop_mode_switched",
            message: `Switching to hybrid mode after ${loopState.rejectCount} reviewer rejects`,
            data: {
              iteration: iterationEntry.iteration,
              rejectCount: loopState.rejectCount,
              switchToHybridAfterRejects: loopState.switchToHybridAfterRejects,
            },
          })
          .catch(() => {});
      }
    }

    const gapKey = iterationEntry.artifacts.gapAnalysisKey;
    const gap =
      (await input.services.objectStore.getJson<GapAnalysisOutput>(gapKey)) ??
      (await (async () => {
        if (!input.services.modelProvider) {
          const normalized = GapAnalysisOutputSchema.parse(
            normalizeGapAnalysisOutput({
              nextQueries: [],
              nextTasks: [],
              stop: true,
              stopReason: "no_model_provider",
            }),
          );
          await input.services.objectStore.putJson(gapKey, normalized);
          return normalized;
        }

        const remaining = {
          timeRemainingMs: Math.max(0, input.deadlineMs - Date.now()),
          sourcesRemaining: Math.max(0, input.budgets.maxSources - existing.sources.length),
          fetchesRemaining: Math.max(0, input.budgets.maxFetches - input.checkpoint.counters.fetches),
          rendersRemaining: Math.max(0, input.budgets.maxBrowserRenders - input.checkpoint.counters.renders),
        };

        const sys: ChatMessage = {
          role: "system",
          content:
            "You are a goal-directed research planner. Produce JSON only (no markdown). " +
            "Update per-question status for unblocked questions and propose targeted next web search queries " +
            "for the unanswered/partially-answered unblocked questions. " +
            "Only mark a question `answered` if you can cite at least one provided source label (S1, S2, ...). " +
            "A question may also be `answered` by concluding that the requested requirement/threshold/guideline is not " +
            "publicly specified in the relevant guidance/policy; if so, state that explicitly in the evidence notes and " +
            "cite the most authoritative sources you checked that demonstrate the scope/absence.",
        };
        const user: ChatMessage = {
          role: "user",
          content: JSON.stringify({
            task: "Goal-directed question tracking + next-step selection",
            prompt: input.prompt,
            questionGraph,
            unblockedQuestions: computeUnblockedQuestions(questionGraph).map((q) => ({
              id: q.id,
              text: q.text,
              status: q.status,
              dependsOn: q.dependsOn,
            })),
            interimSynthesis: {
              summary: interimSynthesis.summary,
              keyFindings: interimSynthesis.keyFindings.slice(0, 12),
              unknowns: interimSynthesis.unknowns,
              recommendations: interimSynthesis.recommendations ?? [],
              negativeSpace: interimSynthesis.negativeSpace ?? null,
            },
            sources: allLabeledSources.map((s) => ({
              source: s.label,
              url: s.url,
              title: s.title,
              publisher: s.publisher,
            })),
            citationValidation: {
              coverage: report.coverage,
              topIssues: summarizeTopIssues(report, 12),
            },
            reviewer: {
              verdict: reviewOutput.verdict,
              missingEvidence: reviewOutput.missingEvidence.slice(0, 12),
              requestedRevisions: reviewOutput.requestedRevisions.slice(0, 12),
              confidenceRisk: reviewOutput.confidenceRisk,
            },
            seen: {
              queries: Array.from(seenQueries).slice(-50),
            },
            remaining,
            outputSchema: {
              questionUpdates: [
                {
                  id: "q1",
                  status: "partial",
                  evidence: [{ source: "S1", quoteId: "Q1", note: "evidence note" }],
                  confidence: 0.6,
                },
              ],
              nextQueries: ["..."],
              nextTasks: ["..."],
              stop: false,
              stopReason:
                "questions_answered | diminishing_returns | budget_exhausted | no_new_sources | iteration_cap",
              planNotes: ["..."],
            },
            constraints: {
              onlyUpdateUnblockedQuestions: true,
              maxNextQueries: 8,
              maxNextTasks: 8,
              dedupeAgainstSeenQueries: true,
            },
          }),
        };

        const parsed = await input.steps.callModelJsonLogged({
          runId: input.runId,
          userId: input.userId,
          phase: "gap-analysis",
          persona: "goal-directed-gap-analysis",
          provider: input.services.modelProvider,
          model: input.models.planner,
          messages: [sys, user],
          schema: GapAnalysisModelSchema,
          reasoningEffort: input.thinkingMode,
          store: input.services.store,
          objectStore: input.services.objectStore,
          checkpoint: input.checkpoint,
          promptVersion: "gap-analysis.goal-directed.v1",
        });
        const normalized = GapAnalysisOutputSchema.parse(normalizeGapAnalysisOutput(parsed));
        await input.services.objectStore.putJson(gapKey, normalized);
        return normalized;
      })());

    const questionGraphBeforeUpdate = questionGraph;
    const updateDiagnostics: {
      applied: Array<{
        id: string;
        fromStatus: QuestionStatus;
        toStatus: QuestionStatus;
        requestedStatus: QuestionStatus;
        confidence?: number;
        evidenceSources: string[];
        demotedAnswered: boolean;
      }>;
      ignored: Array<{ id: string; reason: "unknown_question_id" | "blocked" }>;
    } = {
      applied: [],
      ignored: [],
    };

    const rawQuestionUpdates = gap.questionUpdates ?? [];
    if (rawQuestionUpdates.length > 0) {
      const questionIdSet = new Set(questionGraph.questions.map((q) => q.id));
      const unblockedIds = new Set(computeUnblockedQuestions(questionGraph).map((q) => q.id));

      for (const u of rawQuestionUpdates) {
        if (!questionIdSet.has(u.id)) {
          updateDiagnostics.ignored.push({ id: u.id, reason: "unknown_question_id" });
          continue;
        }
        if (!unblockedIds.has(u.id)) {
          updateDiagnostics.ignored.push({ id: u.id, reason: "blocked" });
        }
      }

      const updatesToApply = rawQuestionUpdates
        .filter((u) => unblockedIds.has(u.id))
        .map((u) => ({
          id: u.id,
          status: u.status as QuestionStatus,
          evidence: u.evidence ?? [],
          ...(u.confidence !== undefined ? { confidence: u.confidence } : {}),
        }));

      if (updatesToApply.length > 0) {
        questionGraph = applyQuestionUpdates({
          graph: questionGraph,
          updates: updatesToApply,
          iteration: iterationEntry.iteration,
        });
        (input.checkpoint as { questionGraph?: QuestionGraph }).questionGraph = questionGraph;
        await persistCheckpoint();
      }

      const beforeById = new Map(questionGraphBeforeUpdate.questions.map((q) => [q.id, q]));
      const afterById = new Map(questionGraph.questions.map((q) => [q.id, q]));

      for (const u of updatesToApply) {
        const before = beforeById.get(u.id);
        const after = afterById.get(u.id);
        if (!before || !after) continue;
        const evidenceSources = Array.from(
          new Set((u.evidence ?? []).map((e) => (typeof e.source === "string" ? e.source.trim() : "")).filter(Boolean))
        );
        const demotedAnswered = u.status === "answered" && after.status !== "answered";
        updateDiagnostics.applied.push({
          id: u.id,
          fromStatus: before.status,
          toStatus: after.status,
          requestedStatus: u.status,
          ...(u.confidence !== undefined ? { confidence: u.confidence } : {}),
          evidenceSources,
          demotedAnswered,
        });
      }
    }

    // Heuristic: if an unblocked question is repeatedly reported as unanswered with confidence=0 and
    // no evidence across multiple iterations, treat it as "unanswerable within the retrieved corpus"
    // so it stops blocking the run forever.
    const UNANSWERABLE_STREAK_THRESHOLD = 2;
    const unblockedIdsForStreak = new Set(computeUnblockedQuestions(questionGraph).map((q) => q.id));
    const unansweredStreaks = loopState.unansweredStreaks;
    const newlyUnanswerable: Array<{ id: string; streak: number }> = [];

    for (const q of questionGraph.questions) {
      const isCandidate =
        unblockedIdsForStreak.has(q.id) &&
        q.status === "unanswered" &&
        (q.evidence?.length ?? 0) === 0 &&
        q.confidence === 0;

      const nextStreak = isCandidate ? (unansweredStreaks[q.id] ?? 0) + 1 : 0;
      unansweredStreaks[q.id] = nextStreak;

      if (isCandidate && nextStreak >= UNANSWERABLE_STREAK_THRESHOLD) {
        newlyUnanswerable.push({ id: q.id, streak: nextStreak });
      }
    }

    if (newlyUnanswerable.length > 0) {
      const byId = new Map(newlyUnanswerable.map((u) => [u.id, u]));
      questionGraph = validateQuestionGraph({
        ...questionGraph,
        questions: questionGraph.questions.map((q) => {
          const match = byId.get(q.id);
          if (!match) return q;
          return {
            ...q,
            status: "unanswerable",
            evidence: [
              {
                note:
                  `Marked unanswerable after ${match.streak} iterations with no evidence (confidence=0). ` +
                  "This indicates the answer was not found in the retrieved public sources for this run.",
              },
            ],
            updatedAtIteration: iterationEntry.iteration,
          };
        }),
      });
      (input.checkpoint as { questionGraph?: QuestionGraph }).questionGraph = questionGraph;

      await input.services.store
        .addRunEvent({
          runId: input.runId,
          level: "info",
          phase: "plan",
          eventType: "question_marked_unanswerable",
          message: `Marked ${newlyUnanswerable.length} question(s) as unanswerable after repeated zero-evidence iterations`,
          data: {
            iteration: iterationEntry.iteration,
            threshold: UNANSWERABLE_STREAK_THRESHOLD,
            questions: newlyUnanswerable,
          },
        })
        .catch(() => {});
    }

    const questionCounts = {
      total: questionGraph.questions.length,
      answered: questionGraph.questions.filter((q) => q.status === "answered").length,
      unanswerable: questionGraph.questions.filter((q) => q.status === "unanswerable").length,
      partial: questionGraph.questions.filter((q) => q.status === "partial").length,
      unanswered: questionGraph.questions.filter((q) => q.status === "unanswered").length,
    };

    const unblocked = computeUnblockedQuestions(questionGraph);
    const unblockedIdsAfter = new Set(unblocked.map((q) => q.id));
    const blocked = questionGraph.questions.filter((q) => !unblockedIdsAfter.has(q.id));
    const unblockedCounts = {
      total: unblocked.length,
      answered: unblocked.filter((q) => q.status === "answered").length,
      unanswerable: unblocked.filter((q) => q.status === "unanswerable").length,
      partial: unblocked.filter((q) => q.status === "partial").length,
      unanswered: unblocked.filter((q) => q.status === "unanswered").length,
    };
    const blockedCounts = {
      total: blocked.length,
      answered: blocked.filter((q) => q.status === "answered").length,
      unanswerable: blocked.filter((q) => q.status === "unanswerable").length,
      partial: blocked.filter((q) => q.status === "partial").length,
      unanswered: blocked.filter((q) => q.status === "unanswered").length,
    };
    const openUnblocked = unblocked.filter((q) => q.status !== "answered" && q.status !== "unanswerable");
    const openUnblockedLabels = openUnblocked
      .slice(0, 6)
      .map((q) => `${q.id}=${q.status}${q.confidence !== undefined ? `(${q.confidence.toFixed(2)})` : ""}`);

    const questionStop = stopForQuestions(questionGraph);

    await input.services.store
      .addRunEvent({
        runId: input.runId,
        level: "info",
        phase: "plan",
        eventType: "research_iteration_gap_analysis_completed",
        message:
          `Iteration ${iterationEntry.iteration} goal-directed update: stop=${questionStop} ` +
          `answered=${questionCounts.answered}/${questionCounts.total} partial=${questionCounts.partial} ` +
          `unblockedAnswered=${unblockedCounts.answered}/${unblockedCounts.total} ` +
          `unblockedOpen=${openUnblocked.length}/${unblockedCounts.total} ` +
          `nextQueries=${gap.nextQueries.length} nextTasks=${gap.nextTasks.length}` +
          (openUnblockedLabels.length ? `\n  Open unblocked: ${openUnblockedLabels.join(", ")}` : ""),
        data: {
          iteration: iterationEntry.iteration,
          stop: questionStop,
          stopReason: questionStop ? "questions_answered" : null,
          questionCounts,
          unblockedCounts,
          blockedCounts,
          openUnblocked: openUnblocked.map((q) => ({
            id: q.id,
            status: q.status,
            dependsOn: q.dependsOn,
            confidence: q.confidence ?? null,
          })),
          blocked: blocked.slice(0, 12).map((q) => ({
            id: q.id,
            status: q.status,
            dependsOn: q.dependsOn,
          })),
          questionUpdatesApplied: updateDiagnostics.applied,
          questionUpdatesIgnored: updateDiagnostics.ignored,
          nextQueries: gap.nextQueries.slice(0, 6),
          nextTasks: gap.nextTasks.slice(0, 6),
          planNotes: gap.planNotes?.slice(0, 6) ?? [],
        },
      })
      .catch(() => {});

    if (rawQuestionUpdates.length > 0 || openUnblocked.length > 0) {
      const graphById = new Map(questionGraph.questions.map((q) => [q.id, q]));
      const blockedLines = blocked
        .slice(0, 12)
        .map((q) => {
          const waitingOn = q.dependsOn
            .map((dep) => graphById.get(dep))
            .filter(Boolean)
            .filter((dep) => dep!.status !== "answered")
            .map((dep) => dep!.id);
          return `${q.id}(${q.status}) waitingOn=${waitingOn.length ? waitingOn.join(",") : "n/a"}`;
        });
      const updateLines = updateDiagnostics.applied.map(
        (u) =>
          `${u.id} ${u.fromStatus}->${u.toStatus}` +
          (u.demotedAnswered ? " (demoted)" : "") +
          (u.evidenceSources.length ? ` evidence=${u.evidenceSources.join(",")}` : "") +
          (u.confidence !== undefined ? ` conf=${u.confidence.toFixed(2)}` : "")
      );

      const debugMessageLines = [
        `Goal-directed debug (iteration ${iterationEntry.iteration})`,
        `  Totals: answered=${questionCounts.answered}/${questionCounts.total} partial=${questionCounts.partial} unanswered=${questionCounts.unanswered}`,
        `  Unblocked: answered=${unblockedCounts.answered}/${unblockedCounts.total} partial=${unblockedCounts.partial} open=${openUnblocked.length}`,
        ...(openUnblockedLabels.length ? [`  Open unblocked: ${openUnblockedLabels.join(", ")}`] : []),
        ...(updateLines.length ? [`  Applied updates: ${updateLines.join(" | ")}`] : []),
        ...(updateDiagnostics.ignored.length
          ? [
              `  Ignored updates: ${updateDiagnostics.ignored
                .slice(0, 12)
                .map((u) => `${u.id}(${u.reason})`)
                .join(" | ")}`,
            ]
          : []),
        ...(blockedLines.length ? [`  Blocked: ${blockedLines.join(" | ")}`] : []),
        ...(gap.planNotes && gap.planNotes.length
          ? [`  Plan notes: ${gap.planNotes.slice(0, 6).join(" | ")}`]
          : []),
      ];

      await input.services.store
        .addRunEvent({
          runId: input.runId,
          level: "debug",
          phase: "plan",
          eventType: "research_iteration_goal_directed_debug",
          message: debugMessageLines.join("\n"),
          data: {
            iteration: iterationEntry.iteration,
            questionCounts,
            unblockedCounts,
            blockedCounts,
            questionGraph: {
              validated: questionGraph.validated,
              questions: questionGraph.questions.map((q) => ({
                id: q.id,
                status: q.status,
                dependsOn: q.dependsOn,
                confidence: q.confidence ?? null,
              })),
            },
            questionUpdatesApplied: updateDiagnostics.applied,
            questionUpdatesIgnored: updateDiagnostics.ignored,
            planNotes: gap.planNotes ?? [],
          },
        })
        .catch(() => {});
    }

    iterationEntry.gapAnalysisStop = questionStop || gap.stop;
    if (questionStop) iterationEntry.gapAnalysisStopReason = "questions_answered";
    else if (gap.stopReason) iterationEntry.gapAnalysisStopReason = gap.stopReason;

    const nextQueriesOut = questionStop
      ? []
      : dedupeStrings(gap.nextQueries).filter((q) => !seenQueries.has(q));
    const nextTasksOut = questionStop
      ? []
      : dedupeStrings(gap.nextTasks).filter((t) => !seenTasks.has(t));

    loopState.pending = {
      queries: nextQueriesOut,
      tasks: nextTasksOut,
    };

    const lowValue = iterationEntry.netNewSources <= 1;
    loopState.lowValueIterationStreak = lowValue ? loopState.lowValueIterationStreak + 1 : 0;

    await persistIterationPlanVersion(iterationEntry, gap, report, reviewOutput);

    let shouldStop = false;
    let stopReason: ResearchLoopStopReason | undefined;

    if (questionStop) {
      shouldStop = true;
      stopReason = "questions_answered";
    } else if (gap.stop) {
      shouldStop = true;
      stopReason = mapStopReasonFromGapAnalysis(gap);
    } else if (iterationEntry.iteration >= loopState.maxIterations) {
      shouldStop = true;
      stopReason = "iteration_cap";
    } else if (remainingTimeMs(input.deadlineMs) <= LAND_THE_PLANE_FINALIZE_RESERVE_MS) {
      shouldStop = true;
      stopReason = "budget_exhausted";
    } else if (selectedNewUrls.length === 0) {
      shouldStop = true;
      stopReason = "no_new_sources";
    } else if (
      shouldStopForDiminishingReturns({
        lowValueIterationStreak: loopState.lowValueIterationStreak,
        nextStepsEmpty: nextQueriesOut.length + nextTasksOut.length === 0,
      })
    ) {
      shouldStop = true;
      stopReason = "diminishing_returns";
    }

    if (shouldStop && stopReason) {
      loopState.stopReason = stopReason;
      iterationEntry.stopReason = stopReason;
    }

    iterationEntry.completedAt = new Date().toISOString();
    loopState.iterationCountCompleted = iterationEntry.iteration;
    await persistCheckpoint();
    await persistImmutableCheckpoint({
      kind: "iteration",
      iterationCompleted: loopState.iterationCountCompleted,
      sources: allLabeledSources,
    });

    await input.services.store
      .addRunEvent({
        runId: input.runId,
        level: shouldStop ? "info" : "info",
        phase: "retrieve",
        eventType: "research_iteration_completed",
        message: `Iteration ${iterationEntry.iteration} completed (netNewSources=${iterationEntry.netNewSources}, mode=${iterationEntry.mode}${stopReason ? `, stopReason=${stopReason}` : ""})`,
        data: {
          iteration: iterationEntry.iteration,
          netNewSources: iterationEntry.netNewSources,
          mode: iterationEntry.mode,
          stopReason: stopReason ?? null,
        },
      })
      .catch(() => {});

    if (stopReason) break;
  }

  const finalStopReason = loopState.stopReason ?? "iteration_cap";
  const finalMode = selectOperationalMode(loopState);

  let finalSynthesisWritten = false;
  if (finalMode === "hybrid") {
    const allLabeledSources = await input.steps.loadLabeledSources({
      runId: input.runId,
      checkpoint: input.checkpoint,
      store: input.services.store,
      objectStore: input.services.objectStore,
    });
    const finalSynthesis = await input.steps.synthesize({
      runId: input.runId,
      userId: input.userId,
      prompt: input.prompt,
      sources: allLabeledSources,
      citationPolicy: input.citationPolicy,
      provider: input.services.modelProvider,
      model: input.models.synthesizer,
      thinkingMode: input.thinkingMode,
      maxInputTokens: input.synthesis.maxInputTokens,
      maxOutputTokens: input.synthesis.maxOutputTokens,
      requestedMaxInputTokens: input.synthesis.requestedMaxInputTokens,
      requestedMaxOutputTokens: input.synthesis.requestedMaxOutputTokens,
      synthesisContextWindowTokens: input.synthesis.contextWindowTokens,
      store: input.services.store,
      objectStore: input.services.objectStore,
      checkpoint: input.checkpoint,
      reviewPolicy: "skip",
    });
    const synthesisKey = runSynthesisKey(input.runId);
    await input.services.objectStore.putJson(synthesisKey, finalSynthesis);
    input.checkpoint.artifacts.synthesisKey = synthesisKey;

    const finalReviewKey = runFinalSynthesisReviewKey(input.runId);
    let finalReview: IterationReviewOutput = {
      verdict: "accept",
      unsupportedConclusions: [],
      missingEvidence: [],
      requestedRevisions: [],
    };
    if (input.services.modelProvider) {
      finalReview = await input.steps.review({
        runId: input.runId,
        userId: input.userId,
        prompt: input.prompt,
        sources: allLabeledSources,
        synthesis: finalSynthesis,
        provider: input.services.modelProvider,
        model: input.models.verifierStrong,
        thinkingMode: input.thinkingMode,
        store: input.services.store,
        objectStore: input.services.objectStore,
        checkpoint: input.checkpoint,
      });
    }
    await input.services.objectStore.putJson(finalReviewKey, finalReview);
    await input.services.store
      .addRunEvent({
        runId: input.runId,
        level: "info",
        phase: "verify",
        eventType: "research_loop_final_synthesis_review_completed",
        message: `Final full synthesis review: ${finalReview.verdict}`,
        data: {
          verdict: finalReview.verdict,
          missingEvidence: finalReview.missingEvidence.slice(0, 4),
          requestedRevisions: finalReview.requestedRevisions.slice(0, 4),
        },
      })
      .catch(() => {});
    finalSynthesisWritten = true;
  } else if (loopState.lastSynthesisKey) {
    const synthesis = await input.services.objectStore.getJson<SynthesisOutput>(loopState.lastSynthesisKey);
    if (synthesis) {
      const synthesisKey = runSynthesisKey(input.runId);
      await input.services.objectStore.putJson(synthesisKey, synthesis);
      input.checkpoint.artifacts.synthesisKey = synthesisKey;
      finalSynthesisWritten = true;
    }
  }

  if (!finalSynthesisWritten) {
    const allLabeledSources = await input.steps.loadLabeledSources({
      runId: input.runId,
      checkpoint: input.checkpoint,
      store: input.services.store,
      objectStore: input.services.objectStore,
    });
    const synthesis = await input.steps.synthesize({
      runId: input.runId,
      userId: input.userId,
      prompt: input.prompt,
      sources: allLabeledSources,
      citationPolicy: input.citationPolicy,
      provider: input.services.modelProvider,
      model: input.models.synthesizer,
      thinkingMode: input.thinkingMode,
      maxInputTokens: input.synthesis.maxInputTokens,
      maxOutputTokens: input.synthesis.maxOutputTokens,
      requestedMaxInputTokens: input.synthesis.requestedMaxInputTokens,
      requestedMaxOutputTokens: input.synthesis.requestedMaxOutputTokens,
      synthesisContextWindowTokens: input.synthesis.contextWindowTokens,
      store: input.services.store,
      objectStore: input.services.objectStore,
      checkpoint: input.checkpoint,
      reviewPolicy: "skip",
    });
    const synthesisKey = runSynthesisKey(input.runId);
    await input.services.objectStore.putJson(synthesisKey, synthesis);
    input.checkpoint.artifacts.synthesisKey = synthesisKey;
  }

  await input.services.store
    .addRunEvent({
      runId: input.runId,
      level: "info",
      phase: "retrieve",
      eventType: "research_loop_stopped",
      message: `Research loop stopped (stopReason=${finalStopReason}, mode=${finalMode}, iterations=${loopState.iterationCountCompleted})`,
      data: {
        stopReason: finalStopReason,
        mode: finalMode,
        iterations: loopState.iterationCountCompleted,
      },
    })
    .catch(() => {});

  loopState.stopReason = finalStopReason;
  await input.services.store.updateRun({ runId: input.runId, state: input.checkpoint });

  return { stopReason: finalStopReason, mode: finalMode };
}
