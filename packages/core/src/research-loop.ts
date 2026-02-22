import { z } from "zod";

import type { BudgetConfig, CitationPolicy, PhaseModelConfig, ResearchLoopConfig, ThinkingMode } from "./config.js";
import type { SearchAdapter, HttpFetchAdapter, BrowserRenderAdapter } from "./adapters.js";
import type { ChatMessage, ModelProvider } from "./models.js";
import type { LabeledSource, SynthesisOutput } from "./memo.js";
import {
  QuestionGraphSchema,
  computeUnblockedQuestions,
  normalizeQuestionAnsweredRubric,
  validateQuestionGraph,
} from "./goal-directed.js";
import type { QuestionEvidence, QuestionGraph, QuestionStatus } from "./goal-directed.js";
import {
  iterationCompressionKey,
  iterationGapAnalysisKey,
  iterationGapDiagnosticsKey,
  iterationOutlinePlanKey,
  iterationPlanKey,
  iterationRetrievalKey,
  runOutlinePlanKey,
  runPlanKey,
  sourceEvidenceKey,
} from "./artifacts.js";
import { coerceOutlinePlan, OutlinePlanSchema } from "./outline-plan.js";
import type { OutlinePlan } from "./outline-plan.js";

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
    outlinePlanKey: string;
    compressionKey: string;
    retrievalKey: string;
    gapAnalysisKey: string;
    gapDiagnosticsKey: string;
  };
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
  dynamicOutlineEnabled: boolean;
  rejectCount: number;
  iterationCountCompleted: number;
  stopReason?: ResearchLoopStopReason;
  seenUrls: string[];
  seenQueries: string[];
  seenTasks: string[];
  unansweredStreaks: Record<string, number>;
  pending: { queries: string[]; tasks: string[] };
  lastCompressionKey?: string;
  planVersionKeys: string[];
  lowValueIterationStreak: number;
  currentOutlinePlan?: OutlinePlan;
  iterations: ResearchLoopIterationState[];
};

const InitialPlanSchema = z.object({
  subquestions: z.array(z.string()).default([]),
  queries: z.array(z.string()).default([]),
  outlinePlan: OutlinePlanSchema.optional(),
});

const GapAnalysisModelSchema = z.object({
  questionUpdates: z
    .array(
      z.object({
        id: z.string().min(1),
        status: z.enum(["unanswered", "partial", "answered", "unanswerable"]),
        evidence: z
          .array(
            z.object({
              source: z.string().min(1).optional(),
              quoteId: z.string().min(1).optional(),
              note: z.string().min(1).optional(),
            })
          )
          .default([]),
        confidence: z.number().min(0).max(1).optional(),
      })
    )
    .default([]),
  nextQueries: z.array(z.string().min(1)).default([]),
  nextTasks: z.array(z.string().min(1)).default([]),
  outlinePlan: OutlinePlanSchema.optional(),
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

export type GapAnalysisNormalizationDiagnostics = {
  changed: boolean;
  fallbackUsed: boolean;
  dropped: {
    stopReasonEmpty: boolean;
    emptyQuoteIds: number;
    nextQueries: number;
    nextTasks: number;
    planNotes: number;
  };
  trimmed: {
    stopReason: boolean;
    quoteIds: number;
    nextQueries: number;
    nextTasks: number;
    planNotes: number;
  };
  deduped: {
    nextQueries: number;
    nextTasks: number;
    planNotes: number;
  };
  clampedConfidenceCount: number;
  outlineVersionCoerced: boolean;
  parseError?: {
    name: string;
    message: string;
  };
};

function createGapAnalysisNormalizationDiagnostics(): GapAnalysisNormalizationDiagnostics {
  return {
    changed: false,
    fallbackUsed: false,
    dropped: {
      stopReasonEmpty: false,
      emptyQuoteIds: 0,
      nextQueries: 0,
      nextTasks: 0,
      planNotes: 0,
    },
    trimmed: {
      stopReason: false,
      quoteIds: 0,
      nextQueries: 0,
      nextTasks: 0,
      planNotes: 0,
    },
    deduped: {
      nextQueries: 0,
      nextTasks: 0,
      planNotes: 0,
    },
    clampedConfidenceCount: 0,
    outlineVersionCoerced: false,
  };
}

function normalizeGapAnalysisOutput(raw: unknown): {
  value: unknown;
  diagnostics: GapAnalysisNormalizationDiagnostics;
} {
  const diagnostics = createGapAnalysisNormalizationDiagnostics();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { value: raw, diagnostics };
  }

  const cast = raw as Record<string, unknown>;
  const normalized: Record<string, unknown> = { ...cast };
  let changed = false;

  const normalizeStringList = (
    field: "nextQueries" | "nextTasks" | "planNotes"
  ): void => {
    const current = normalized[field];
    if (!Array.isArray(current)) return;

    const out: string[] = [];
    const seen = new Set<string>();

    for (const item of current) {
      if (typeof item !== "string") {
        diagnostics.dropped[field] += 1;
        changed = true;
        continue;
      }

      const trimmed = item.trim();
      if (trimmed !== item) {
        diagnostics.trimmed[field] += 1;
        changed = true;
      }

      if (!trimmed) {
        diagnostics.dropped[field] += 1;
        changed = true;
        continue;
      }

      if (seen.has(trimmed)) {
        diagnostics.deduped[field] += 1;
        changed = true;
        continue;
      }

      seen.add(trimmed);
      out.push(trimmed);
    }

    normalized[field] = out;
  };

  if (typeof normalized.stopReason === "string") {
    const trimmed = normalized.stopReason.trim();
    if (!trimmed) {
      diagnostics.dropped.stopReasonEmpty = true;
      delete normalized.stopReason;
      changed = true;
    } else if (trimmed !== normalized.stopReason) {
      diagnostics.trimmed.stopReason = true;
      normalized.stopReason = trimmed;
      changed = true;
    }
  }

  normalizeStringList("nextQueries");
  normalizeStringList("nextTasks");
  normalizeStringList("planNotes");

  if (Array.isArray(normalized.questionUpdates)) {
    const updates = normalized.questionUpdates.map((update) => {
      if (!update || typeof update !== "object" || Array.isArray(update)) return update;
      const updateRecord = update as Record<string, unknown>;
      const nextUpdate: Record<string, unknown> = { ...updateRecord };
      let updateChanged = false;

      if (typeof nextUpdate.confidence === "number" && Number.isFinite(nextUpdate.confidence)) {
        const clamped = Math.max(0, Math.min(1, nextUpdate.confidence));
        if (clamped !== nextUpdate.confidence) {
          diagnostics.clampedConfidenceCount += 1;
          nextUpdate.confidence = clamped;
          updateChanged = true;
        }
      }

      if (Array.isArray(nextUpdate.evidence)) {
        let evidenceChanged = false;
        const evidence = nextUpdate.evidence.map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
          const evidenceRecord = entry as Record<string, unknown>;
          const nextEvidence: Record<string, unknown> = { ...evidenceRecord };
          let localChanged = false;

          if (typeof nextEvidence.quoteId === "string") {
            const trimmedQuoteId = nextEvidence.quoteId.trim();
            if (!trimmedQuoteId) {
              diagnostics.dropped.emptyQuoteIds += 1;
              delete nextEvidence.quoteId;
              localChanged = true;
            } else if (trimmedQuoteId !== nextEvidence.quoteId) {
              diagnostics.trimmed.quoteIds += 1;
              nextEvidence.quoteId = trimmedQuoteId;
              localChanged = true;
            }
          }

          if (localChanged) {
            evidenceChanged = true;
            return nextEvidence;
          }
          return entry;
        });
        if (evidenceChanged) {
          nextUpdate.evidence = evidence;
          updateChanged = true;
        }
      }

      if (updateChanged) {
        changed = true;
        return nextUpdate;
      }
      return update;
    });
    normalized.questionUpdates = updates;
  }

  if (normalized.outlinePlan && typeof normalized.outlinePlan === "object" && !Array.isArray(normalized.outlinePlan)) {
    const outlinePlan = normalized.outlinePlan as Record<string, unknown>;
    if (outlinePlan.version !== undefined && outlinePlan.version !== 1) {
      diagnostics.outlineVersionCoerced = true;
      normalized.outlinePlan = { ...outlinePlan, version: 1 };
      changed = true;
    }
  }

  diagnostics.changed = changed;
  return { value: normalized, diagnostics };
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

export type IterationCompression = {
  summary: string;
  sourceAbstracts: Array<{
    source: string;
    methodology: string;
    temporalContext: string;
    dataTypes: string[];
    stakeholderPosition: string;
    representativeClaims: string[];
    keyConstraints: string[];
  }>;
  criticalSourceContexts: Array<{ source: string; reason: string; excerpt: string }>;
  synthesisNotes: string[];
  sourceCount: number;
  quoteCount: number;
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
  compress?: (input: {
    runId: string;
    userId: string;
    prompt: string;
    sources: LabeledSource[];
    citationPolicy: CitationPolicy;
    provider: ModelProvider | undefined;
    model: string;
    thinkingMode: ThinkingMode;
    store: PipelineStore;
    objectStore: ObjectStore;
    checkpoint: RunCheckpoint;
  }) => Promise<IterationCompression>;
  synthesize?: (input: {
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
    outlinePlan?: OutlinePlan;
    reviewPolicy?: "enforce" | "skip";
  }) => Promise<SynthesisOutput>;
  review?: (input: {
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

function defaultLoopCheckpoint(input: {
  enabled: boolean;
  config: ResearchLoopConfig;
  initialQueries: string[];
  initialOutlinePlan?: OutlinePlan;
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
      dynamicOutlineEnabled: input.config.dynamicOutlineEnabled === true,
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
      ...(input.initialOutlinePlan ? { currentOutlinePlan: input.initialOutlinePlan } : {}),
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
  const dynamicOutlineEnabled =
    typeof o.dynamicOutlineEnabled === "boolean"
      ? o.dynamicOutlineEnabled
      : fallback.dynamicOutlineEnabled;
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
      dynamicOutlineEnabled,
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
	    ...(typeof (o as { lastCompressionKey?: unknown }).lastCompressionKey === "string"
	      ? { lastCompressionKey: (o as { lastCompressionKey: string }).lastCompressionKey }
	      : fallback.lastCompressionKey
	        ? { lastCompressionKey: fallback.lastCompressionKey }
	        : {}),
      ...(coerceOutlinePlan((o as { currentOutlinePlan?: unknown }).currentOutlinePlan)
        ? {
            currentOutlinePlan: coerceOutlinePlan(
              (o as { currentOutlinePlan?: unknown }).currentOutlinePlan
            )!,
          }
        : fallback.currentOutlinePlan
          ? { currentOutlinePlan: fallback.currentOutlinePlan }
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

function deriveQueriesFromTasks(input: {
  tasks: string[];
  maxQueries: number;
}): { queries: string[]; filteredTaskCount: number } {
  const out: string[] = [];
  let filteredTaskCount = 0;

  for (const rawTask of dedupeStrings(input.tasks)) {
    if (out.length >= input.maxQueries) break;
    let q = rawTask.trim().replace(/\s+/g, " ");
    q = q.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "");
    q = q.replace(/^(task|todo|next\s+step)\s*:\s*/i, "");
    q = q.replace(
      /^(find|search|look\s+up|investigate|review|analyze|assess|evaluate|determine|map|identify|collect|gather|research)\s+(for\s+)?/i,
      ""
    );
    q = q.replace(/[.!?]+$/, "").trim();
    const wordCount = q.length > 0 ? q.split(/\s+/).length : 0;
    if (q.length < 8 || wordCount < 2) {
      filteredTaskCount += 1;
      continue;
    }
    out.push(q);
  }

  return {
    queries: dedupeStrings(out).slice(0, input.maxQueries),
    filteredTaskCount,
  };
}

function buildDeterministicCompression(sources: LabeledSource[]): IterationCompression {
  const sourceAbstracts = sources.map((source) => {
    const representativeClaims = source.quotes
      .slice(0, 3)
      .map((quote) => quote.text.trim())
      .filter(Boolean);
    return {
      source: source.label,
      methodology: "Deterministic fallback: summarized from extracted quote evidence.",
      temporalContext: "Unknown temporal context.",
      dataTypes: representativeClaims.length > 0 ? ["quoted evidence"] : [],
      stakeholderPosition: "Not inferred in deterministic compression fallback.",
      representativeClaims,
      keyConstraints: representativeClaims.length > 0 ? [] : ["No representative claims extracted."],
    };
  });

  const criticalSourceContexts = sources
    .slice(0, 6)
    .map((source) => ({
      source: source.label,
      reason: "High-priority context sample for gap analysis.",
      excerpt: source.quotes.map((q) => q.text).join(" ").slice(0, 2000),
    }))
    .filter((context) => context.excerpt.trim().length > 0);

  const summary =
    sourceAbstracts.length > 0
      ? `Compression snapshot over ${sourceAbstracts.length} source(s): ${sourceAbstracts
          .slice(0, 4)
          .map((source) => source.source)
          .join(", ")}.`
      : "Compression snapshot has no extracted source abstracts yet.";

  return {
    summary,
    sourceAbstracts,
    criticalSourceContexts,
    synthesisNotes: [],
    sourceCount: sources.length,
    quoteCount: sources.reduce((sum, source) => sum + source.quotes.length, 0),
  };
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

function computeQuestionGraphMaxDepth(graph: QuestionGraph): number {
  if (!graph.questions.length) return 0;
  const byId = new Map(graph.questions.map((q) => [q.id, q]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const depthFrom = (id: string): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const q = byId.get(id);
    if (!q) {
      visiting.delete(id);
      memo.set(id, 0);
      return 0;
    }
    let max = 0;
    for (const dep of q.dependsOn) {
      max = Math.max(max, depthFrom(dep));
    }
    visiting.delete(id);
    const depth = q.dependsOn.length ? max + 1 : 0;
    memo.set(id, depth);
    return depth;
  };

  let maxDepth = 0;
  for (const q of graph.questions) {
    maxDepth = Math.max(maxDepth, depthFrom(q.id));
  }
  return maxDepth;
}

function applyQuestionUpdates(input: {
  graph: QuestionGraph;
  updates: Array<{
    id: string;
    status: QuestionStatus;
    evidence: QuestionEvidence[];
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
  const parsedPlan = (() => {
    if (!initialPlan) return InitialPlanSchema.parse({});
    const parsed = InitialPlanSchema.safeParse(initialPlan);
    return parsed.success ? parsed.data : InitialPlanSchema.parse({});
  })();
  const initialQueries = dedupeStrings(parsedPlan.queries.length ? parsedPlan.queries : [input.prompt]);
  const initialOutlinePlan =
    coerceOutlinePlan(
      (input.checkpoint as { outlinePlan?: unknown }).outlinePlan ??
        parsedPlan.outlinePlan ??
        null
    ) ?? null;

  const baseState = defaultLoopCheckpoint({
    enabled: input.loopConfig.enabled,
    config: input.loopConfig,
    initialQueries,
    ...(initialOutlinePlan ? { initialOutlinePlan } : {}),
  });

  const loopState = coerceLoopCheckpointState((input.checkpoint as { researchLoop?: unknown }).researchLoop, baseState);
  (input.checkpoint as { researchLoop?: ResearchLoopCheckpointState }).researchLoop = loopState;
  if (loopState.currentOutlinePlan) {
    (input.checkpoint as { outlinePlan?: OutlinePlan }).outlinePlan = loopState.currentOutlinePlan;
  } else if (initialOutlinePlan) {
    loopState.currentOutlinePlan = initialOutlinePlan;
    (input.checkpoint as { outlinePlan?: OutlinePlan }).outlinePlan = initialOutlinePlan;
  }

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

  const maxFocusRoundsPerQuestion = 2;
  const maxDependencyDepth = computeQuestionGraphMaxDepth(questionGraph);
  const derivedMaxIterations = Math.max(1, maxFocusRoundsPerQuestion * (maxDependencyDepth + 1));
  loopState.maxIterations = derivedMaxIterations;

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
    if (existingEntry) {
      if (!existingEntry.artifacts.compressionKey) {
        existingEntry.artifacts.compressionKey = iterationCompressionKey(input.runId, iteration);
      }
      if (!existingEntry.artifacts.gapDiagnosticsKey) {
        existingEntry.artifacts.gapDiagnosticsKey = iterationGapDiagnosticsKey(input.runId, iteration);
      }
      return existingEntry;
    }
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
        outlinePlanKey: iterationOutlinePlanKey(input.runId, iteration),
        compressionKey: iterationCompressionKey(input.runId, iteration),
        retrievalKey: iterationRetrievalKey(input.runId, iteration),
        gapAnalysisKey: iterationGapAnalysisKey(input.runId, iteration),
        gapDiagnosticsKey: iterationGapDiagnosticsKey(input.runId, iteration),
      },
    };
    loopState.iterations.push(entry);
    return entry;
  };

  const persistCheckpoint = async (): Promise<void> => {
    await input.services.store.updateRun({ runId: input.runId, state: input.checkpoint });
    if (loopState.currentOutlinePlan) {
      await input.services.objectStore
        .putJson(runOutlinePlanKey(input.runId), loopState.currentOutlinePlan)
        .catch(() => {});
    }
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
      outlinePlan: loopState.currentOutlinePlan ?? null,
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

  const persistIterationPlanVersion = async (
    iterationEntry: ResearchLoopIterationState,
    gap: GapAnalysisOutput,
    compression: IterationCompression
  ): Promise<void> => {
    const effectiveOutlinePlan =
      coerceOutlinePlan(gap.outlinePlan, { fallback: loopState.currentOutlinePlan ?? null }) ??
      loopState.currentOutlinePlan ??
      null;
    if (effectiveOutlinePlan) {
      loopState.currentOutlinePlan = effectiveOutlinePlan;
      (input.checkpoint as { outlinePlan?: OutlinePlan }).outlinePlan = effectiveOutlinePlan;
    }

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
        compression: {
          summary: compression.summary,
          sourceCount: compression.sourceCount,
          quoteCount: compression.quoteCount,
          sourceAbstractCount: compression.sourceAbstracts.length,
          criticalContextCount: compression.criticalSourceContexts.length,
          synthesisNotes: compression.synthesisNotes.slice(0, 8),
        },
        questionUpdates: gap.questionUpdates ?? [],
        nextQueries: gap.nextQueries,
        nextTasks: gap.nextTasks,
        stop: gap.stop,
        stopReason: gap.stopReason ?? null,
        planNotes: gap.planNotes ?? [],
        outlinePlan: effectiveOutlinePlan,
      },
    };
    await input.services.objectStore.putJson(iterationEntry.artifacts.planKey, payload);
    if (effectiveOutlinePlan) {
      await input.services.objectStore.putJson(
        iterationEntry.artifacts.outlinePlanKey,
        effectiveOutlinePlan
      );
    }
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
          dynamicOutlineEnabled: loopState.dynamicOutlineEnabled,
        },
      })
      .catch(() => {});

  while (!loopState.stopReason && loopState.iterationCountCompleted < loopState.maxIterations) {
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
    const taskFallback = deriveQueriesFromTasks({
      tasks: iterationEntry.tasks,
      maxQueries: 8,
    });
    const retrievalQueries =
      iterationEntry.queries.length > 0 ? iterationEntry.queries : taskFallback.queries;
    await input.services.store
      .addRunEvent({
        runId: input.runId,
        level: "debug",
        phase: "retrieve",
        eventType: "research_iteration_query_selection",
        message: `Iteration ${iterationEntry.iteration} query selection`,
        data: {
          iteration: iterationEntry.iteration,
          nextQueryCount: iterationEntry.queries.length,
          nextTaskCount: iterationEntry.tasks.length,
          usedTaskFallback: iterationEntry.queries.length === 0,
          derivedTaskQueryCount: taskFallback.queries.length,
          filteredTaskCount: taskFallback.filteredTaskCount,
          retrievalQueryCount: retrievalQueries.length > 0 ? retrievalQueries.length : initialQueries.length,
        },
      })
      .catch(() => {});
    const retrieval =
      (await input.services.objectStore.getJson<RetrievalOutput>(retrievalKey)) ??
      (await (async () => {
        const result = await input.steps.retrieve({
          runId: input.runId,
          userId: input.userId,
          budgets: input.budgets,
          queries: retrievalQueries.length ? retrievalQueries : initialQueries,
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

    if (iterationEntry.sourceIds.length > 0) {
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
    }

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
    const compressionKey = iterationEntry.artifacts.compressionKey;
    const compression =
      (await input.services.objectStore.getJson<IterationCompression>(compressionKey)) ??
      (await (async () => {
        if (input.steps.compress) {
          return input.steps.compress({
            runId: input.runId,
            userId: input.userId,
            prompt: input.prompt,
            sources: allLabeledSources,
            citationPolicy: input.citationPolicy,
            provider: input.services.modelProvider,
            model: input.models.synthesizer,
            thinkingMode: input.thinkingMode,
            store: input.services.store,
            objectStore: input.services.objectStore,
            checkpoint: input.checkpoint,
          });
        }
        return buildDeterministicCompression(allLabeledSources);
      })());
    await input.services.objectStore.putJson(compressionKey, compression);
    loopState.lastCompressionKey = compressionKey;
    (input.checkpoint as { synthesisState?: unknown }).synthesisState = {
      snapshotKey: compressionKey,
      summary: compression.summary,
    };
    await persistCheckpoint();

    await input.services.store
      .addRunEvent({
        runId: input.runId,
        level: "info",
        phase: "synthesize",
        eventType: "research_iteration_compression_completed",
        message: `Iteration ${iterationEntry.iteration} compression completed`,
        data: {
          iteration: iterationEntry.iteration,
          sourceCount: compression.sourceCount,
          quoteCount: compression.quoteCount,
          sourceAbstractCount: compression.sourceAbstracts.length,
          criticalContextCount: compression.criticalSourceContexts.length,
        },
      })
      .catch(() => {});

    const gapKey = iterationEntry.artifacts.gapAnalysisKey;
    const gapDiagnosticsKey = iterationEntry.artifacts.gapDiagnosticsKey;
    let gapNormalizationDiagnostics =
      (await input.services.objectStore.getJson<GapAnalysisNormalizationDiagnostics>(gapDiagnosticsKey)) ??
      createGapAnalysisNormalizationDiagnostics();

    const gap =
      (await input.services.objectStore.getJson<GapAnalysisOutput>(gapKey)) ??
      (await (async () => {
        if (!input.services.modelProvider) {
          const normalizedResult = normalizeGapAnalysisOutput({
            questionUpdates: [],
            nextQueries: [],
            nextTasks: [],
            stop: true,
            stopReason: "no_model_provider",
          });
          const normalized = GapAnalysisOutputSchema.parse(normalizedResult.value);
          gapNormalizationDiagnostics = normalizedResult.diagnostics;
          await input.services.objectStore.putJson(gapKey, normalized);
          await input.services.objectStore.putJson(gapDiagnosticsKey, gapNormalizationDiagnostics);
          return normalized;
        }

        const remaining = {
          timeRemainingMs: null,
          timeBudgetEnforced: false,
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
            compression: {
              summary: compression.summary,
              sourceAbstracts: compression.sourceAbstracts.slice(0, 12).map((item) => ({
                source: item.source,
                methodology: item.methodology,
                temporalContext: item.temporalContext,
                dataTypes: item.dataTypes,
                stakeholderPosition: item.stakeholderPosition,
                representativeClaims: item.representativeClaims.slice(0, 4),
                keyConstraints: item.keyConstraints.slice(0, 4),
              })),
              criticalSourceContexts: compression.criticalSourceContexts
                .slice(0, 6)
                .map((context) => ({
                  source: context.source,
                  reason: context.reason,
                  excerpt: context.excerpt.slice(0, 1600),
                })),
              synthesisNotes: compression.synthesisNotes.slice(0, 12),
            },
            outlinePlan:
              loopState.dynamicOutlineEnabled && loopState.currentOutlinePlan
                ? loopState.currentOutlinePlan
                : null,
            sources: allLabeledSources.map((s) => ({
              source: s.label,
              url: s.url,
              title: s.title,
              publisher: s.publisher,
            })),
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
              outlinePlan: {
                version: 1,
                rationale: "...",
                sections: [
                  {
                    id: "summary",
                    heading: "Summary",
                    intent: "Short overview of the answer to the prompt.",
                    dependsOnQuestionIds: [],
                  },
                ],
                notes: ["..."],
              },
            },
            constraints: {
              onlyUpdateUnblockedQuestions: true,
              maxNextQueries: 8,
              maxNextTasks: 8,
              dedupeAgainstSeenQueries: true,
              dynamicOutlineEnabled: loopState.dynamicOutlineEnabled,
            },
          }),
        };

        try {
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

          const normalizedResult = normalizeGapAnalysisOutput(parsed);
          const normalized = GapAnalysisOutputSchema.parse(normalizedResult.value);
          gapNormalizationDiagnostics = normalizedResult.diagnostics;
          await input.services.objectStore.putJson(gapKey, normalized);
          await input.services.objectStore.putJson(gapDiagnosticsKey, gapNormalizationDiagnostics);

          if (gapNormalizationDiagnostics.changed) {
            await input.services.store
              .addRunEvent({
                runId: input.runId,
                level: "info",
                phase: "plan",
                eventType: "gap_analysis_normalized",
                message: `Iteration ${iterationEntry.iteration} normalized gap-analysis payload`,
                data: {
                  iteration: iterationEntry.iteration,
                  diagnostics: gapNormalizationDiagnostics,
                },
              })
              .catch(() => {});
          }

          return normalized;
        } catch (error) {
          const normalizedError =
            error instanceof Error
              ? { name: error.name, message: error.message }
              : { name: "UnknownError", message: String(error) };
          const fallbackResult = normalizeGapAnalysisOutput({
            questionUpdates: [],
            nextQueries: [],
            nextTasks: [],
            stop: true,
            stopReason: "gap_analysis_schema_error",
            planNotes: [
              `Gap analysis failed schema validation: ${normalizedError.name}: ${normalizedError.message.slice(0, 320)}`,
            ],
            ...(loopState.currentOutlinePlan ? { outlinePlan: loopState.currentOutlinePlan } : {}),
          });
          const fallback = GapAnalysisOutputSchema.parse(fallbackResult.value);
          gapNormalizationDiagnostics = {
            ...fallbackResult.diagnostics,
            changed: true,
            fallbackUsed: true,
            parseError: normalizedError,
          };
          await input.services.objectStore.putJson(gapKey, fallback);
          await input.services.objectStore.putJson(gapDiagnosticsKey, gapNormalizationDiagnostics);
          await input.services.store
            .addRunEvent({
              runId: input.runId,
              level: "warn",
              phase: "plan",
              eventType: "gap_analysis_fallback_used",
              message: `Iteration ${iterationEntry.iteration} used gap-analysis fallback after schema failure`,
              data: {
                iteration: iterationEntry.iteration,
                error: normalizedError,
                diagnostics: gapNormalizationDiagnostics,
              },
            })
            .catch(() => {});
          return fallback;
        }
      })());

    if (loopState.dynamicOutlineEnabled) {
      const nextOutlinePlan = coerceOutlinePlan(gap.outlinePlan, {
        fallback: loopState.currentOutlinePlan ?? null,
      });
      if (nextOutlinePlan) {
        const previousSerialized = loopState.currentOutlinePlan
          ? JSON.stringify(loopState.currentOutlinePlan)
          : "";
        const nextSerialized = JSON.stringify(nextOutlinePlan);
        const changed = previousSerialized !== nextSerialized;
        loopState.currentOutlinePlan = nextOutlinePlan;
        (input.checkpoint as { outlinePlan?: OutlinePlan }).outlinePlan = nextOutlinePlan;
        await input.services.objectStore
          .putJson(iterationEntry.artifacts.outlinePlanKey, nextOutlinePlan)
          .catch(() => {});
        if (changed) {
          await input.services.store
            .addRunEvent({
              runId: input.runId,
              level: "info",
              phase: "plan",
              eventType: "outline_plan_updated",
              message: `Iteration ${iterationEntry.iteration} updated dynamic outline plan`,
              data: {
                iteration: iterationEntry.iteration,
                sections: nextOutlinePlan.sections.map((section) => ({
                  id: section.id,
                  heading: section.heading,
                  dependsOnQuestionIds: section.dependsOnQuestionIds,
                })),
                notes: nextOutlinePlan.notes,
              },
            })
            .catch(() => {});
        }
      }
    }

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

    // Heuristic: each unblocked open question gets at most `maxFocusRoundsPerQuestion` iterations.
    // At the focus cap, resolve deterministically:
    // - confidence >= 0.5 with source-backed evidence => answered
    // - otherwise => unanswerable (to unblock dependents)
    const isResolved = (status: QuestionStatus) => status === "answered" || status === "unanswerable";
    const unblockedIdsForStreak = new Set(computeUnblockedQuestions(questionGraph).map((q) => q.id));
    const focusStreaks = loopState.unansweredStreaks;
    type FocusCapUnanswerableReason =
      | "focus_round_cap_low_confidence"
      | "focus_round_cap_missing_source_evidence";
    const newlyAnsweredAfterCap: Array<{
      id: string;
      streak: number;
      priorStatus: QuestionStatus;
      confidence: number;
      evidenceCount: number;
      hasSourceEvidence: boolean;
      reason: "focus_round_cap_confident_with_source";
    }> = [];
    const newlyUnanswerableAfterCap: Array<{
      id: string;
      streak: number;
      priorStatus: QuestionStatus;
      confidence: number;
      evidenceCount: number;
      hasSourceEvidence: boolean;
      reason: FocusCapUnanswerableReason;
    }> = [];

    for (const q of questionGraph.questions) {
      const isCandidate =
        unblockedIdsForStreak.has(q.id) && !isResolved(q.status);

      const nextStreak = isCandidate ? (focusStreaks[q.id] ?? 0) + 1 : 0;
      focusStreaks[q.id] = nextStreak;
      const confidenceForThreshold = q.confidence ?? 0;

      const evidenceCount = Array.isArray(q.evidence) ? q.evidence.length : 0;
      const hasSourceEvidence = Array.isArray(q.evidence)
        ? q.evidence.some((e) => typeof e.source === "string" && e.source.trim().length > 0)
        : false;

      if (isCandidate && nextStreak >= maxFocusRoundsPerQuestion) {
        if (confidenceForThreshold >= 0.5 && hasSourceEvidence) {
          newlyAnsweredAfterCap.push({
            id: q.id,
            streak: nextStreak,
            priorStatus: q.status,
            confidence: confidenceForThreshold,
            evidenceCount,
            hasSourceEvidence,
            reason: "focus_round_cap_confident_with_source",
          });
        } else {
          newlyUnanswerableAfterCap.push({
            id: q.id,
            streak: nextStreak,
            priorStatus: q.status,
            confidence: confidenceForThreshold,
            evidenceCount,
            hasSourceEvidence,
            reason:
              confidenceForThreshold < 0.5
                ? "focus_round_cap_low_confidence"
                : "focus_round_cap_missing_source_evidence",
          });
        }
      }
    }

    if (newlyAnsweredAfterCap.length > 0 || newlyUnanswerableAfterCap.length > 0) {
      const answeredById = new Map(newlyAnsweredAfterCap.map((u) => [u.id, u]));
      const unanswerableById = new Map(newlyUnanswerableAfterCap.map((u) => [u.id, u]));
      questionGraph = validateQuestionGraph({
        ...questionGraph,
        questions: questionGraph.questions.map((q) => {
          const answeredMatch = answeredById.get(q.id);
          if (answeredMatch) {
            const existingEvidence = Array.isArray(q.evidence) ? q.evidence : [];
            return {
              ...q,
              status: "answered",
              evidence: [
                ...existingEvidence,
                {
                  note:
                    `Focus cap reached: after ${answeredMatch.streak} iteration(s) this question is still ${answeredMatch.priorStatus}` +
                    ` (confidence=${answeredMatch.confidence.toFixed(2)})` +
                    ` with ${answeredMatch.evidenceCount} evidence item(s). Marked answered because confidence >= 0.50` +
                    ` and source-backed evidence is present.`,
                },
              ],
              updatedAtIteration: iterationEntry.iteration,
            };
          }

          const unanswerableMatch = unanswerableById.get(q.id);
          if (!unanswerableMatch) return q;
          const existingEvidence = Array.isArray(q.evidence) ? q.evidence : [];
          const unanswerableReasonText =
            unanswerableMatch.reason === "focus_round_cap_low_confidence"
              ? "confidence < 0.50"
              : "confidence >= 0.50 but source-backed evidence is missing";
          return {
            ...q,
            status: "unanswerable",
            evidence: [
              ...existingEvidence,
              {
                note:
                  `Focus cap reached: after ${unanswerableMatch.streak} iteration(s) this question is still ${unanswerableMatch.priorStatus}` +
                  ` (confidence=${unanswerableMatch.confidence.toFixed(2)})` +
                  ` with ${unanswerableMatch.evidenceCount} evidence item(s). Marked unanswerable because ${unanswerableReasonText}` +
                  ` to unblock dependents.`,
              },
            ],
            updatedAtIteration: iterationEntry.iteration,
          };
        }),
      });
      (input.checkpoint as { questionGraph?: QuestionGraph }).questionGraph = questionGraph;
      await persistCheckpoint();
    }

    if (newlyAnsweredAfterCap.length > 0) {
      await input.services.store
        .addRunEvent({
          runId: input.runId,
          level: "info",
          phase: "plan",
          eventType: "question_marked_answered_after_focus_cap",
          message: `Marked ${newlyAnsweredAfterCap.length} question(s) as answered after focus cap`,
          data: {
            iteration: iterationEntry.iteration,
            maxFocusRoundsPerQuestion,
            reason: "focus_round_cap_confident_with_source",
            confidenceThreshold: 0.5,
            questions: newlyAnsweredAfterCap.map((q) => ({
              id: q.id,
              focusStreak: q.streak,
              priorStatus: q.priorStatus,
              confidence: q.confidence,
              evidenceCount: q.evidenceCount,
              hasSourceEvidence: q.hasSourceEvidence,
              reason: q.reason,
            })),
          },
        })
        .catch(() => {});
    }

    if (newlyUnanswerableAfterCap.length > 0) {
      const lowConfidenceCount = newlyUnanswerableAfterCap.filter(
        (q) => q.reason === "focus_round_cap_low_confidence"
      ).length;
      const missingSourceEvidenceCount = newlyUnanswerableAfterCap.filter(
        (q) => q.reason === "focus_round_cap_missing_source_evidence"
      ).length;
      const reason =
        lowConfidenceCount > 0 && missingSourceEvidenceCount > 0
          ? "mixed"
          : lowConfidenceCount > 0
            ? "focus_round_cap_low_confidence"
            : "focus_round_cap_missing_source_evidence";

      await input.services.store
        .addRunEvent({
          runId: input.runId,
          level: "info",
          phase: "plan",
          eventType: "question_marked_unanswerable",
          message: `Marked ${newlyUnanswerableAfterCap.length} question(s) as unanswerable after focus cap`,
          data: {
            iteration: iterationEntry.iteration,
            maxFocusRoundsPerQuestion,
            reason,
            confidenceThreshold: 0.5,
            reasons: {
              focus_round_cap_low_confidence: lowConfidenceCount,
              focus_round_cap_missing_source_evidence: missingSourceEvidenceCount,
            },
            questions: newlyUnanswerableAfterCap.map((q) => ({
              id: q.id,
              focusStreak: q.streak,
              priorStatus: q.priorStatus,
              confidence: q.confidence,
              evidenceCount: q.evidenceCount,
              hasSourceEvidence: q.hasSourceEvidence,
              reason: q.reason,
            })),
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
          (gapNormalizationDiagnostics.fallbackUsed ? " fallbackUsed=true" : "") +
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
          gapDiagnostics: gapNormalizationDiagnostics,
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
            gapDiagnostics: gapNormalizationDiagnostics,
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

    await persistIterationPlanVersion(iterationEntry, gap, compression);

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
    } else if (
      openUnblocked.length === 0 &&
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
