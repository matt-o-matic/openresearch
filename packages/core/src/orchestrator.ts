import crypto from "node:crypto";

import pLimit from "p-limit";
import { z } from "zod";

import type {
  BudgetConfig,
  CitationPolicy,
  OpenResearchConfig,
  AgenticLoopConfig,
  SynthesisConfig,
  ResearchLoopConfig,
  PhaseModelConfig,
  ThinkingMode,
} from "./config.js";
import {
  AgenticLoopConfigSchema,
  ResearchLoopConfigSchema,
  SynthesisConfigSchema,
} from "./config.js";
import type { SearchAdapter, HttpFetchAdapter, BrowserRenderAdapter } from "./adapters.js";
import type { ExtractedEvidence } from "./extract.js";
import {
  extractFromHtml,
  extractFromText,
  extractTextFromHtml,
  isExtractStackOverflowError,
} from "./extract.js";
import type { ChatCompletionResponse, ChatMessage, ModelProvider } from "./models.js";
import { ModelRouter } from "./model-router.js";
import {
  debugSourceRenderedHtmlKey,
  debugSourceTraceZipKey,
  runArtifactKey,
  runCitationMapKey,
  runOutputKey,
  runPlanKey,
  runRetrievalKey,
  runSynthesisKey,
  runVerificationJsonKey,
  runVerificationMarkdownKey,
  sourceEvidenceKey,
  sourceRawBodyKey,
  sourceRenderedTextKey,
} from "./artifacts.js";
import type { CitationMap, LabeledSource, SynthesisOutput } from "./memo.js";
import { buildCitationMap, renderResearchMemoMarkdown, SynthesisOutputSchema } from "./memo.js";
import { QuestionGraphSchema, validateQuestionGraph } from "./goal-directed.js";
import type { QuestionGraph, SynthesisState } from "./goal-directed.js";
import { validateCitations } from "./verify.js";
import { runResearchLoop, type ResearchLoopCheckpointState } from "./research-loop.js";
import { normalizeUrl } from "./url.js";

export type PipelinePhase =
  | "plan"
  | "retrieve"
  | "fetch"
  | "extract"
  | "synthesize"
  | "verify"
  | "finalize";

export type RunCheckpoint = {
  version: 1;
  nextPhase: PipelinePhase;
  startedAt?: string;
  counters: {
    searchCalls: number;
    fetches: number;
    renders: number;
    modelCalls: number;
  };
  selectedUrls?: string[];
  sourceIds?: string[];
  sourceLabels?: Record<string, string>; // sourceId -> label
  researchLoop?: ResearchLoopCheckpointState;
  questionGraph?: QuestionGraph;
  synthesisState?: SynthesisState;
  artifacts: {
    planKey?: string;
    retrievalKey?: string;
    synthesisKey?: string;
    citationMapKey?: string;
    verificationJsonKey?: string;
    verificationMarkdownKey?: string;
    outputKey?: string;
  };
  debug: {
    enabled: boolean;
    reason?: string;
  };
};

export type PipelineRunRow = {
  id: string;
  user_id: string;
  prompt: string;
  status: string;
  phase: string | null;
  citation_policy: string;
  template: string;
  budgets: unknown;
  model_config: unknown;
  adapter_config: unknown;
  state: unknown | null;
};

export type PipelineSourceRow = {
  id: string;
  run_id: string;
  url: string;
  final_url: string | null;
  status: string;
  http_status: number | null;
  content_type: string | null;
  fetched_at: string | Date | null;
  title: string | null;
  publisher: string | null;
  raw_body_key: string | null;
  render_text_key: string | null;
  render_html_key: string | null;
  render_trace_key: string | null;
  extract_key: string | null;
  error: unknown | null;
};

export interface PipelineStore {
  getRun(runId: string): Promise<PipelineRunRow | null>;
  updateRun(input: {
    runId: string;
    status?: "queued" | "running" | "failed" | "completed" | "canceled";
    phase?: string | null;
    plan?: unknown | null;
    state?: unknown | null;
    error?: unknown | null;
    startedAt?: Date | null;
    finishedAt?: Date | null;
  }): Promise<void>;
  addRunEvent(input: {
    runId: string;
    level: "debug" | "info" | "warn" | "error";
    phase?: string;
    eventType: string;
    message?: string;
    data?: unknown;
  }): Promise<unknown>;

  addUsageDelta(input: {
    userId: string;
    searchCalls?: number;
    fetches?: number;
    renders?: number;
    modelTokensIn?: number;
    modelTokensOut?: number;
    costUsd?: number;
  }): Promise<void>;

  listSources(runId: string): Promise<PipelineSourceRow[]>;
  createSource(input: { runId: string; url: string }): Promise<PipelineSourceRow>;
  updateSource(input: {
    sourceId: string;
    status?: "pending" | "fetched" | "rendered" | "extracted" | "failed" | "skipped";
    finalUrl?: string | null;
    httpStatus?: number | null;
    contentType?: string | null;
    fetchedAt?: Date | null;
    title?: string | null;
    publisher?: string | null;
    rawBodyKey?: string | null;
    renderTextKey?: string | null;
    renderHtmlKey?: string | null;
    renderTraceKey?: string | null;
    extractKey?: string | null;
    error?: unknown | null;
  }): Promise<void>;

  addModelCall(input: {
    runId: string;
    phase: string;
    modelId: string;
    params?: unknown;
    promptVersion?: string;
    inputHash?: string;
    outputHash?: string;
    tokensIn?: number;
    tokensOut?: number;
    costUsd?: number;
    requestKey?: string;
    responseKey?: string;
  }): Promise<unknown>;

  addCitation(input: {
    runId: string;
    claimId: string;
    sourceId: string;
    quoteStart?: number;
    quoteEnd?: number;
  }): Promise<unknown>;

  createRunCheckpoint?: (input: {
    runId: string;
    kind: "iteration" | "finalize";
    checkpointVersion: number;
    iterationCompleted: number;
    payload: unknown;
  }) => Promise<unknown>;

  listRunCheckpoints?: (
    runId: string,
    opts?: { limit?: number }
  ) => Promise<unknown[]>;

  getLatestValidRunCheckpoint?: (runId: string) => Promise<unknown | null>;
}

export interface ObjectStore {
  putJson(key: string, value: unknown): Promise<void>;
  putText(key: string, text: string): Promise<void>;
  putBytes(key: string, bytes: Uint8Array): Promise<void>;
  getJson<T>(key: string): Promise<T | null>;
  getText(key: string): Promise<string | null>;
  getBytes(key: string): Promise<Uint8Array | null>;
}

export type PipelineServices = {
  store: PipelineStore;
  objectStore: ObjectStore;
  search: SearchAdapter;
  httpFetch: HttpFetchAdapter;
  browserRender?: BrowserRenderAdapter;
  modelProvider?: ModelProvider;
};

const PlanOutputSchema = z.object({
  subquestions: z.array(z.string().min(1)).default([]),
  queries: z.array(z.string().min(1)).min(1),
});
const PlanPassSchema = PlanOutputSchema.extend({
  followUpTasks: z.array(z.string().min(1)).default([]),
  continuePlanning: z.boolean().default(false),
});
type PlanPass = z.infer<typeof PlanPassSchema>;
type PlanOutput = z.infer<typeof PlanOutputSchema>;

const QuestionExtractionModelSchema = z.object({
  questions: z
    .array(
      z.object({
        text: z.string().min(1),
        dependsOn: z.array(z.string().min(1)).default([]),
      })
    )
    .min(1),
});
type QuestionExtractionModelOutput = z.infer<typeof QuestionExtractionModelSchema>;

type PlanTodoItem = {
  index: number;
  text: string;
};

const MAX_PLAN_TODO_ITEMS = 20;
const MAX_PLAN_TODO_QUERY_HINTS = 5;

type RetrievalOutput = {
  queries: Array<{
    query: string;
    results: Array<{ url: string; title?: string; snippet?: string }>;
  }>;
  selectedUrls: string[];
};

function initialCheckpoint(): RunCheckpoint {
  return {
    version: 1,
    nextPhase: "plan",
    counters: { searchCalls: 0, fetches: 0, renders: 0, modelCalls: 0 },
    artifacts: {},
    debug: { enabled: false },
  };
}

function safeParseCheckpoint(state: unknown | null): RunCheckpoint {
  if (!state || typeof state !== "object") return initialCheckpoint();
  const c = state as Partial<RunCheckpoint>;
  if (c.version !== 1) return initialCheckpoint();
  return {
    ...initialCheckpoint(),
    ...c,
    counters: { ...initialCheckpoint().counters, ...(c.counters ?? {}) },
    artifacts: { ...initialCheckpoint().artifacts, ...(c.artifacts ?? {}) },
    debug: { ...initialCheckpoint().debug, ...(c.debug ?? {}) },
  };
}

function buildFallbackQuestionGraph(input: { prompt: string; plan?: PlanOutput | null }): QuestionGraph {
  const raw =
    input.plan && Array.isArray(input.plan.subquestions) && input.plan.subquestions.length > 0
      ? input.plan.subquestions
      : [input.prompt];
  const questions = raw
    .map((text) => (typeof text === "string" ? text.trim() : ""))
    .filter(Boolean)
    .slice(0, 8)
    .map((text, i) => ({
      id: `q${i + 1}`,
      text,
      dependsOn: [],
      status: "unanswered" as const,
      evidence: [],
    }));
  return QuestionGraphSchema.parse({ validated: true, questions });
}

function normalizeExtractedQuestionGraph(input: {
  raw: QuestionExtractionModelOutput;
  fallback: QuestionGraph;
}): QuestionGraph {
  const maxQuestions = 10;
  const trimmed = input.raw.questions
    .map((q) => ({
      text: typeof q.text === "string" ? q.text.trim() : "",
      dependsOn: Array.isArray(q.dependsOn) ? q.dependsOn : [],
    }))
    .filter((q) => Boolean(q.text))
    .slice(0, maxQuestions);

  if (trimmed.length === 0) return input.fallback;

  const ids = trimmed.map((_q, i) => `q${i + 1}`);
  const idSet = new Set(ids);

  const questions = trimmed.map((q, i) => {
    const deps = q.dependsOn
      .map((dep) => (typeof dep === "string" ? dep.trim() : ""))
      .filter((dep) => /^q[0-9]+$/.test(dep))
      .filter((dep) => idSet.has(dep))
      .filter((dep) => dep !== ids[i]);

    return {
      id: ids[i]!,
      text: q.text,
      dependsOn: Array.from(new Set(deps)),
      status: "unanswered" as const,
      evidence: [],
    };
  });

  return validateQuestionGraph(
    QuestionGraphSchema.parse({
      validated: false,
      questions,
    })
  );
}

function hasStrongDependencyCue(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(given|based on|using|from the answer|after answering|derive|calculate|compute|prove|verify)\b/.test(t);
}

function maxDependencyDepth(questions: Array<{ id: string; dependsOn: string[] }>): number {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const memo = new Map<string, number>();

  const depthFrom = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const q = byId.get(id);
    if (!q || q.dependsOn.length === 0) {
      memo.set(id, 0);
      return 0;
    }
    let max = 0;
    for (const dep of q.dependsOn) {
      max = Math.max(max, 1 + depthFrom(dep));
    }
    memo.set(id, max);
    return max;
  };

  let max = 0;
  for (const q of questions) {
    max = Math.max(max, depthFrom(q.id));
  }
  return max;
}

function tuneQuestionDependencies(graph: QuestionGraph): {
  graph: QuestionGraph;
  pruned: boolean;
  reason: string | null;
  stats: {
    totalQuestions: number;
    dependentQuestions: number;
    edgeCount: number;
    maxDepth: number;
    hasStrongCue: boolean;
  };
} {
  const totalQuestions = graph.questions.length;
  const dependentQuestions = graph.questions.filter((q) => q.dependsOn.length > 0).length;
  const edgeCount = graph.questions.reduce((sum, q) => sum + q.dependsOn.length, 0);
  const maxDepth = maxDependencyDepth(graph.questions);
  const hasStrongCue = graph.questions.some((q) => hasStrongDependencyCue(q.text));

  const dependencyHeavy =
    dependentQuestions >= Math.max(3, Math.ceil(totalQuestions * 0.75)) && edgeCount >= dependentQuestions;
  const overspecified = maxDepth >= 2 || dependencyHeavy;

  if (!overspecified || hasStrongCue || edgeCount === 0) {
    return {
      graph,
      pruned: false,
      reason: null,
      stats: { totalQuestions, dependentQuestions, edgeCount, maxDepth, hasStrongCue },
    };
  }

  const flattened = validateQuestionGraph({
    validated: false,
    questions: graph.questions.map((q) => ({ ...q, dependsOn: [] })),
  });
  return {
    graph: flattened,
    pruned: true,
    reason: "pruned_overspecified_dependencies",
    stats: { totalQuestions, dependentQuestions, edgeCount, maxDepth, hasStrongCue },
  };
}

async function extractQuestionGraphFromPrompt(input: {
  runId: string;
  userId: string;
  prompt: string;
  plan: PlanOutput | null;
  provider: ModelProvider | undefined;
  model: string;
  thinkingMode: ThinkingMode;
  store: PipelineStore;
  objectStore: ObjectStore;
  checkpoint: RunCheckpoint;
}): Promise<QuestionGraph> {
  const fallback = buildFallbackQuestionGraph({
    prompt: input.prompt,
    ...(input.plan ? { plan: input.plan } : {}),
  });
  if (!input.provider) return fallback;

  const sys: ChatMessage = {
    role: "system",
    content:
      "Extract the core questions implied by the prompt. Prefer a flat list (no dependencies). " +
      "Only add dependsOn when a question truly cannot be answered without first answering another question. " +
      "Avoid serializing parallel sub-questions behind a single root question. Output JSON only.",
  };
  const user: ChatMessage = {
    role: "user",
    content: JSON.stringify({
      task: "Extract core questions (optionally with dependencies).",
      prompt: input.prompt,
      planningContext: {
        subquestions: input.plan?.subquestions ?? [],
        queries: input.plan?.queries ?? [],
      },
      outputSchema: {
        questions: [
          {
            text: "Question text",
            dependsOn: ["q1"],
          },
        ],
      },
      constraints: {
        maxQuestions: 10,
        dependencyRules: [
          "Prefer dependsOn: []. Use dependencies sparingly.",
          "Use ids q1..qN in dependsOn.",
          "Do not create cycles.",
          "Only depend on earlier questions when possible.",
          "Avoid long chains (e.g., q3->q2->q1) unless required by the question wording.",
          "If questions can be answered independently from the same sources, do not add dependencies.",
        ],
      },
    }),
  };

  try {
    const raw = await callModelJsonLogged({
      runId: input.runId,
      userId: input.userId,
      phase: "plan",
      persona: "question-extraction",
      provider: input.provider,
      model: input.model,
      messages: [sys, user],
      schema: QuestionExtractionModelSchema,
      reasoningEffort: input.thinkingMode,
      store: input.store,
      objectStore: input.objectStore,
      checkpoint: input.checkpoint,
      promptVersion: "question-extraction.v1",
      maxTokens: 2_000,
    });

    const normalized = normalizeExtractedQuestionGraph({ raw, fallback });
    const tuned = tuneQuestionDependencies(normalized);
    if (tuned.pruned) {
      await input.store
        .addRunEvent({
          runId: input.runId,
          level: "info",
          phase: "plan",
          eventType: "question_graph_dependencies_pruned",
          message:
            "Pruned overspecified question dependencies to keep questions parallelizable " +
            `(dependentQuestions=${tuned.stats.dependentQuestions}/${tuned.stats.totalQuestions}, maxDepth=${tuned.stats.maxDepth})`,
          data: tuned,
        })
        .catch(() => {});
    }
    return tuned.graph;
  } catch (err) {
    await input.store
      .addRunEvent({
        runId: input.runId,
        level: "warn",
        phase: "plan",
        eventType: "question_graph_extraction_failed",
        message: "Question graph extraction failed; falling back to flat questions",
        data: {
          error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
        },
      })
      .catch(() => {});
    return fallback;
  }
}

function buildPlanTodoItems(
  plan: PlanOutput
): PlanTodoItem[] {
  const sourceItems = plan.subquestions.length > 0 ? plan.subquestions : plan.queries.map((query) => `Investigate: ${query}`);
  const uniqueItems = Array.from(new Set(sourceItems.map((item) => item.trim()).filter(Boolean)));
  return uniqueItems.slice(0, MAX_PLAN_TODO_ITEMS).map((text, index) => ({
    index: index + 1,
    text,
  }));
}

function buildPlanTodoHints(plan: PlanOutput): string[] {
  return plan.queries
    .map((query) => query.trim())
    .filter(Boolean)
    .slice(0, MAX_PLAN_TODO_QUERY_HINTS);
}

const MODEL_CALL_EMPTY_RESPONSE_MARKER = "EMPTY_MODEL_RESPONSE";
type SynthesisCallPurpose = "source-abstracts" | "review" | "writing" | "other";
type SynthesisCallPersona = "synthesis-source-compression" | "synthesis-review" | "synthesis-writing";
type JsonSchemaCompatMode =
  | "legacy-source-abstracts-shim"
  | "legacy-review-shim"
  | "legacy-review-unsupported-items-shim";
type JsonExtractionResult = {
  value: unknown;
  schemaCompatMode?: JsonSchemaCompatMode;
};

function parseAttemptedJson(input: string): unknown {
  return JSON.parse(input);
}

function extractJsonCandidates(text: string): string[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  const candidates = new Set<string>();
  const trim = candidate.trim();
  if (!trim) return [];
  candidates.add(trim);

  const firstBrace = trim.indexOf("{");
  const firstBracket = trim.indexOf("[");
  const start =
    firstBrace === -1
      ? firstBracket
      : firstBracket === -1
        ? firstBrace
        : Math.min(firstBrace, firstBracket);
  if (start !== -1) candidates.add(trim.slice(start));

  const lastCurly = trim.lastIndexOf("}");
  const lastSquare = trim.lastIndexOf("]");
  if (lastCurly !== -1) candidates.add(trim.slice(0, lastCurly + 1));
  if (lastSquare !== -1) candidates.add(trim.slice(0, lastSquare + 1));

  return Array.from(candidates);
}

function extractBalancedJsonPrefix(text: string): string {
  const start = Math.min(
    ...[text.indexOf("{"), text.indexOf("["), Number.POSITIVE_INFINITY].filter((v) => v !== -1)
  );
  if (!Number.isFinite(start)) return "";
  const slice = text.slice(start);
  const stack: Array<"{" | "["> = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < slice.length; i += 1) {
    const ch = slice[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{" || ch === "[") {
      stack.push(ch);
      continue;
    }

    if (ch === "}" || ch === "]") {
      const top = stack[stack.length - 1];
      const matches =
        (ch === "}" && top === "{") || (ch === "]" && top === "[");
      if (!matches) continue;
      stack.pop();
      if (stack.length === 0) return slice.slice(0, i + 1);
    }
  }

  return "";
}

function repairTruncatedJson(candidate: string): string {
  if (!candidate.trim()) return "";
  const trimmed = candidate.trim();
  const first = Math.min(
    ...[trimmed.indexOf("{"), trimmed.indexOf("["), Number.POSITIVE_INFINITY].filter((v) => v !== -1)
  );
  if (!Number.isFinite(first)) return "";
  const slice = trimmed.slice(first);
  const stack: Array<"{" | "["> = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < slice.length; i += 1) {
    const ch = slice[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      continue;
    }
    if (ch === "}" || ch === "]") {
      const top = stack[stack.length - 1];
      const matches = (ch === "}" && top === "{") || (ch === "]" && top === "[");
      if (matches) {
        stack.pop();
      }
    }
  }

  if (inString || escaped || stack.length === 0) {
    return "";
  }

  const trailing = stack
    .map((ch) => (ch === "{" ? "}" : "]"))
    .reverse()
    .join("");
  return `${slice}${trailing}`;
}

function coerceString(value: unknown, fallback = ""): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  return fallback;
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

type DataTypeCoercionResult = {
  dataTypes: string[];
  converted: boolean;
};

function coerceSourceAbstractDataTypes(value: unknown): DataTypeCoercionResult {
  if (Array.isArray(value)) {
    return { dataTypes: coerceStringArray(value), converted: false };
  }

  const dataTypeString = coerceString(value);
  if (!dataTypeString) {
    return { dataTypes: [], converted: false };
  }

  return { dataTypes: [dataTypeString], converted: true };
}

function deriveSynthesisPurpose(persona?: string | SynthesisCallPersona): SynthesisCallPurpose {
  switch (persona) {
    case "synthesis-source-compression":
      return "source-abstracts";
    case "synthesis-review":
      return "review";
    case "synthesis-writing":
      return "writing";
    default:
      return "other";
  }
}

function maybeCoerceSourceAbstractPayload(raw: unknown): JsonExtractionResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { value: raw };
  const obj = raw as {
    synthesis?: unknown;
    sourceId?: string;
    synthesisNotes?: unknown;
    sourceAbstracts?: unknown;
  };

  if (!Array.isArray(obj.synthesis)) return { value: raw };

  const sourceAbstracts = obj.synthesis
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const sourceEntry = entry as Record<string, unknown>;
      const source = coerceString(sourceEntry.source, coerceString(sourceEntry.sourceId, ""));
      if (!source) return null;
      return {
        source,
        methodology: coerceString(sourceEntry.methodology, "Legacy source abstract payload omitted methodology."),
        temporalContext: coerceString(sourceEntry.temporalContext, "Unknown temporal context."),
        dataTypes: coerceStringArray(sourceEntry.dataTypes),
        stakeholderPosition: coerceString(
          sourceEntry.stakeholderPosition,
          "Legacy source abstract payload omitted stakeholder position."
        ),
        representativeClaims: coerceStringArray(sourceEntry.representativeClaims),
        keyConstraints: coerceStringArray(sourceEntry.keyConstraints),
      };
    })
    .filter(
      (
        entry
      ): entry is {
        source: string;
        methodology: string;
        temporalContext: string;
        dataTypes: string[];
        stakeholderPosition: string;
        representativeClaims: string[];
        keyConstraints: string[];
      } => entry !== null
    );

  if (sourceAbstracts.length === 0) return { value: raw };

  return {
    value: {
      sourceAbstracts,
      synthesisNotes: coerceStringArray(obj.synthesisNotes),
    },
    schemaCompatMode: "legacy-source-abstracts-shim",
  };
}

function maybeCoerceSourceAbstractDataTypes(raw: unknown): JsonExtractionResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { value: raw };

  const obj = raw as {
    sourceAbstracts?: unknown;
    synthesisNotes?: unknown;
  };
  if (!Array.isArray(obj.sourceAbstracts)) return { value: raw };

  let needsCompatibility = false;
  const sourceAbstracts = obj.sourceAbstracts
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const sourceEntry = entry as Record<string, unknown>;
      const dataTypes = coerceSourceAbstractDataTypes(sourceEntry.dataTypes);
      if (dataTypes.converted) needsCompatibility = true;
      return { ...sourceEntry, dataTypes: dataTypes.dataTypes };
    })
    .filter((entry) => entry !== null);

  if (!needsCompatibility || sourceAbstracts.length === 0) return { value: raw };

  return {
    value: {
      ...obj,
      sourceAbstracts,
      synthesisNotes: coerceStringArray(obj.synthesisNotes),
    },
    schemaCompatMode: "legacy-source-abstracts-shim",
  };
}

function mapReviewLegacyItems(
  items: unknown,
  kind: "summaryIssues" | "keyFindingsIssues",
  findIdxStart: number
): Array<{ findingId: string; issue: string; why: string; strengtheningAlternative: string }> {
  if (!Array.isArray(items)) return [];

  return items
    .map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const issue = entry as Record<string, unknown>;
      const findingId = coerceString(
        issue.id,
        `${kind}-${findIdxStart + index + 1}`
      );
      const issueText = coerceString(
        issue.sentence ?? issue.issue ?? issue.text ?? issue.findingId,
        "Legacy review item lacks a specific issue statement."
      );
      const why = coerceString(
        issue.details ?? issue.why,
        issueText
      );
      const strengtheningAlternative = coerceString(
        issue.suggestedRevision ?? issue.alternative ?? issue.evidenceNeeded,
        "No specific revision text provided; validate directly against source evidence."
      );

      return {
        findingId,
        issue: issueText,
        why,
        strengtheningAlternative,
      };
    })
    .filter((entry): entry is {
      findingId: string;
      issue: string;
      why: string;
      strengtheningAlternative: string;
    } => entry !== null);
}

function mapReviewUnsupportedConclusions(
  items: unknown,
  findIdxStart = 0
): {
  issues: Array<{ findingId: string; issue: string; why: string; strengtheningAlternative: string }>;
  converted: boolean;
} {
  if (!Array.isArray(items)) return { issues: [], converted: false };

  let converted = false;
  const issues = items
    .map((entry, index) => {
      if (typeof entry === "string") {
        const issueText = coerceString(entry, "");
        if (!issueText) return null;
        converted = true;
        return {
          findingId: `legacy-${findIdxStart + index + 1}`,
          issue: issueText,
          why: `Legacy review output provided a string unsupported-conclusion entry.`,
          strengtheningAlternative:
            "Rework or remove this conclusion to align with explicit source evidence.",
        };
      }

      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const issue = entry as Record<string, unknown>;
      const findingIdSource = issue.findingId ?? issue.id ?? issue.finding;
      const issueSource = issue.issue ?? issue.statement ?? issue.sentence ?? issue.text;
      const whySource = issue.why ?? issue.reason ?? issue.details;
      const revisionSource =
        issue.strengtheningAlternative ??
        issue.revision ??
        issue.suggestedRevision ??
        issue.nextStep;
      const findingId = coerceString(findingIdSource, `legacy-${findIdxStart + index + 1}`);
      const issueText = coerceString(
        issueSource,
        coerceString(issue.issueId, "")
      );
      if (!issueText) return null;
      const why = coerceString(
        whySource,
        `Legacy review output did not include a why. ${issueText}`
      );
      const strengtheningAlternative = coerceString(
        revisionSource,
        "Please revise this conclusion with more precise source support."
      );
      if (
        typeof findingIdSource !== "string" ||
        typeof issueSource !== "string" ||
        typeof whySource !== "string" ||
        typeof revisionSource !== "string"
      ) {
        converted = true;
      }

      return {
        findingId,
        issue: issueText,
        why,
        strengtheningAlternative,
      };
    })
    .filter((entry): entry is {
      findingId: string;
      issue: string;
      why: string;
      strengtheningAlternative: string;
    } => entry !== null);

  return { issues, converted };
}

function mapReviewLegacyMissingEvidence(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const itemObj = item as Record<string, unknown>;
      const evidence = coerceString(itemObj.evidenceNeeded, "");
      return evidence || null;
    })
    .filter((item): item is string => typeof item === "string" && item.length > 0);
}

function mapReviewLegacyRecommendations(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (typeof item === "string") return coerceString(item, "");
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const itemObj = item as Record<string, unknown>;
        const text = coerceString(itemObj.text, itemObj.recommendation as unknown as string);
        return coerceString(text, "");
      }
      return "";
    })
    .filter((item): item is string => item.length > 0);
}

function maybeCoerceReviewPayload(raw: unknown): JsonExtractionResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { value: raw };
  const obj = raw as Record<string, unknown>;
  const unsupportedConclusionsFromStrings = mapReviewUnsupportedConclusions(
    obj.unsupportedConclusions,
    0
  );

  const summaryIssues = obj.summaryIssues;
  const keyFindingsIssues = obj.keyFindingsIssues;
  const recommendationsIssues = obj.recommendationsIssues;
  if (
    summaryIssues === undefined &&
    keyFindingsIssues === undefined &&
    recommendationsIssues === undefined
  ) {
    if (unsupportedConclusionsFromStrings.converted) {
      return {
        value: {
          ...obj,
          unsupportedConclusions: unsupportedConclusionsFromStrings.issues,
        },
        schemaCompatMode: "legacy-review-unsupported-items-shim",
      };
    }
    return { value: raw };
  }

  const unsupportedConclusions = [
    ...mapReviewLegacyItems(summaryIssues, "summaryIssues", 0),
    ...mapReviewLegacyItems(keyFindingsIssues, "keyFindingsIssues", 0),
    ...unsupportedConclusionsFromStrings.issues,
  ];

  return {
    value: {
      verdict: unsupportedConclusions.length > 0 ? "revise" : "accept",
      unsupportedConclusions,
      missingEvidence: mapReviewLegacyMissingEvidence(
        (Array.isArray(summaryIssues) ? summaryIssues : []).concat(
          Array.isArray(keyFindingsIssues) ? keyFindingsIssues : []
        )
      ),
      requestedRevisions: mapReviewLegacyRecommendations(recommendationsIssues),
      confidenceRisk: undefined,
    },
    schemaCompatMode: unsupportedConclusionsFromStrings.converted
      ? "legacy-review-unsupported-items-shim"
      : "legacy-review-shim",
  };
}

function maybeCoerceSchemaCompat(persona: string | undefined, json: unknown): JsonExtractionResult {
  if (persona === "synthesis-source-compression") {
    const legacyResult = maybeCoerceSourceAbstractPayload(json);
    if (legacyResult.schemaCompatMode) return legacyResult;
    return maybeCoerceSourceAbstractDataTypes(json);
  }
  if (persona === "synthesis-review") return maybeCoerceReviewPayload(json);
  return { value: json };
}

function extractFirstJson(text: string): JsonExtractionResult {
  const attempts = new Set<string>();
  const candidates = extractJsonCandidates(text);
  for (const candidate of candidates) {
    const balanced = extractBalancedJsonPrefix(candidate);
    const repaired = repairTruncatedJson(candidate);

    if (balanced) attempts.add(balanced);
    attempts.add(candidate);
    if (repaired) attempts.add(repaired);
  }
  let lastError: Error | undefined;

  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      return { value: parseAttemptedJson(candidate) };
    } catch (error) {
      lastError =
        error instanceof Error ? error : new Error(typeof error === "string" ? error : "Unknown JSON parse error");
    }
  }
  if (lastError) throw lastError;
  throw new Error("Unable to extract valid JSON from model response.");
}

function sha256Base64url(input: string): string {
  return crypto.createHash("sha256").update(input).digest("base64url");
}

async function callModelJsonLogged<TSchema extends z.ZodTypeAny>(input: {
  runId: string;
  userId: string;
  phase: string;
  persona?: string | SynthesisCallPersona;
  synthesisPurpose?: SynthesisCallPurpose;
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
}): Promise<z.output<TSchema>> {
  const temperature = input.temperature ?? 0.2;
  const requestedMaxTokens =
    typeof input.maxTokens === "number" && Number.isFinite(input.maxTokens)
      ? input.maxTokens
      : undefined;
  const effectiveMaxTokens =
    requestedMaxTokens === undefined
      ? MODEL_CALL_MIN_OUTPUT_TOKENS
      : Math.max(requestedMaxTokens, MODEL_CALL_MIN_OUTPUT_TOKENS);
  const jsonOnlySystem: ChatMessage = {
    role: "system",
    content:
      "Return only valid JSON. Do not include markdown, code fences, or extra commentary. " +
      "If a field is unknown, use an empty string/array rather than prose.",
  };
  const messages: ChatMessage[] = [jsonOnlySystem, ...input.messages];
  const callId = crypto.randomUUID();
  const request: {
    model: string;
    messages: ChatMessage[];
    temperature: number;
    maxTokens?: number;
    reasoning_effort?: ThinkingMode;
  } = {
    model: input.model,
    messages,
    temperature,
  };
  if (effectiveMaxTokens !== undefined) request.maxTokens = effectiveMaxTokens;
  if (input.reasoningEffort !== undefined) request.reasoning_effort = input.reasoningEffort;
  const inputHash = sha256Base64url(JSON.stringify(request));

  const requestKey = (attempt: number) =>
    runArtifactKey(
      input.runId,
      `model-calls/${input.phase}/${callId}.attempt-${attempt}.request.json`
    );
  const responseKey = (attempt: number) =>
    runArtifactKey(
      input.runId,
      `model-calls/${input.phase}/${callId}.attempt-${attempt}.response.json`
    );
  const persona =
    typeof input.persona === "string" && input.persona.trim().length > 0
      ? input.persona
      : input.phase;

  const callAttemptContext = {
    persona,
    phase: input.phase,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    synthesisPurpose: input.synthesisPurpose ?? deriveSynthesisPurpose(persona),
    requestedMaxTokens,
    maxTokens: effectiveMaxTokens,
    effectiveMaxTokens,
  };

  const emitRetryEvent = async (
    attempt: number,
    reason: string,
    error: unknown,
    extraData?: Record<string, unknown>
  ): Promise<void> => {
    const normalizedError =
      error instanceof Error
        ? { name: error.name, message: error.message, ...(error.stack ? { stack: error.stack } : {}) }
        : { name: "UnknownError", message: String(error) };

    await input.store
      .addRunEvent({
        runId: input.runId,
        level: "warn",
        phase: input.phase,
        eventType: "model_call_retry",
        message: `Retrying ${input.phase} model call after ${reason}`,
        data: {
          ...callAttemptContext,
          modelCallId: callId,
          attempt,
          retryAttempt: attempt - 1,
          maxRetries: MODEL_CALL_MAX_RETRIES,
          maxAttempts: MODEL_CALL_MAX_ATTEMPTS,
          errorName: normalizedError.name,
          errorMessage: normalizedError.message,
          ...(extraData ? extraData : {}),
        },
      })
      .catch(() => {});
  };

  await input.store
    .addRunEvent({
      runId: input.runId,
      level: "info",
      phase: input.phase,
      eventType: "model_call_started",
      message: `Launching ${input.phase} model call with ${input.model}`,
      data: {
        ...callAttemptContext,
        modelCallId: callId,
        retryAttempt: 0,
        maxRetries: MODEL_CALL_MAX_RETRIES,
        maxAttempts: MODEL_CALL_MAX_ATTEMPTS,
      },
    })
    .catch(() => {});

  const persistResponse = async (
    value: unknown,
    responseArtifact: string
  ): Promise<boolean> => {
    try {
      await input.objectStore.putJson(responseArtifact, value);
      return true;
    } catch {
      return false;
    }
  };

  const persistResponseError = async (payload: {
    message: string;
    name: string;
    stack?: string;
    reason?: string;
    rawResponse?: string;
    rawResponseLength?: number;
    rawResponsePreview?: string;
    attempt?: number;
    responseArtifact: string;
  }): Promise<void> => {
    const written = await persistResponse(
      {
        error: true,
        phase: input.phase,
        model: input.model,
        ...payload,
      },
      payload.responseArtifact
    );
    if (written) return;
    await persistResponse(
      {
        error: true,
        phase: input.phase,
        model: input.model,
        name: "ModelResponsePersistenceError",
        message: "Model response could not be persisted to object store",
        reason: payload.reason ?? "unknown",
        stack: payload.stack,
      },
      payload.responseArtifact
    );
  };

  const normalizeResponse = (res: ChatCompletionResponse): {
    text: string;
    usage?: ChatCompletionResponse["usage"];
    raw?: unknown;
  } => {
    const payload = {
      text: typeof res.text === "string" ? res.text : String(res.text ?? ""),
      ...(res.usage ? { usage: res.usage } : {}),
    };
    try {
      JSON.stringify(res.raw);
      return { ...payload, ...(res.raw === undefined ? {} : { raw: res.raw }) };
    } catch {
      return {
        ...payload,
        raw: String(res.raw),
      };
    }
  };

  const req: Parameters<ModelProvider["chat"]>[0] = {
    model: input.model,
    messages,
    temperature,
  };
  if (effectiveMaxTokens !== undefined) req.maxTokens = effectiveMaxTokens;
  if (input.reasoningEffort !== undefined) req.reasoningEffort = input.reasoningEffort;

  const callError = (error: unknown): { message: string; name: string; stack?: string } => {
    if (error instanceof Error) {
      return { name: error.name, message: error.message, ...(error.stack ? { stack: error.stack } : {}) };
    }
    return { name: "UnknownError", message: String(error) };
  };

  const isEmptyResponseError = (error: unknown): boolean =>
    error instanceof Error && error.message.includes(MODEL_CALL_EMPTY_RESPONSE_MARKER);

  for (let attempt = 1; attempt <= MODEL_CALL_MAX_ATTEMPTS; attempt += 1) {
    const requestArtifact = requestKey(attempt);
    const responseArtifact = responseKey(attempt);

    input.checkpoint.counters.modelCalls++;
    await input.objectStore.putJson(requestArtifact, request);

    let res: ChatCompletionResponse;
    try {
      res = await input.provider.chat(req);
    } catch (error) {
      const isProviderEmptyResponse = isEmptyResponseError(error);
      const normalizedError = callError(error);
      await persistResponseError({
        ...normalizedError,
        reason: `${isProviderEmptyResponse ? "provider empty response" : "provider chat failed"} on attempt ${attempt}`,
        attempt,
        responseArtifact,
      });

      if (attempt < MODEL_CALL_MAX_ATTEMPTS) {
        const reason = isProviderEmptyResponse ? "empty response" : "provider chat failure";
        await emitRetryEvent(attempt, reason, error, {
          ...(isProviderEmptyResponse ? { rawResponseLength: 0 } : {}),
        });
        continue;
      }

      throw error;
    }

    const normalizedResponse = normalizeResponse(res);
    if (!normalizedResponse.text.trim()) {
      const emptyResponseError = new Error(`${MODEL_CALL_EMPTY_RESPONSE_MARKER}: Empty model response`);
      const normalizedEmptyError = callError(emptyResponseError);
      const normalizedText = normalizedResponse.text;
      await persistResponseError({
        ...normalizedEmptyError,
        reason: `response contained no text on attempt ${attempt}`,
        attempt,
        responseArtifact,
        rawResponse: normalizedText,
        rawResponseLength: normalizedText.length,
      });

      if (attempt < MODEL_CALL_MAX_ATTEMPTS) {
        await emitRetryEvent(attempt, "empty response", emptyResponseError, {
          rawResponsePreview: normalizedText,
          rawResponseLength: normalizedText.length,
        });
        continue;
      }

      throw emptyResponseError;
    }

    const responsePersisted = await persistResponse(normalizedResponse, responseArtifact);
    if (!responsePersisted) {
      await persistResponseError({
        name: "ModelResponsePersistenceError",
        message: "Unable to persist model response",
        reason: "response persist failed",
        responseArtifact,
        ...(normalizedResponse.text ? { stack: String(normalizedResponse.text).slice(0, 400) } : {}),
      });
    }

    const outputHash = sha256Base64url(normalizedResponse.text);

    const modelCall: Parameters<PipelineStore["addModelCall"]>[0] = {
      runId: input.runId,
      phase: input.phase,
      modelId: input.model,
      params: {
        ...callAttemptContext,
        modelCallId: callId,
        retryAttempt: attempt - 1,
        temperature,
        maxTokensRequested: requestedMaxTokens,
        maxTokens: effectiveMaxTokens,
      },
      promptVersion: input.promptVersion,
      inputHash,
      outputHash,
      requestKey: requestArtifact,
      responseKey: responseArtifact,
    };
    if (res.usage?.inputTokens !== undefined) modelCall.tokensIn = res.usage.inputTokens;
    if (res.usage?.outputTokens !== undefined) modelCall.tokensOut = res.usage.outputTokens;
    if (res.usage?.costUsd !== undefined) modelCall.costUsd = res.usage.costUsd;

    try {
      const extractedJson = extractFirstJson(normalizedResponse.text);
      const compat = maybeCoerceSchemaCompat(persona, extractedJson.value);
      const schemaCompatMode =
        compat.schemaCompatMode ?? extractedJson.schemaCompatMode;
      const parsed = input.schema.parse(compat.value);
      const modelCallParams = {
        ...callAttemptContext,
        modelCallId: callId,
        retryAttempt: attempt - 1,
        temperature,
        maxTokensRequested: requestedMaxTokens,
        maxTokens: effectiveMaxTokens,
        effectiveMaxTokens,
        ...(schemaCompatMode ? { schemaCompatMode } : {}),
      };
      modelCall.params = modelCallParams;

      await input.store.addModelCall(modelCall);
      await input.store
        .addRunEvent({
          runId: input.runId,
          level: "info",
          phase: input.phase,
          eventType: "model_call_completed",
          message: `Model call succeeded for ${input.phase}`,
          data: {
            ...modelCallParams,
            retryAttempt: attempt - 1,
            maxRetries: MODEL_CALL_MAX_RETRIES,
            maxAttempts: MODEL_CALL_MAX_ATTEMPTS,
          },
        })
        .catch(() => {});

      if (res.usage) {
        const usageDelta: Parameters<PipelineStore["addUsageDelta"]>[0] = { userId: input.userId };
        if (res.usage.inputTokens !== undefined) usageDelta.modelTokensIn = res.usage.inputTokens;
        if (res.usage.outputTokens !== undefined) usageDelta.modelTokensOut = res.usage.outputTokens;
        if (res.usage.costUsd !== undefined) usageDelta.costUsd = res.usage.costUsd;
        input.store.addUsageDelta(usageDelta).catch(() => {});
      }

      input.store.updateRun({ runId: input.runId, state: input.checkpoint }).catch(() => {});

      return parsed;
    } catch (error) {
      const normalizedError = callError(error);
      const responseText = normalizedResponse.text;
      let parsedExtract: JsonExtractionResult | null = null;
      try {
        parsedExtract = extractFirstJson(responseText);
      } catch {
        parsedExtract = null;
      }
      const compat =
        parsedExtract === null ? null : maybeCoerceSchemaCompat(persona, parsedExtract.value);
      const schemaCompatMode =
        compat?.schemaCompatMode ?? parsedExtract?.schemaCompatMode;
      await persistResponseError({
        ...normalizedError,
        reason: `response parse/schema failed on attempt ${attempt}`,
        attempt,
        responseArtifact,
        rawResponse: responseText,
        rawResponseLength: responseText.length,
        rawResponsePreview: responseText.slice(0, 500),
      });
      if (attempt < MODEL_CALL_MAX_ATTEMPTS) {
        await emitRetryEvent(attempt, "response parse or schema validation", error, {
          rawResponsePreview: responseText.slice(0, 500),
          rawResponseLength: responseText.length,
          ...(schemaCompatMode ? { schemaCompatMode } : {}),
        });
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `Model call in ${input.phase} failed after ${MODEL_CALL_MAX_ATTEMPTS} attempts (${MODEL_CALL_MAX_RETRIES} retries)`
  );
}

function coerceCitationPolicy(v: unknown, fallback: CitationPolicy): CitationPolicy {
  if (v === "strict" || v === "balanced" || v === "loose") return v;
  return fallback;
}

function coerceBudgets(v: unknown, fallback: BudgetConfig): BudgetConfig {
  if (!v || typeof v !== "object") return fallback;
  const o = v as Partial<BudgetConfig>;
  return { ...fallback, ...o };
}

function coerceModels(v: unknown, fallback: PhaseModelConfig): PhaseModelConfig {
  if (!v || typeof v !== "object") return fallback;
  const o = v as Record<string, unknown>;
  return {
    planner: typeof o.planner === "string" ? o.planner : fallback.planner,
    synthesizer: typeof o.synthesizer === "string" ? o.synthesizer : fallback.synthesizer,
    verifier: typeof o.verifier === "string" ? o.verifier : fallback.verifier,
    verifierStrong:
      typeof o.verifierStrong === "string" ? o.verifierStrong : fallback.verifierStrong,
  };
}

function coerceThinkingMode(v: unknown): ThinkingMode {
  if (v === "low" || v === "high") return v;
  if (!v || typeof v !== "object" || Array.isArray(v)) return "high";
  const o = v as { thinkingMode?: unknown };
  return o.thinkingMode === "low" || o.thinkingMode === "high" ? o.thinkingMode : "high";
}

const AGENTIC_LOOP_LIMITS = {
  maxPlanPasses: 5,
  maxFollowUpTasksPerPass: 10,
} as const;

const SYNTHESIS_OUTPUT_LIMIT = {
  maxOutputTokens: 500_000,
} as const;
const MANAGED_SYNTHESIS_CONTEXT_TOKEN_WINDOW = 120_000;
const SYNTHESIS_OUTPUT_TOKEN_SAFETY_BUFFER = 1_024;
const SYNTHESIS_MIN_OUTPUT_TOKENS = 1;
const SYNTHESIS_MAX_QUOTES_PER_SOURCE = 3;
const SYNTHESIS_MAX_CLAIM_LENGTH = 320;
const CLAIM_SIMILARITY_RATIO = 0.82;
const SYNTHESIS_MAX_SOURCES_FOR_MODEL = 10;
const SYNTHESIS_MIN_PROMPT_TERM_SCORE = 0.08;
const SYNTHESIS_TARGET_MIN_SUMMARY_WORDS = 320;
const SYNTHESIS_REFINEMENT_MAX_RETRIES = 3;
const SYNTHESIS_REFINEMENT_ATTEMPTS = SYNTHESIS_REFINEMENT_MAX_RETRIES + 1;
const MODEL_CALL_MIN_OUTPUT_TOKENS = 8_000;
const MODEL_CALL_MAX_RETRIES = 3;
const MODEL_CALL_MAX_ATTEMPTS = MODEL_CALL_MAX_RETRIES + 1;
const SYNTHESIS_SOURCE_ABSTRACT_TRIGGER_SOURCE_COUNT = 8;
const SYNTHESIS_MAX_SOURCE_ABSTRACTS = 24;
const SYNTHESIS_MAX_CRITICAL_SOURCE_CONTEXTS = 6;
const SYNTHESIS_MAX_CRITICAL_SOURCE_EXCERPT_CHARS = 3_600;
const SYNTHESIS_MIN_REVIEW_SOURCE_COUNT = 2;
const SYNTHESIS_MAX_ABSTRACT_TEXT_LENGTH = 1_600;
const SYNTHESIS_MIN_SOURCE_INDEX_ENTRIES = 2;
const SYNTHESIS_MIN_QUOTE_TEXT_LENGTH = 80;
const SYNTHESIS_OFFICIAL_DOMAIN_HINTS = [
  "gov",
  "edu",
  "nist",
  "iea",
  "nrel",
  "iec",
  "eia",
  "ec",
  "ieee",
  "un",
  "energy",
  "energy.gov",
] as const;

const SYNTHESIS_SYSTEM_PROMPT = `## ROLE
You are a senior research analyst specializing in adversarial synthesis.
Your job is to read sources, find what they collectively imply but
individually cannot prove, and report this with epistemic rigor.

## INPUT DATA
[SOURCES: {{Paste documents here with clear delimiters or metadata}}]

## PHASE 1: SOURCE MAPPING
First, silently analyze:
- Domain expertise level of each source
- Temporal context (when written vs. events described)
- Stakeholder position (funding, institutional bias if detectable)
- Data types (anecdotal, statistical, theoretical)

## PHASE 2: ANALYSIS RULES
1. **No Source Left Behind**: Every significant claim in the final report
   must cite ≥1 source. Use [¹], [²] format.
2. **The Synthesis Test**: For every conclusion, ask: "Could I have reached this reading only Source X?"
   If yes, it is summary, not synthesis.
3. **Contradiction Preservation**: When sources conflict, present the conflict as data itself. Do not smooth over it.

For every major conclusion, include an evidence set that would materially weaken or collapse if any single source from that set were removed.
4. **Synthetic Preference**: favor conclusions that require multiple source families and would materially weaken if one major source is removed.

## PHASE 3: OUTPUT STRUCTURE

### Executive Summary
- 3 bullets max. Highest-level synthetic conclusion only.

### Source Index
- Numbered list of sources with 1-sentence reliability assessment.

### Thematic Synthesis (The "Smart" Section)
For each theme:
- Observation: What is visible across sources?
- Inference: What mechanism explains this pattern? [Show reasoning chain]
- Implication: What should a decision-maker do differently based on this intersection of sources?

### The Negative Space (The "Genius" Section)
- Missing Links: What causal chains are broken by missing data?
- Unasked Questions: What framework are all sources implicitly accepting without examination?
- Temporal Blindspots: If Source A (2020) is read through Source C (2024), what prediction was missed?

### Confidence Appendix
- List all [INFERRED] and [SPECULATIVE] conclusions with alternative interpretations that the sources also support.

## CONSTRAINT
If you cannot find at least one Category 3 (Synthetic) conclusion, state explicitly:
"The sources provided do not sufficiently intersect to generate emergent insights. Recommendation: acquire sources covering [specific gap]."`;

const SYNTHESIS_SYSTEM_REVIEW_PROMPT =
  "You are a peer reviewer attacking this report. Which conclusions exceed the source evidence?";

const SYNTHESIS_SOURCE_ABSTRACTS_OUTPUT_SCHEMA = z.object({
  sourceAbstracts: z.array(
    z.object({
      source: z.string().min(1),
      methodology: z.string().min(1),
      temporalContext: z.string().min(1),
      dataTypes: z.array(z.string().min(1)).default([]),
      stakeholderPosition: z.string().min(1),
      representativeClaims: z.array(z.string().min(1)).default([]),
      keyConstraints: z.array(z.string().min(1)).default([]),
    })
  ),
  synthesisNotes: z.array(z.string().min(1)).default([]),
});

const SYNTHESIS_SOURCE_ABSTRACT_SYSTEM_PROMPT =
  "Create concise source synthesis abstracts that capture methodology, temporal context, stakeholder position, and key constraints that limit inference.\n" +
  "Return strict JSON only. Do not use markdown, code fences, comments, or prose.\n" +
  "Output must be exactly this shape:\n" +
  '{ "sourceAbstracts": [ { "source": "S1", "methodology": "...", "temporalContext": "...", "dataTypes": ["..."], "stakeholderPosition": "...", "representativeClaims": ["..."], "keyConstraints": ["..."] } ], "synthesisNotes": ["..."] }.\n' +
  "Required keys for each sourceAbstract: source (string), methodology (string), temporalContext (string), dataTypes (string[]), stakeholderPosition (string), representativeClaims (string[]), keyConstraints (string[]).\n" +
  "All string fields must be non-empty after trimming and all arrays should be omitted only if empty.";

const SYNTHESIS_SYSTEM_REVIEW_SCHEMA_PROMPT =
  " Return strict JSON only in the exact shape:\n" +
  '{ "verdict": "accept|revise|reject", "unsupportedConclusions": [ { "findingId": "string", "issue": "string", "why": "string", "strengtheningAlternative": "string" } ], "missingEvidence": ["string"], "requestedRevisions": ["string"], "confidenceRisk": 0|1|...|10 }\n' +
  "Do not use alternate keys like summaryIssues/keyFindingsIssues/recommendationsIssues. All strings must be non-empty and arrays may be empty.";

const SYNTHESIS_SYSTEM_REVIEW_PROMPT_WITH_SCHEMA =
  `${SYNTHESIS_SYSTEM_REVIEW_PROMPT}${SYNTHESIS_SYSTEM_REVIEW_SCHEMA_PROMPT}`;

const SYNTHESIS_REVIEW_SCHEMA = z.object({
  verdict: z.enum(["accept", "revise", "reject"]),
  unsupportedConclusions: z
    .array(
      z.object({
        findingId: z.string().min(1),
        issue: z.string().min(1),
        why: z.string().min(1),
        strengtheningAlternative: z.string().min(1),
      })
    )
    .default([]),
  missingEvidence: z.array(z.string().min(1)).default([]),
  requestedRevisions: z.array(z.string().min(1)).default([]),
  confidenceRisk: z.number().min(0).max(10).optional(),
});

type SynthesisSourceAbstract = z.infer<typeof SYNTHESIS_SOURCE_ABSTRACTS_OUTPUT_SCHEMA.shape.sourceAbstracts.element>;
type SynthesisReviewOutput = z.infer<typeof SYNTHESIS_REVIEW_SCHEMA>;
type SynthesisReviewIssue = {
  findingId: string;
  issue: string;
  why: string;
  strengtheningAlternative: string;
};
type SynthesisReviewFeedbackPayload = {
  verdict: SynthesisReviewOutput["verdict"];
  unsupportedConclusions: SynthesisReviewIssue[];
  missingEvidence: string[];
  requestedRevisions: string[];
  confidenceRisk?: number;
  directives: string[];
};

function clampPositiveInteger(
  value: unknown,
  fallback: number,
  hardLimit: number | null = null
): number {
  const n = typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
  if (hardLimit === null) return n;
  return Math.min(n, hardLimit);
}

function coerceAgenticLoopConfig(v: unknown, fallback: AgenticLoopConfig): AgenticLoopConfig {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fallback;
  const o = v as {
    maxPlanPasses?: unknown;
    maxFollowUpTasksPerPass?: unknown;
  };
  return {
    maxPlanPasses: clampPositiveInteger(
      o.maxPlanPasses,
      fallback.maxPlanPasses,
      AGENTIC_LOOP_LIMITS.maxPlanPasses
    ),
    maxFollowUpTasksPerPass: clampPositiveInteger(
      o.maxFollowUpTasksPerPass,
      fallback.maxFollowUpTasksPerPass,
      AGENTIC_LOOP_LIMITS.maxFollowUpTasksPerPass
    ),
  };
}

function coerceSynthesisConfig(v: unknown, fallback: SynthesisConfig): SynthesisConfig {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fallback;
  const o = v as {
    maxInputTokens?: unknown;
    maxOutputTokens?: unknown;
  };
  const maxInputTokens = clampPositiveInteger(o.maxInputTokens, fallback.maxInputTokens);
  const maxOutputTokens = clampPositiveInteger(
    o.maxOutputTokens,
    fallback.maxOutputTokens,
    SYNTHESIS_OUTPUT_LIMIT.maxOutputTokens
  );
  return { maxInputTokens, maxOutputTokens };
}

function coerceResearchLoopConfig(v: unknown, fallback: ResearchLoopConfig): ResearchLoopConfig {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fallback;
  const o = v as {
    enabled?: unknown;
    maxIterations?: unknown;
    sourcesPerIteration?: unknown;
    mode?: unknown;
    switchToHybridAfterRejects?: unknown;
    fullContext?: unknown;
  };

  const enabled = typeof o.enabled === "boolean" ? o.enabled : fallback.enabled;
  const maxIterations = clampPositiveInteger(o.maxIterations, fallback.maxIterations);
  const mode = o.mode === "auto" || o.mode === "incremental" || o.mode === "hybrid" ? o.mode : fallback.mode;
  const switchToHybridAfterRejects = clampPositiveInteger(
    o.switchToHybridAfterRejects,
    fallback.switchToHybridAfterRejects
  );
  const fullContext = typeof o.fullContext === "boolean" ? o.fullContext : fallback.fullContext === true;

  const sourcesPerIteration =
    typeof o.sourcesPerIteration === "number" &&
    Number.isFinite(o.sourcesPerIteration) &&
    Number.isInteger(o.sourcesPerIteration) &&
    o.sourcesPerIteration > 0
      ? o.sourcesPerIteration
      : fallback.sourcesPerIteration;

  return {
    enabled,
    maxIterations,
    mode,
    switchToHybridAfterRejects,
    fullContext,
    ...(sourcesPerIteration !== undefined ? { sourcesPerIteration } : {}),
  };
}

export async function runResearchPipeline(input: {
  runId: string;
  config: OpenResearchConfig;
  services: PipelineServices;
  debugCapture?: { enabled: boolean; reason?: string };
  shouldCancel?: () => Promise<boolean>;
}): Promise<void> {
  const run = await input.services.store.getRun(input.runId);
  if (!run) throw new Error(`Run not found: ${input.runId}`);

  const checkpoint = safeParseCheckpoint(run.state);
  const startedAt = checkpoint.startedAt ? Date.parse(checkpoint.startedAt) : Date.now();
  const budgets = coerceBudgets(run.budgets, input.config.budgets);
  const citationPolicy = coerceCitationPolicy(run.citation_policy, input.config.citationPolicy);
  const models = coerceModels(run.model_config, input.config.models);
  const modelRouter = new ModelRouter(models);
  const adapterConfigObject =
    run.adapter_config && typeof run.adapter_config === "object" && !Array.isArray(run.adapter_config)
      ? (run.adapter_config as Record<string, unknown>)
      : {};
  const fullProfile = input.config.policies.qualityProfiles.full;
  const fullProfileAgenticLoop = fullProfile.agenticLoop ?? AgenticLoopConfigSchema.parse({});
  const fullProfileSynthesis = fullProfile.synthesis ?? SynthesisConfigSchema.parse({});
  const fullProfileResearchLoop = fullProfile.researchLoop ?? ResearchLoopConfigSchema.parse({});
  const thinkingMode = coerceThinkingMode(adapterConfigObject);
  const agenticLoop = coerceAgenticLoopConfig(
    adapterConfigObject.agenticLoop,
    fullProfileAgenticLoop
  );
  const synthesisConfig = coerceSynthesisConfig(
    adapterConfigObject.synthesis,
    fullProfileSynthesis
  );
  const researchLoopConfig = coerceResearchLoopConfig(
    adapterConfigObject.researchLoop,
    fullProfileResearchLoop
  );
  const maxSynthesisInputTokens = Math.max(1, synthesisConfig.maxInputTokens);
  const maxSynthesisOutputTokens = Math.min(
    SYNTHESIS_OUTPUT_LIMIT.maxOutputTokens,
    synthesisConfig.maxOutputTokens
  );

  checkpoint.debug = input.debugCapture ?? checkpoint.debug;
  checkpoint.startedAt = checkpoint.startedAt ?? new Date(startedAt).toISOString();

  const now = Date.now();
  const startUpdate: Parameters<PipelineStore["updateRun"]>[0] = {
    runId: run.id,
    status: "running",
    phase: checkpoint.nextPhase,
    state: checkpoint,
  };
  if (run.status === "queued") startUpdate.startedAt = new Date(now);
  await input.services.store.updateRun(startUpdate);

  const startWall = startedAt;
  const deadline = startWall + budgets.maxRuntimeMs;

  const phaseOrder: PipelinePhase[] = [
    "plan",
    "retrieve",
    "fetch",
    "extract",
    "synthesize",
    "verify",
    "finalize",
  ];

  const fail = async (phase: PipelinePhase, err: unknown) => {
    await input.services.store.addRunEvent({
      runId: run.id,
      level: "error",
      phase,
      eventType: "phase_failed",
      message: err instanceof Error ? err.message : String(err),
      data: {
        error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
      },
    });
    await input.services.store.updateRun({
      runId: run.id,
      status: "failed",
      phase,
      error:
        err instanceof Error
          ? { message: err.message, stack: err.stack }
          : { message: String(err) },
      finishedAt: new Date(),
    });
  };

  const markPhase = async (phase: PipelinePhase) => {
    checkpoint.nextPhase = phase;
    await input.services.store.updateRun({ runId: run.id, phase, state: checkpoint });
    await input.services.store.addRunEvent({
      runId: run.id,
      level: "info",
      phase,
      eventType: "phase_started",
      message: `Phase started: ${phase}`,
    });
  };

  const completePhase = async (phase: PipelinePhase) => {
    await input.services.store.addRunEvent({
      runId: run.id,
      level: "info",
      phase,
      eventType: "phase_completed",
      message: `Phase completed: ${phase}`,
    });
  };

  try {
    for (const phase of phaseOrder) {
      if (input.shouldCancel && (await input.shouldCancel())) {
        await input.services.store.addRunEvent({
          runId: run.id,
          level: "info",
          phase: checkpoint.nextPhase,
          eventType: "run_canceled",
        });
        await input.services.store.updateRun({
          runId: run.id,
          status: "canceled",
          phase: checkpoint.nextPhase,
          state: checkpoint,
          finishedAt: new Date(),
        });
        return;
      }

      if (Date.now() > deadline) {
        await input.services.store.addRunEvent({
          runId: run.id,
          level: "warn",
          phase,
          eventType: "budget_exhausted",
          message: "Runtime budget exhausted; finalizing best-effort output",
        });
        checkpoint.nextPhase = "finalize";
      }

      if (phase !== checkpoint.nextPhase) continue;

      if (phase === "plan") {
        await markPhase("plan");
        const planKey = checkpoint.artifacts.planKey ?? runPlanKey(run.id);
        let plan = (await input.services.objectStore.getJson<PlanOutput>(planKey)) ?? null;
        let passCount = 1;
        if (!plan) {
          const subquestions = new Set<string>();
          const queries = new Set<string>();
          let followUpTasks: string[] = [];
          let pass = 0;
          const maxPlanPasses = Math.max(1, agenticLoop.maxPlanPasses);
          const maxFollowUpTasksPerPass = Math.max(1, agenticLoop.maxFollowUpTasksPerPass);

          while (pass < maxPlanPasses) {
            pass += 1;
            await input.services.store.addRunEvent({
              runId: run.id,
              level: "info",
              phase: "plan",
              eventType: "plan_pass_started",
              message: `Plan pass ${pass}/${maxPlanPasses} started`,
              data: {
                pass,
                maxPlanPasses,
                carryOverFollowUpTasks: followUpTasks.length,
              },
            });

            const passResult = await planPhase({
              runId: run.id,
              userId: run.user_id,
              prompt: run.prompt,
              provider: input.services.modelProvider,
              model: modelRouter.modelForPhase("plan"),
              thinkingMode,
              store: input.services.store,
              objectStore: input.services.objectStore,
              checkpoint,
              completedSubquestions: Array.from(subquestions),
              carryOverFollowUpTasks: followUpTasks,
            });

            for (const sub of passResult.subquestions) subquestions.add(sub);
            for (const q of passResult.queries) queries.add(q);

            const requestedFollowUps = passResult.followUpTasks ?? [];
            const uniqueFollowUps = Array.from(new Set(requestedFollowUps));
            if (uniqueFollowUps.length > maxFollowUpTasksPerPass) {
              await input.services.store.addRunEvent({
                runId: run.id,
                level: "warn",
                phase: "plan",
                eventType: "plan_follow_ups_trimmed",
                message: "Follow-up tasks truncated to follow-up task limit",
                data: {
                  pass,
                  requestedFollowUpTasks: uniqueFollowUps.length,
                  scheduledFollowUpTasks: maxFollowUpTasksPerPass,
                  hardLimit: maxFollowUpTasksPerPass,
                },
              });
            }

            followUpTasks = uniqueFollowUps.slice(0, maxFollowUpTasksPerPass);

            await input.services.store.addRunEvent({
              runId: run.id,
              level: "info",
              phase: "plan",
              eventType: "plan_pass_completed",
              message: `Plan pass ${pass} completed`,
              data: {
                pass,
                followUpTasksScheduled: followUpTasks.length,
                queriesGenerated: passResult.queries.length,
                subquestionsGenerated: passResult.subquestions.length,
              },
            });

            if (!passResult.continuePlanning || followUpTasks.length === 0) break;
            await input.services.store.addRunEvent({
              runId: run.id,
              level: "info",
              phase: "plan",
              eventType: "plan_continue_requested",
              message: "Planner requested an additional plan pass",
              data: {
                pass,
                plannedNextPass: followUpTasks.length,
                carryOverFollowUpTasks: followUpTasks.length,
                maxPlanPasses,
              },
            });
          }
          passCount = pass;

          if (followUpTasks.length > 0 && pass >= maxPlanPasses) {
            await input.services.store.addRunEvent({
              runId: run.id,
              level: "warn",
              phase: "plan",
              eventType: "plan_loop_cap_reached",
              message: `Plan follow-up loop capped at ${maxPlanPasses} passes`,
              data: {
                passCap: maxPlanPasses,
                hardPassCap: AGENTIC_LOOP_LIMITS.maxPlanPasses,
                remainingFollowUpTasks: followUpTasks.length,
              },
            });
          }

          plan = {
            subquestions: Array.from(subquestions),
            queries: queries.size ? Array.from(queries) : [run.prompt],
          };

          const planTodoItems = buildPlanTodoItems(plan);
          const planTodoHints = buildPlanTodoHints(plan);
          await input.services.store.addRunEvent({
            runId: run.id,
            level: "info",
            phase: "plan",
            eventType: "plan_todo_list_ready",
            message: "Plan to-do list generated",
            data: {
              passCount,
              maxPlanPasses,
              items: planTodoItems,
              queryHints: planTodoHints,
            },
          });

          await input.services.objectStore.putJson(planKey, plan);
          await input.services.store.updateRun({ runId: run.id, plan });
        }

        if (!checkpoint.questionGraph) {
          const questionGraph = await extractQuestionGraphFromPrompt({
            runId: run.id,
            userId: run.user_id,
            prompt: run.prompt,
            plan: plan,
            provider: input.services.modelProvider,
            model: modelRouter.modelForPhase("plan"),
            thinkingMode,
            store: input.services.store,
            objectStore: input.services.objectStore,
            checkpoint,
          });
          checkpoint.questionGraph = questionGraph;
          await input.services.store.updateRun({ runId: run.id, state: checkpoint });
          await input.services.objectStore
            .putJson(runArtifactKey(run.id, "question-graph.json"), questionGraph)
            .catch(() => {});
          await input.services.store
            .addRunEvent({
              runId: run.id,
              level: "info",
              phase: "plan",
              eventType: "question_graph_ready",
              message: (() => {
                const deps = questionGraph.questions
                  .filter((q) => q.dependsOn.length > 0)
                  .map((q) => `${q.id}<-(${q.dependsOn.join(",")})`);
                const depLine = deps.length ? `\n  Dependencies: ${deps.join(" ")}` : "";
                return `Core question graph ready (questions=${questionGraph.questions.length}, validated=${questionGraph.validated})${depLine}`;
              })(),
              data: {
                questionCount: questionGraph.questions.length,
                validated: questionGraph.validated,
                questions: questionGraph.questions.map((q) => ({
                  id: q.id,
                  text: q.text,
                  dependsOn: q.dependsOn,
                })),
              },
            })
            .catch(() => {});
        }
        checkpoint.artifacts.planKey = planKey;
        checkpoint.nextPhase = "retrieve";
        await input.services.store.updateRun({
          runId: run.id,
          phase: "retrieve",
          state: checkpoint,
        });
        await completePhase("plan");
      }

      if (phase === "retrieve") {
        await markPhase("retrieve");
        const plan = await input.services.objectStore.getJson<PlanOutput>(
          checkpoint.artifacts.planKey!
        );
        if (!plan) throw new Error("Missing plan artifact");

        if (researchLoopConfig.enabled) {
          await runResearchLoop({
            runId: run.id,
            userId: run.user_id,
            prompt: run.prompt,
            citationPolicy,
            budgets,
            models,
            thinkingMode,
            loopConfig: researchLoopConfig,
            deadlineMs: deadline,
            services: {
              store: input.services.store,
              objectStore: input.services.objectStore,
              search: input.services.search,
              httpFetch: input.services.httpFetch,
              ...(input.services.browserRender ? { browserRender: input.services.browserRender } : {}),
              ...(input.services.modelProvider ? { modelProvider: input.services.modelProvider } : {}),
            },
            checkpoint,
            synthesis: {
              maxInputTokens: Math.min(maxSynthesisInputTokens, MANAGED_SYNTHESIS_CONTEXT_TOKEN_WINDOW),
              maxOutputTokens: maxSynthesisOutputTokens,
              contextWindowTokens: Math.min(
                maxSynthesisInputTokens,
                MANAGED_SYNTHESIS_CONTEXT_TOKEN_WINDOW
              ),
              requestedMaxInputTokens: maxSynthesisInputTokens,
              requestedMaxOutputTokens: maxSynthesisOutputTokens,
            },
            steps: {
              retrieve: retrievePhase,
              fetch: fetchPhase,
              extract: extractPhase,
              loadLabeledSources,
              synthesize: synthesizePhase,
              review: async (reviewInput) => {
                const sourcesForReview: SynthesisSourceBrief[] = reviewInput.sources.map((s) => ({
                  source: s.label,
                  url: s.url,
                  title: s.title,
                  publisher: s.publisher,
                  ...(s.contentText !== undefined ? { fullText: s.contentText } : {}),
                  quotes: s.quotes.map((q) => ({
                    quoteId: q.quoteId,
                    start: q.start,
                    end: q.end,
                    text: q.text,
                  })),
                }));
                const review = await reviewSynthesisDraft({
                  runId: reviewInput.runId,
                  userId: reviewInput.userId,
                  prompt: reviewInput.prompt,
                  sources: sourcesForReview,
                  synthesis: reviewInput.synthesis,
                  provider: reviewInput.provider,
                  model: reviewInput.model,
                  thinkingMode: reviewInput.thinkingMode,
                  store: reviewInput.store,
                  objectStore: reviewInput.objectStore,
                  checkpoint: reviewInput.checkpoint,
                });
                return {
                  verdict: review.verdict,
                  unsupportedConclusions: review.unsupportedConclusions ?? [],
                  missingEvidence: review.missingEvidence ?? [],
                  requestedRevisions: review.requestedRevisions ?? [],
                  confidenceRisk: review.confidenceRisk,
                };
              },
              callModelJsonLogged,
            },
          });

          checkpoint.nextPhase = "verify";
          await input.services.store.updateRun({ runId: run.id, phase: "verify", state: checkpoint });
          await completePhase("retrieve");
        } else {
          const retrievalKey = checkpoint.artifacts.retrievalKey ?? runRetrievalKey(run.id);
          let retrieval = await input.services.objectStore.getJson<RetrievalOutput>(retrievalKey);
          if (!retrieval) {
            retrieval = await retrievePhase({
              runId: run.id,
              userId: run.user_id,
              budgets,
              queries: plan.queries,
              search: input.services.search,
              store: input.services.store,
              maxSelectedUrls: budgets.maxSources,
              seenUrls: new Set(),
            });
            await input.services.objectStore.putJson(retrievalKey, retrieval);
          }
          checkpoint.artifacts.retrievalKey = retrievalKey;
          checkpoint.selectedUrls = retrieval.selectedUrls;

          if (!checkpoint.sourceIds) {
            checkpoint.sourceIds = [];
            for (const url of retrieval.selectedUrls) {
              const src = await input.services.store.createSource({ runId: run.id, url });
              checkpoint.sourceIds.push(src.id);
            }
          }

          checkpoint.nextPhase = "fetch";
          await input.services.store.updateRun({
            runId: run.id,
            phase: "fetch",
            state: checkpoint,
          });
          await completePhase("retrieve");
        }
      }

      if (phase === "fetch") {
        await markPhase("fetch");
        await fetchPhase({
          runId: run.id,
          userId: run.user_id,
          budgets,
          checkpoint,
          store: input.services.store,
          objectStore: input.services.objectStore,
          httpFetch: input.services.httpFetch,
        });
        checkpoint.nextPhase = "extract";
        await input.services.store.updateRun({
          runId: run.id,
          phase: "extract",
          state: checkpoint,
        });
        await completePhase("fetch");
      }

      if (phase === "extract") {
        await markPhase("extract");
        await extractPhase({
          runId: run.id,
          userId: run.user_id,
          budgets,
          checkpoint,
          store: input.services.store,
          objectStore: input.services.objectStore,
          browser: input.services.browserRender,
        });
        checkpoint.nextPhase = "synthesize";
        await input.services.store.updateRun({
          runId: run.id,
          phase: "synthesize",
          state: checkpoint,
        });
        await completePhase("extract");
      }

      if (phase === "synthesize") {
        await markPhase("synthesize");
        const synthesisKey = checkpoint.artifacts.synthesisKey ?? runSynthesisKey(run.id);
        let synthesis = await input.services.objectStore.getJson<SynthesisOutput>(synthesisKey);
        if (!synthesis) {
          const sources = await loadLabeledSources({
            runId: run.id,
            checkpoint,
            store: input.services.store,
            objectStore: input.services.objectStore,
          });
          checkpoint.sourceLabels = Object.fromEntries(sources.map((s) => [s.sourceId, s.label]));

          synthesis = await synthesizePhase({
            runId: run.id,
            userId: run.user_id,
            prompt: run.prompt,
            sources,
            citationPolicy,
            provider: input.services.modelProvider,
            model: modelRouter.modelForPhase("synthesize"),
            thinkingMode,
            maxInputTokens: Math.min(
              maxSynthesisInputTokens,
              MANAGED_SYNTHESIS_CONTEXT_TOKEN_WINDOW
            ),
            maxOutputTokens: maxSynthesisOutputTokens,
            requestedMaxInputTokens: maxSynthesisInputTokens,
            requestedMaxOutputTokens: maxSynthesisOutputTokens,
            synthesisContextWindowTokens: Math.min(
              maxSynthesisInputTokens,
              MANAGED_SYNTHESIS_CONTEXT_TOKEN_WINDOW
            ),
            store: input.services.store,
            objectStore: input.services.objectStore,
            checkpoint,
          });
          await input.services.objectStore.putJson(synthesisKey, synthesis);
        }
        checkpoint.artifacts.synthesisKey = synthesisKey;
        checkpoint.nextPhase = "verify";
        await input.services.store.updateRun({ runId: run.id, phase: "verify", state: checkpoint });
        await completePhase("synthesize");
      }

      if (phase === "verify") {
        await markPhase("verify");
        try {
          const sources = await loadLabeledSources({
            runId: run.id,
            checkpoint,
            store: input.services.store,
            objectStore: input.services.objectStore,
          }).catch(() => []);

          const synthesisKeyCandidates: string[] = [];
          const pushKey = (key: unknown) => {
            if (typeof key === "string" && key.trim()) synthesisKeyCandidates.push(key.trim());
          };
          pushKey(checkpoint.artifacts.synthesisKey);
          pushKey(checkpoint.synthesisState?.snapshotKey);
          pushKey(runSynthesisKey(run.id));
          pushKey(checkpoint.researchLoop?.lastSynthesisKey);
          const lastIterationSynthesisKey = checkpoint.researchLoop?.iterations
            ?.slice()
            .sort((a, b) => a.iteration - b.iteration)
            .at(-1)?.artifacts.synthesisKey;
          pushKey(lastIterationSynthesisKey);

          const dedupedSynthesisKeys = Array.from(new Set(synthesisKeyCandidates));
          let synthesis: SynthesisOutput | null = null;
          let synthesisKeyUsed: string | null = null;
          for (const key of dedupedSynthesisKeys) {
            const raw = await input.services.objectStore.getJson<unknown>(key);
            if (!raw) continue;
            const parsed = SynthesisOutputSchema.safeParse(raw);
            if (!parsed.success) continue;
            synthesis = parsed.data;
            synthesisKeyUsed = key;
            break;
          }

          if (!synthesis) {
            await input.services.store
              .addRunEvent({
                runId: run.id,
                level: "warn",
                phase: "verify",
                eventType: "verify_skipped_missing_synthesis",
                message:
                  "Skipping verify phase due to missing/invalid synthesis; finalizing best-effort output",
                data: { synthesisKeyCandidates: dedupedSynthesisKeys },
              })
              .catch(() => {});
          } else {
            if (synthesisKeyUsed) checkpoint.artifacts.synthesisKey = synthesisKeyUsed;

            const citationMap = buildCitationMap({
              runId: run.id,
              policy: citationPolicy,
              synthesis,
              sources,
            });
            const evidenceBySourceId: Record<string, ExtractedEvidence | undefined> = {};
            for (const s of sources) {
              const ev = await input.services.objectStore.getJson<ExtractedEvidence>(
                sourceEvidenceKey(run.id, s.sourceId)
              );
              evidenceBySourceId[s.sourceId] = ev ?? undefined;
            }

            const { report, markdown } = validateCitations({
              runId: run.id,
              policy: citationPolicy,
              citationMap,
              evidenceBySourceId,
            });

            const citationMapKey = checkpoint.artifacts.citationMapKey ?? runCitationMapKey(run.id);
            const verificationJsonKey =
              checkpoint.artifacts.verificationJsonKey ?? runVerificationJsonKey(run.id);
            const verificationMarkdownKey =
              checkpoint.artifacts.verificationMarkdownKey ?? runVerificationMarkdownKey(run.id);

            await input.services.objectStore.putJson(citationMapKey, citationMap);
            await input.services.objectStore.putJson(verificationJsonKey, report);
            await input.services.objectStore.putText(verificationMarkdownKey, markdown);

            // Persist citations table (best-effort)
            try {
              for (const claim of citationMap.claims) {
                for (const cit of claim.citations) {
                  await input.services.store.addCitation({
                    runId: run.id,
                    claimId: claim.id,
                    sourceId: cit.sourceId,
                    ...(cit.quote ? { quoteStart: cit.quote.start, quoteEnd: cit.quote.end } : {}),
                  });
                }
              }
            } catch (err) {
              await input.services.store
                .addRunEvent({
                  runId: run.id,
                  level: "warn",
                  phase: "verify",
                  eventType: "citation_persist_failed",
                  message: "Failed to persist some citations; continuing",
                  data: { error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err) },
                })
                .catch(() => {});
            }

            checkpoint.artifacts.citationMapKey = citationMapKey;
            checkpoint.artifacts.verificationJsonKey = verificationJsonKey;
            checkpoint.artifacts.verificationMarkdownKey = verificationMarkdownKey;
          }

          checkpoint.nextPhase = "finalize";
          await input.services.store.updateRun({ runId: run.id, phase: "finalize", state: checkpoint });
        } catch (err) {
          await input.services.store
            .addRunEvent({
              runId: run.id,
              level: "error",
              phase: "verify",
              eventType: "verify_failed_best_effort",
              message: "Verify encountered an unexpected error; continuing to finalize",
              data: { error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err) },
            })
            .catch(() => {});
          checkpoint.nextPhase = "finalize";
          await input.services.store
            .updateRun({ runId: run.id, phase: "finalize", state: checkpoint })
            .catch(() => {});
        }
        await completePhase("verify");
      }

      if (phase === "finalize") {
        await markPhase("finalize");
        try {
          const sources = await loadLabeledSources({
            runId: run.id,
            checkpoint,
            store: input.services.store,
            objectStore: input.services.objectStore,
          }).catch(() => []);

          const synthesisKeyCandidates: string[] = [];
          const pushKey = (key: unknown) => {
            if (typeof key === "string" && key.trim()) synthesisKeyCandidates.push(key.trim());
          };
          pushKey(checkpoint.artifacts.synthesisKey);
          pushKey(checkpoint.synthesisState?.snapshotKey);
          pushKey(runSynthesisKey(run.id));
          pushKey(checkpoint.researchLoop?.lastSynthesisKey);
          const lastIterationSynthesisKey = checkpoint.researchLoop?.iterations
            ?.slice()
            .sort((a, b) => a.iteration - b.iteration)
            .at(-1)?.artifacts.synthesisKey;
          pushKey(lastIterationSynthesisKey);

          const dedupedSynthesisKeys = Array.from(new Set(synthesisKeyCandidates));
          let synthesis: SynthesisOutput | null = null;
          let synthesisKeyUsed: string | null = null;
          for (const key of dedupedSynthesisKeys) {
            const raw = await input.services.objectStore.getJson<unknown>(key);
            if (!raw) continue;
            const parsed = SynthesisOutputSchema.safeParse(raw);
            if (!parsed.success) continue;
            synthesis = parsed.data;
            synthesisKeyUsed = key;
            break;
          }

          if (!synthesis) {
            synthesis = SynthesisOutputSchema.parse({
              summary: "Best-effort synthesis from available artifacts.",
              keyFindings: [{ id: "F1", text: "Insufficient synthesis state; review sources directly.", citations: [] }],
              unknowns: [],
            });
          } else if (synthesisKeyUsed) {
            checkpoint.artifacts.synthesisKey = synthesisKeyUsed;
          }

          const isCitationMapLike = (value: unknown): value is CitationMap => {
            if (!value || typeof value !== "object" || Array.isArray(value)) return false;
            const cast = value as Record<string, unknown>;
            return cast.version === 1 && Array.isArray(cast.claims) && Array.isArray(cast.sources);
          };

          const citationMapKeyCandidates: string[] = [];
          const pushCitationKey = (key: unknown) => {
            if (typeof key === "string" && key.trim()) citationMapKeyCandidates.push(key.trim());
          };
          pushCitationKey(checkpoint.artifacts.citationMapKey);
          pushCitationKey(runCitationMapKey(run.id));
          const lastIterationCitationMapKey = checkpoint.researchLoop?.iterations
            ?.slice()
            .sort((a, b) => a.iteration - b.iteration)
            .at(-1)?.artifacts.citationMapKey;
          pushCitationKey(lastIterationCitationMapKey);
          const dedupedCitationMapKeys = Array.from(new Set(citationMapKeyCandidates));

          let citationMap: CitationMap | null = null;
          let citationMapKeyUsed: string | null = null;
          for (const key of dedupedCitationMapKeys) {
            const raw = await input.services.objectStore.getJson<unknown>(key);
            if (!raw) continue;
            if (!isCitationMapLike(raw)) continue;
            citationMap = raw as CitationMap;
            citationMapKeyUsed = key;
            break;
          }

          if (!citationMap) {
            citationMap = buildCitationMap({
              runId: run.id,
              policy: citationPolicy,
              synthesis,
              sources,
            });
            const key = checkpoint.artifacts.citationMapKey ?? runCitationMapKey(run.id);
            await input.services.objectStore.putJson(key, citationMap).catch(() => {});
            checkpoint.artifacts.citationMapKey = key;
          } else if (citationMapKeyUsed) {
            checkpoint.artifacts.citationMapKey = citationMapKeyUsed;
          }

          let outputMd = "";
          try {
            outputMd = renderResearchMemoMarkdown({ synthesis, citationMap });
          } catch (err) {
            await input.services.store
              .addRunEvent({
                runId: run.id,
                level: "warn",
                phase: "finalize",
                eventType: "finalize_render_fallback",
                message: "renderResearchMemoMarkdown failed; writing minimal best-effort output",
                data: { error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err) },
              })
              .catch(() => {});
            const sourceLines = sources.map((s) => `- ${s.url}`);
            outputMd = [
              "# Research memo",
              "",
              "## Summary",
              "",
              synthesis.summary,
              "",
              "## Key findings",
              "",
              ...synthesis.keyFindings.map((f) => `- ${f.text}`),
              "",
              "## Sources",
              "",
              ...(sourceLines.length ? sourceLines : ["- (none)"]),
              "",
            ].join("\n");
          }

          const outputKey = checkpoint.artifacts.outputKey ?? runOutputKey(run.id);
          await input.services.objectStore.putText(outputKey, outputMd).catch(async (err) => {
            await input.services.store
              .addRunEvent({
                runId: run.id,
                level: "error",
                phase: "finalize",
                eventType: "finalize_output_write_failed",
                message: "Failed to write output.md to object store",
                data: { error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err) },
              })
              .catch(() => {});
          });
          checkpoint.artifacts.outputKey = outputKey;

          const iterationCompleted = checkpoint.researchLoop?.iterationCountCompleted ?? 0;
          if (input.services.store.createRunCheckpoint) {
            const payload = {
              version: 1,
              runId: run.id,
              createdAt: new Date().toISOString(),
              checkpointVersion: 1,
              kind: "finalize" as const,
              iterationCompleted,
              pipelineCheckpoint: checkpoint,
              seenUrls: checkpoint.researchLoop?.seenUrls ?? [],
              seenQueries: checkpoint.researchLoop?.seenQueries ?? [],
              questionGraph: checkpoint.questionGraph ?? null,
              synthesisState: checkpoint.synthesisState ?? null,
              sourceArtifacts: sources.map((s) => ({
                label: s.label,
                sourceId: s.sourceId,
                url: s.url,
                title: s.title,
                publisher: s.publisher,
                fetchedAt: s.fetchedAt,
                evidenceKey: sourceEvidenceKey(run.id, s.sourceId),
              })),
              budgets,
              deadlineMs: deadline,
            };
            await input.services.store
              .createRunCheckpoint({
                runId: run.id,
                kind: "finalize",
                checkpointVersion: 1,
                iterationCompleted,
                payload,
              })
              .catch(() => {});
          }

          await input.services.store.updateRun({
            runId: run.id,
            status: "completed",
            phase: "finalize",
            state: checkpoint,
            error: null,
            finishedAt: new Date(),
          });
        } catch (err) {
          await input.services.store
            .addRunEvent({
              runId: run.id,
              level: "error",
              phase: "finalize",
              eventType: "finalize_failed_best_effort",
              message: "Finalize encountered an unexpected error; marking run completed with best-effort output where possible",
              data: { error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err) },
            })
            .catch(() => {});
          await input.services.store.updateRun({
            runId: run.id,
            status: "completed",
            phase: "finalize",
            state: checkpoint,
            finishedAt: new Date(),
          });
        }
        await completePhase("finalize");
      }
    }
  } catch (err) {
    await fail(checkpoint.nextPhase, err);
  }
}

async function planPhase(input: {
  runId: string;
  userId: string;
  prompt: string;
  provider: ModelProvider | undefined;
  model: string;
  thinkingMode: ThinkingMode;
  completedSubquestions: string[];
  carryOverFollowUpTasks: string[];
  store: PipelineStore;
  objectStore: ObjectStore;
  checkpoint: RunCheckpoint;
}): Promise<PlanPass> {
  if (!input.provider) {
    return PlanPassSchema.parse({
      subquestions: [],
      queries: [input.prompt],
      followUpTasks: input.carryOverFollowUpTasks,
    });
  }

  const sys: ChatMessage = {
    role: "system",
    content:
      "You are a research planner. Produce JSON only. Do not include markdown or extra commentary. " +
      "Most prompts should end after one planning pass. Use continuePlanning only if a fresh planning cycle is truly needed " +
      "to resolve a surprising gap or contradiction not covered by the current plan.",
  };
  const user: ChatMessage = {
    role: "user",
    content: JSON.stringify({
      task: "Generate a research plan with diversified web search queries.",
      prompt: input.prompt,
      completedSubquestions: input.completedSubquestions,
      carryOverFollowUpTasks: input.carryOverFollowUpTasks,
      outputSchema: {
        subquestions: ["..."],
        queries: ["..."],
        followUpTasks: ["..."],
        continuePlanning: false,
      },
      constraints: {
        maxSubquestions: 6,
        maxQueries: 8,
        maxFollowUpTasks: 10,
      },
    }),
  };

  const parsed = await callModelJsonLogged({
    runId: input.runId,
    userId: input.userId,
    phase: "plan",
    provider: input.provider,
    model: input.model,
    messages: [sys, user],
    schema: PlanPassSchema,
    reasoningEffort: input.thinkingMode,
    store: input.store,
    objectStore: input.objectStore,
    checkpoint: input.checkpoint,
    promptVersion: "plan.v1",
  });
  const queries = Array.from(new Set(parsed.queries.map((q) => q.trim()).filter(Boolean))).slice(
    0,
    8
  );
  return {
    subquestions: parsed.subquestions ?? [],
    queries: queries.length ? queries : [input.prompt],
    followUpTasks: parsed.followUpTasks ?? [],
    continuePlanning: parsed.continuePlanning ?? false,
  };
}

async function retrievePhase(input: {
  runId: string;
  userId: string;
  budgets: BudgetConfig;
  queries: string[];
  search: SearchAdapter;
  store: PipelineStore;
  maxSelectedUrls: number;
  seenUrls: Set<string>;
}): Promise<RetrievalOutput> {
  const qOut: RetrievalOutput["queries"] = [];
  const selectedUrls = new Set<string>();
  const seenUrls = input.seenUrls ?? new Set<string>();
  const maxSelectedUrls = Math.max(0, Math.floor(input.maxSelectedUrls));

  for (const q of input.queries) {
    if (selectedUrls.size >= maxSelectedUrls) break;
    await input.store.addRunEvent({
      runId: input.runId,
      level: "debug",
      phase: "retrieve",
      eventType: "search_query_started",
      message: `Searching web for query: "${q}"`,
      data: { query: q },
    });

    const results = await input.search.search(q, {
      maxResults: Math.max(1, input.budgets.maxSources),
    });
    input.store.addUsageDelta({ userId: input.userId, searchCalls: 1 }).catch(() => {});

    await input.store.addRunEvent({
      runId: input.runId,
      level: "debug",
      phase: "retrieve",
      eventType: "search_query_completed",
      message: `Search query completed: "${q}"`,
      data: { query: q, results: results.length },
    });

    qOut.push({
      query: q,
      results: results.map((r) => {
        const item: { url: string; title?: string; snippet?: string } = { url: r.url };
        if (r.title) item.title = r.title;
        if (r.snippet) item.snippet = r.snippet;
        return item;
      }),
    });
    for (const r of results) {
      const url = normalizeUrl(r.url);
      const isNew = !selectedUrls.has(url) && !seenUrls.has(url);
      if (!isNew) continue;
      selectedUrls.add(url);
      if (selectedUrls.size >= maxSelectedUrls) break;
      {
        await input.store.addRunEvent({
          runId: input.runId,
          level: "debug",
          phase: "retrieve",
          eventType: "search_result_candidate",
          message: `Found candidate source: ${url}`,
          data: {
            query: q,
            url,
            title: r.title ?? null,
            snippet: r.snippet ?? null,
          },
        });
      }
    }
  }

  return {
    queries: qOut,
    selectedUrls: Array.from(selectedUrls).slice(0, maxSelectedUrls),
  };
}

async function fetchPhase(input: {
  runId: string;
  userId: string;
  budgets: BudgetConfig;
  checkpoint: RunCheckpoint;
  store: PipelineStore;
  objectStore: ObjectStore;
  httpFetch: HttpFetchAdapter;
  onlySourceIds?: string[];
}): Promise<void> {
  const sources = await input.store.listSources(input.runId);
  const sourceIdAllowList =
    input.onlySourceIds && input.onlySourceIds.length > 0 ? new Set(input.onlySourceIds) : null;
  const eligibleSources = sourceIdAllowList ? sources.filter((s) => sourceIdAllowList.has(s.id)) : sources;
  const limit = pLimit(input.budgets.fetchConcurrency);

  await Promise.all(
    eligibleSources.map((s) =>
      limit(async () => {
        if (input.checkpoint.counters.fetches >= input.budgets.maxFetches) return;
        if (s.status !== "pending") return;

        await input.store.addRunEvent({
          runId: input.runId,
          level: "debug",
          phase: "fetch",
          eventType: "source_fetch_started",
          message: `Fetching ${s.url}`,
          data: { sourceId: s.id, url: s.url },
        });

        const res = await input.httpFetch.fetch(s.url);
        input.checkpoint.counters.fetches++;
        input.store.addUsageDelta({ userId: input.userId, fetches: 1 }).catch(() => {});

        if (!res.ok) {
          await input.store.addRunEvent({
            runId: input.runId,
            level: "warn",
            phase: "fetch",
            eventType: "source_fetch_failed",
            message: `Fetch failed: ${s.url}`,
            data: { sourceId: s.id, url: s.url, status: res.status, error: res.error },
          });
          await input.store.updateSource({
            sourceId: s.id,
            status: "failed",
            error: { error: res.error, status: res.status },
          });
          return;
        }

        const key = sourceRawBodyKey(input.runId, s.id);
        await input.objectStore.putBytes(key, res.body);
        await input.store.addRunEvent({
          runId: input.runId,
          level: "debug",
          phase: "fetch",
          eventType: "source_fetch_completed",
          message: `Fetched ${s.url}`,
          data: { sourceId: s.id, url: s.url, status: res.status },
        });
        await input.store.updateSource({
          sourceId: s.id,
          status: "fetched",
          finalUrl: res.url,
          httpStatus: res.status,
          contentType: res.contentType,
          fetchedAt: new Date(),
          rawBodyKey: key,
        });
      })
    )
  );

  await input.store.updateRun({ runId: input.runId, state: input.checkpoint });
}

async function extractPhase(input: {
  runId: string;
  userId: string;
  budgets: BudgetConfig;
  checkpoint: RunCheckpoint;
  store: PipelineStore;
  objectStore: ObjectStore;
  browser: BrowserRenderAdapter | undefined;
  onlySourceIds?: string[];
}): Promise<void> {
  const sources = await input.store.listSources(input.runId);
  const sourceIdAllowList =
    input.onlySourceIds && input.onlySourceIds.length > 0 ? new Set(input.onlySourceIds) : null;
  const eligibleSources = sourceIdAllowList ? sources.filter((s) => sourceIdAllowList.has(s.id)) : sources;
  const limit = pLimit(input.budgets.extractConcurrency);

  const shouldDebugCapture = input.checkpoint.debug.enabled;
  const serializeError = (error: unknown): string => {
    if (error instanceof Error) return error.message;
    if (error && typeof error === "object" && "message" in error) {
      return String((error as { message?: unknown }).message);
    }
    return String(error);
  };

  const serializeErrorName = (error: unknown): string => {
    if (error instanceof Error) return error.name;
    if (error && typeof error === "object" && "name" in error && typeof (error as { name?: unknown }).name === "string") {
      return (error as { name?: string }).name!;
    }
    return "Error";
  };

  const markSourceExtractFailed = async (
    source: (typeof eligibleSources)[number],
    details: {
      reason: string;
      errorName?: string;
      errorMessage?: string;
      errorType?: string | undefined;
    }
  ) => {
    await input.store.addRunEvent({
      runId: input.runId,
      level: "warn",
      phase: "extract",
      eventType: "source_extract_failed",
      message: `Extraction failed: ${source.url}`,
      data: {
        sourceId: source.id,
        url: source.url,
        errorName: details.errorName,
        errorMessage: details.errorMessage,
        errorType: details.errorType,
        reason: details.reason,
      },
    });
    await input.store.updateSource({
      sourceId: source.id,
      status: "failed",
      error: {
        reason: details.reason,
        name: details.errorName,
        message: details.errorMessage,
        type: details.errorType,
      },
    });
  };

  await Promise.all(
    eligibleSources.map((s) =>
      limit(async () => {
        if (s.extract_key) return;
        if (s.status !== "fetched" && s.status !== "rendered") return;

        await input.store.addRunEvent({
          runId: input.runId,
          level: "debug",
          phase: "extract",
          eventType: "source_extract_started",
          message: `Extracting evidence from ${s.url}`,
          data: { sourceId: s.id, url: s.url },
        });

        let evidence: ExtractedEvidence | null = null;
        let extractionFailureType: "stack_overflow" | undefined;
        if (s.render_text_key) {
          const rendered = await input.objectStore.getText(s.render_text_key);
          if (rendered)
            evidence = extractFromText(rendered, { title: s.title, publisher: s.publisher });
        } else if (s.raw_body_key) {
          const bytes = await input.objectStore.getBytes(s.raw_body_key);
          if (bytes) {
            const html = new TextDecoder().decode(bytes);
            try {
              evidence = extractFromHtml(html, { url: s.final_url ?? s.url });
            } catch (error) {
              const errorName = serializeErrorName(error);
              const errorMessage = serializeError(error);
              if (isExtractStackOverflowError(error)) {
                extractionFailureType = "stack_overflow";
                await input.store.addRunEvent({
                  runId: input.runId,
                  level: "warn",
                  phase: "extract",
                  eventType: "source_extract_fallback",
                  message: `Falling back to text extraction due stack overflow: ${s.url}`,
                  data: {
                    sourceId: s.id,
                    url: s.url,
                    errorName,
                    errorMessage,
                    errorType: "stack_overflow",
                  },
                });

                const fallbackEvidence = extractTextFromHtml(html, {
                  title: s.title,
                  publisher: s.publisher,
                });

                if (!fallbackEvidence || fallbackEvidence.contentText.length < 500) {
                  await markSourceExtractFailed(s, {
                    reason: "fallback_content_too_short",
                    errorName,
                    errorMessage,
                    errorType: extractionFailureType,
                  });
                  return;
                }

                evidence = fallbackEvidence;
                extractionFailureType = undefined;
              }

              await markSourceExtractFailed(s, {
                reason: "extraction_error",
                errorName,
                errorMessage,
                errorType: errorName,
              });
              return;
            }
          }
        }

        const tooShort = !evidence || evidence.contentText.length < 500;
        if (
          tooShort &&
          extractionFailureType !== "stack_overflow" &&
          input.browser &&
          input.checkpoint.counters.renders < input.budgets.maxBrowserRenders
        ) {
          const rendered = await input.browser.render(s.url, {
            captureHtml: shouldDebugCapture,
            captureTrace: shouldDebugCapture,
          });
          if (rendered.ok) {
            input.checkpoint.counters.renders++;
            input.store.addUsageDelta({ userId: input.userId, renders: 1 }).catch(() => {});

            const renderKey = sourceRenderedTextKey(input.runId, s.id);
            await input.objectStore.putText(renderKey, rendered.extractedText);
            await input.store.updateSource({
              sourceId: s.id,
              status: "rendered",
              renderTextKey: renderKey,
              finalUrl: rendered.finalUrl,
              title: rendered.title ?? s.title,
            });

            if (shouldDebugCapture && rendered.html) {
              const htmlKey = debugSourceRenderedHtmlKey(input.runId, s.id);
              await input.objectStore.putText(htmlKey, rendered.html);
              await input.store.updateSource({ sourceId: s.id, renderHtmlKey: htmlKey });
            }
            if (shouldDebugCapture && rendered.traceZip) {
              const traceKey = debugSourceTraceZipKey(input.runId, s.id);
              await input.objectStore.putBytes(traceKey, rendered.traceZip);
              await input.store.updateSource({ sourceId: s.id, renderTraceKey: traceKey });
            }

            evidence = extractFromText(rendered.extractedText, {
              title: rendered.title,
              publisher: s.publisher,
            });
          }
        }

        if (!evidence || evidence.contentText.trim().length === 0) {
          await markSourceExtractFailed(s, {
            reason: "empty_content",
            errorName: "extraction_failed",
            errorMessage: "no_content",
            errorType: extractionFailureType,
          });
          return;
        }

        const evidenceKey = sourceEvidenceKey(input.runId, s.id);
        await input.objectStore.putJson(evidenceKey, evidence);
        await input.store.addRunEvent({
          runId: input.runId,
          level: "debug",
          phase: "extract",
          eventType: "source_extract_completed",
          message: `Extraction completed: ${s.url}`,
          data: { sourceId: s.id, url: s.url },
        });
        await input.store.updateSource({
          sourceId: s.id,
          status: "extracted",
          extractKey: evidenceKey,
          title: evidence.metadata.title,
          publisher: evidence.metadata.publisher,
        });
      })
    )
  );

  await input.store.updateRun({ runId: input.runId, state: input.checkpoint });
}

async function loadLabeledSources(input: {
  runId: string;
  checkpoint: RunCheckpoint;
  store: PipelineStore;
  objectStore: ObjectStore;
}): Promise<LabeledSource[]> {
  const sources = await input.store.listSources(input.runId);
  const extracted = sources.filter((s) => Boolean(s.extract_key));
  const sourceLabels: Record<string, string> = { ...(input.checkpoint.sourceLabels ?? {}) };
  const usedLabelNumbers = new Set<number>();
  for (const label of Object.values(sourceLabels)) {
    const match = /^S(\d+)$/.exec(label);
    if (!match) continue;
    const value = Number.parseInt(match[1]!, 10);
    if (Number.isFinite(value) && value > 0) usedLabelNumbers.add(value);
  }
  let nextLabelNumber = usedLabelNumbers.size ? Math.max(...Array.from(usedLabelNumbers)) + 1 : 1;
  const ensureSourceLabel = (sourceId: string): string => {
    const existing = sourceLabels[sourceId];
    if (typeof existing === "string" && existing.trim()) return existing;
    while (usedLabelNumbers.has(nextLabelNumber)) nextLabelNumber += 1;
    const assigned = `S${nextLabelNumber}`;
    sourceLabels[sourceId] = assigned;
    usedLabelNumbers.add(nextLabelNumber);
    nextLabelNumber += 1;
    return assigned;
  };
  const toIso = (v: unknown): string => {
    if (typeof v === "string") return v;
    if (v instanceof Date) return v.toISOString();
    return "";
  };
  extracted.sort((a, b) => toIso(a.fetched_at).localeCompare(toIso(b.fetched_at)));

  const labeled: LabeledSource[] = [];
  for (const s of extracted) {
    const label = ensureSourceLabel(s.id);
    const ev = await input.objectStore.getJson<ExtractedEvidence>(
      sourceEvidenceKey(input.runId, s.id)
    );
    const quotes = (ev?.quotes ?? []).map((q, i) => ({ ...q, quoteId: `Q${i + 1}` }));
    const contentText = ev?.contentText;
    labeled.push({
      label,
      sourceId: s.id,
      url: s.final_url ?? s.url,
      title: s.title,
      publisher: s.publisher,
      ...(contentText !== undefined ? { contentText } : {}),
      fetchedAt: s.fetched_at ? toIso(s.fetched_at) : null,
      quotes,
    });
  }
  input.checkpoint.sourceLabels = sourceLabels;
  return labeled;
}

type SynthesisSourceBrief = {
  source: string;
  url: string;
  title: string | null;
  publisher: string | null;
  fullText?: string;
  quotes: Array<{
    quoteId: string;
    start: number;
    end: number;
    text: string;
  }>;
};

type SynthesisContextTrimResult = {
  sourceBriefs: SynthesisSourceBrief[];
  sourceAbstracts: SynthesisSourceAbstract[];
  criticalSourceContexts: Array<{ source: string; reason: string; excerpt: string }>;
  sourceCountBefore: number;
  sourceAbstractCountBefore: number;
  sourceAbstractCountAfter: number;
  sourceCountAfter: number;
  quoteCountBefore: number;
  quoteCountAfter: number;
  droppedSourceCount: number;
  droppedQuoteCount: number;
  truncatedQuoteCount: number;
  droppedAbstractCount: number;
  droppedCriticalContextCount: number;
  trimmed: boolean;
  inputTokensBefore: number;
  inputTokensAfter: number;
};

type SynthesisSourcePreTrimResult = {
  sourceBriefs: SynthesisSourceBrief[];
  sourceCountBefore: number;
  sourceCountAfter: number;
  quoteCountBefore: number;
  quoteCountAfter: number;
  droppedQuoteCount: number;
  dedupedQuoteCount: number;
  droppedSourceCount: number;
  filteredQuoteCount: number;
};

const SYNTHESIS_INPUT_TOKEN_RATIO = 4;
const MIN_QUOTE_TEXT_LENGTH = 40;
const SYNTHESIS_MIN_CLAIM_LENGTH = 56;
const SYNTHESIS_READABLE_RATIO_THRESHOLD = 0.88;
const SYNTHESIS_BAD_CHAR_THRESHOLD = 0.08;
const SYNTHESIS_PROMPT_STOPWORDS = new Set<string>([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "such",
  "their",
  "there",
  "about",
  "where",
  "which",
  "these",
  "those",
  "they",
  "them",
  "been",
  "have",
  "has",
  "its",
  "was",
  "were",
  "also",
  "then",
  "what",
  "when",
  "while",
]);

function estimateTokenCountFromJson(value: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(value).length / SYNTHESIS_INPUT_TOKEN_RATIO));
}

type SynthesisPromptTargets = {
  minKeyFindings: number;
  maxKeyFindings: number;
  minRecommendations: number;
  maxRecommendations: number;
  minSummaryWords: number;
};

function buildSynthesisPromptPayload(input: {
  prompt: string;
  citationPolicy: CitationPolicy;
  sources: SynthesisSourceBrief[];
  sourceAbstracts?: SynthesisSourceAbstract[];
  criticalSourceContexts?: Array<{ source: string; reason: string; excerpt: string }>;
  reviewFeedback?: SynthesisReviewFeedbackPayload;
  targets: SynthesisPromptTargets;
  previousSynthesis?: SynthesisOutput;
  refinementPass?: number;
  sourceCountBefore?: number;
  requireReviewIteration?: boolean;
}): unknown {
  const passSuffix =
    input.refinementPass && input.refinementPass > 0
      ? ` (refinement pass ${input.refinementPass})`
      : "";
  const maxFindings = input.targets.maxKeyFindings;
  const maxRecommendations = input.targets.maxRecommendations;
  const criticalContextBySource = new Map<string, string>();
  const criticalReasonBySource = new Map<string, string>();
  const sourceAbstractBySource = new Map<string, SynthesisSourceAbstract>();
  for (const abstract of input.sourceAbstracts ?? []) {
    sourceAbstractBySource.set(abstract.source, abstract);
  }

  for (const context of input.criticalSourceContexts ?? []) {
    criticalContextBySource.set(context.source, context.excerpt);
    if (context.reason) criticalReasonBySource.set(context.source, context.reason);
  }

  const promptSources = input.sources.map((source) => {
    const contextExcerpt = criticalContextBySource.get(source.source);
    const contextReason = criticalReasonBySource.get(source.source);
    const sourceAbstract = sourceAbstractBySource.get(source.source);
    return {
      source: source.source,
      url: source.url,
      title: source.title,
      publisher: source.publisher,
      quotes: source.quotes,
      ...(sourceAbstract
        ? {
            sourceAbstract: {
              methodology: sourceAbstract.methodology,
              temporalContext: sourceAbstract.temporalContext,
              dataTypes: sourceAbstract.dataTypes,
              stakeholderPosition: sourceAbstract.stakeholderPosition,
              representativeClaims: sourceAbstract.representativeClaims,
              keyConstraints: sourceAbstract.keyConstraints,
            },
          }
        : {}),
      ...(contextExcerpt
        ? {
            fullText: trimText(contextExcerpt, SYNTHESIS_MAX_CRITICAL_SOURCE_EXCERPT_CHARS),
            criticalSourceContext: {
              reason: contextReason ?? "Critical-source context selected for cross-source inference.",
              excerpt: trimText(contextExcerpt, SYNTHESIS_MAX_CRITICAL_SOURCE_EXCERPT_CHARS),
            },
          }
        : {}),
    };
  });

  return {
    prompt: input.prompt,
    citationPolicy: input.citationPolicy,
    sources: promptSources,
    sourceAbstracts: input.sourceAbstracts ?? [],
    criticalSourceContexts: input.criticalSourceContexts ?? [],
    targets: {
      minKeyFindings: input.targets.minKeyFindings,
      minRecommendations: input.targets.minRecommendations,
      maxRecommendations,
      maxKeyFindings: input.targets.maxKeyFindings,
      minSummaryWords: input.targets.minSummaryWords,
    },
    output: {
      summary: "...",
      sourceIndex: [{ source: "S1", reliabilityAssessment: "Use at least 2 high-quality sources." }],
      thematicSynthesis: [
        {
          theme: "Synthetic insight 1",
          observation: "Cross-source pattern is not visible in single-source narratives.",
          inference: "Inference chain connecting source evidence.",
          implication: "Decision-oriented implication for stakeholders.",
          citations: [{ source: "S1", quoteId: "Q1" }],
        },
      ],
      keyFindings: [
        {
          id: "F1",
          text: "A factual claim grounded in the provided sources.",
          citations: [{ source: "S1", quoteId: "Q1" }],
        },
      ],
      contradictions: ["..."],
      recommendations: ["..."],
      unknowns: ["..."],
      negativeSpace: {
        missingLinks: ["..."],
        unaskedQuestions: ["..."],
        temporalBlindspots: ["..."],
      },
      confidenceAppendix: [
        {
          type: "INFERRED",
          statement: "This conclusion requires linking assumptions from multiple source classes.",
          alternativeInterpretations: ["Alternative path may be supported by subset A only."],
          evidenceNotes: "Supported by overlapping evidence in multiple source families.",
        },
      ],
    },
    rules: [
      `Respond with a ${passSuffix} deep-research style adversarial synthesis for a rigorous evidence review.`,
      `Executive Summary must be a 3-bullet max, highest-level synthetic conclusions only; total length >= ${input.targets.minSummaryWords} words.`,
      "No Source Left Behind: every significant conclusion in the report must cite at least one source.",
      "Every major conclusion should include an evidence set that materially weakens if any one source in that set is removed.",
      "Prioritize findings that require multiple source families; avoid framing multi-source evidence as single-source evidence.",
      "Every keyFindings item must be supported by at least one citation with a quoteId.",
      "Use only the provided source labels (S1, S2, ...) and quoteIds (Q1, Q2, ...).",
      "Output JSON that includes: summary, sourceIndex, thematicSynthesis, keyFindings, negativeSpace, confidenceAppendix, unknowns, recommendations, contradictions.",
      "Every Theme must include evidence-based observation, inference with logic chain, and implication.",
      "Apply the Synthesis Test: if a finding could be reached from one source alone, downgrade it to recommendation evidence gap, not major synthesis.",
      "When available, reason with sourceAbstracts and criticalSourceContext to explain why each major finding is synthetic.",
      "Do not invent URLs, titles, publishers, or quotes.",
      `Target ${input.targets.minKeyFindings}-${maxFindings} key findings and ${input.targets.minRecommendations}-${maxRecommendations} recommendations.`,
      "Prioritize claims that are supported by multiple sources and make each finding distinct.",
      "If coverage gaps limit the requested output depth, explicitly capture those gaps in `unknowns` instead of over-compressing claims.",
      "Keep recommendations detailed and implementation-oriented.",
      "Favor synthesis across sources over single-source repetition and call out missing links, unasked assumptions, and temporal blindspots.",
      "Build findings that would materially weaken if one key source were removed.",
    ],
    ...(input.reviewFeedback
      ? {
          reviewFeedback: input.reviewFeedback,
        }
      : {}),
    ...(input.requireReviewIteration
      ? {
          reviewStatus: "previous draft received reviewer pushback; improve evidentiary boundaries and logic",
        }
      : {}),
    ...(input.previousSynthesis
      ? {
          previousSynthesis: {
            summary: input.previousSynthesis.summary,
            keyFindings: input.previousSynthesis.keyFindings,
            recommendations: input.previousSynthesis.recommendations ?? [],
            unknowns: input.previousSynthesis.unknowns,
            sourceCountBefore: input.sourceCountBefore,
          },
        }
      : {}),
    ...(input.refinementPass && input.refinementPass > 0
      ? {
          refinementInstructions: [
            "Extend, expand, and add materially new claims while retaining citation quality.",
            "Favor evidence not yet represented in prior key findings.",
          ],
        }
      : {}),
  };
}

function normalizeClaimText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .toLowerCase()
    .trim();
}

function buildPromptTermSet(prompt: string): Set<string> {
  return new Set(
    claimTokens(normalizeClaimText(prompt))
      .map((token) => token.toLowerCase())
      .filter((token) => !SYNTHESIS_PROMPT_STOPWORDS.has(token))
  );
}

function readableQuoteRatio(text: string): number {
  if (!text.length) return 0;
  let printableCount = 0;
  let badCharCount = 0;

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const printable =
      (code >= 0x20 && code <= 0x7e) || char === "\n" || char === "\r" || char === "\t";
    if (printable) printableCount++;
    if (char === "\uFFFD") badCharCount++;
  }

  const printableRatio = printableCount / text.length;
  const replacementRatio = badCharCount / text.length;
  if (replacementRatio > SYNTHESIS_BAD_CHAR_THRESHOLD) return 0;
  return printableRatio;
}

function isReadableQuote(text: string): boolean {
  return (
    text.length >= SYNTHESIS_MIN_CLAIM_LENGTH &&
    readableQuoteRatio(text) >= SYNTHESIS_READABLE_RATIO_THRESHOLD
  );
}

type ScoredSynthesisSourceBrief = SynthesisSourceBrief & {
  _sourceScore?: number;
};

function getSourceAuthoritySignal(url: string): number {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith(".gov") || host.endsWith(".mil")) return 1;
    if (host.endsWith(".edu")) return 0.9;
    if (host.endsWith(".org")) return 0.75;

    for (const hint of SYNTHESIS_OFFICIAL_DOMAIN_HINTS) {
      if (host.includes(hint)) return 0.6;
    }
    return 0.3;
  } catch {
    return 0.25;
  }
}

function scoreSourceForSynthesis(input: {
  source: SynthesisSourceBrief;
  sourceQuoteScores: Array<{ score: number }>;
}): number {
  const quotedScoreSum = input.sourceQuoteScores.reduce((sum, quote) => sum + quote.score, 0);
  const quotedScoreAvg =
    input.sourceQuoteScores.length > 0
      ? quotedScoreSum / input.sourceQuoteScores.length
      : 0;
  const authority = getSourceAuthoritySignal(input.source.url);
  const metadataScore =
    (input.source.title ? 0.12 : 0) + (input.source.publisher ? 0.08 : 0);
  const quoteQuantityScore = Math.min(
    1,
    input.sourceQuoteScores.length / SYNTHESIS_MAX_QUOTES_PER_SOURCE
  );
  return authority * 0.45 + quotedScoreAvg * 0.35 + metadataScore + quoteQuantityScore * 0.1;
}

function scoreClaimForPrompt(text: string, promptTerms: Set<string>): number {
  const normalized = normalizeClaimText(text);
  if (!normalized) return 0;
  const tokens = new Set(claimTokens(normalized).filter((token) => token.length >= 3));
  if (tokens.size < 4) return 0;

  let overlap = 0;
  for (const token of tokens) {
    if (promptTerms.has(token)) overlap++;
  }

  const overlapScore = overlap / Math.max(1, promptTerms.size);
  const densityScore = Math.min(1, tokens.size / 28);
  const lengthScore = Math.min(1, text.length / 260);
  return overlapScore * 2 + densityScore + lengthScore;
}

function claimTokens(text: string): string[] {
  return normalizeClaimText(text)
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

function claimsAreRedundant(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;

  const aTokens = claimTokens(a);
  const bTokens = claimTokens(b);
  if (aTokens.length === 0 || bTokens.length === 0) return false;

  const [shorter, longer] = aTokens.length <= bTokens.length ? [aTokens, bTokens] : [bTokens, aTokens];
  const longerSet = new Set(longer);
  let overlap = 0;
  for (const token of shorter) {
    if (longerSet.has(token)) overlap++;
  }
  return overlap / shorter.length >= CLAIM_SIMILARITY_RATIO;
}

function summarizeClaimText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= SYNTHESIS_MAX_CLAIM_LENGTH) return normalized;

  const clipped = normalized.slice(0, SYNTHESIS_MAX_CLAIM_LENGTH);
  const sentenceEnd = Math.max(
    clipped.lastIndexOf(". "),
    clipped.lastIndexOf("? "),
    clipped.lastIndexOf("! ")
  );
  if (sentenceEnd > 60) {
    return clipped.slice(0, sentenceEnd + 1).trim();
  }
  return `${clipped.trimEnd()}...`;
}

function summarizeSynthesisSources(input: {
  sourceBriefs: SynthesisSourceBrief[];
  prompt: string;
}): SynthesisSourcePreTrimResult {
  const promptTerms = buildPromptTermSet(input.prompt);
  const sourceCountBefore = input.sourceBriefs.length;
  const quoteCountBefore = input.sourceBriefs.reduce((sum, source) => sum + source.quotes.length, 0);
  const seenClaims: string[] = [];
  const scoredSourceBriefs: ScoredSynthesisSourceBrief[] = [];
  let droppedQuoteCount = 0;
  let dedupedQuoteCount = 0;
  let droppedSourceCount = 0;
  let filteredQuoteCount = 0;

  for (const source of cloneSourceBriefs(input.sourceBriefs)) {
    const candidates = source.quotes
      .map((quote) => ({
        ...quote,
        normalizedText: normalizeClaimText(quote.text),
        score: scoreClaimForPrompt(quote.text, promptTerms),
      }))
      .filter((quote) => quote.normalizedText.length > 0);

    const readableCandidates = candidates.filter((quote) => isReadableQuote(quote.text));
    filteredQuoteCount += candidates.length - readableCandidates.length;
    const sortedCandidates = (readableCandidates.length > 0 ? readableCandidates : candidates).sort(
      (a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        return b.text.length - a.text.length;
      }
    );

    const keptQuotes: typeof source.quotes = [];
    const hasStrongMatch = sortedCandidates.some(
      (candidate) => candidate.score >= SYNTHESIS_MIN_PROMPT_TERM_SCORE
    );
    for (const candidate of sortedCandidates) {
      if (hasStrongMatch && candidate.score < SYNTHESIS_MIN_PROMPT_TERM_SCORE) {
        droppedQuoteCount++;
        continue;
      }
      if (keptQuotes.length >= SYNTHESIS_MAX_QUOTES_PER_SOURCE) {
        droppedQuoteCount++;
        continue;
      }

      const duplicate = seenClaims.some((existing) =>
        claimsAreRedundant(candidate.normalizedText, existing)
      );
      if (duplicate) {
        droppedQuoteCount++;
        dedupedQuoteCount++;
        continue;
      }

      keptQuotes.push({
        quoteId: candidate.quoteId,
        start: candidate.start,
        end: candidate.end,
        text: summarizeClaimText(candidate.text),
      });
      if (candidate.normalizedText.length > 0) {
        seenClaims.push(candidate.normalizedText);
      }
    }

    if (keptQuotes.length === 0 && sortedCandidates.length > 0) {
      const fallback = sortedCandidates[0]!;
      keptQuotes.push({
        quoteId: fallback.quoteId,
        start: fallback.start,
        end: fallback.end,
        text: summarizeClaimText(fallback.text),
      });
      if (fallback.normalizedText.length > 0 && !seenClaims.includes(fallback.normalizedText)) {
        seenClaims.push(fallback.normalizedText);
      }
    }

    if (keptQuotes.length > 0) {
      source.quotes = keptQuotes;
      scoredSourceBriefs.push({
        ...source,
        _sourceScore: scoreSourceForSynthesis({
          source,
          sourceQuoteScores: keptQuotes.map((q) => ({
            score: scoreClaimForPrompt(
              candidates.find((candidate) => candidate.quoteId === q.quoteId)?.text ?? "",
              promptTerms,
            ),
          })),
        }),
      });
    } else {
      droppedSourceCount += 1;
    }
  }

  const sourceBriefs = scoredSourceBriefs
    .sort((a, b) => (b._sourceScore ?? 0) - (a._sourceScore ?? 0))
    .slice(0, SYNTHESIS_MAX_SOURCES_FOR_MODEL)
    .map((s) => {
      const { _sourceScore, ...rest } = s;
      void _sourceScore;
      return rest;
    });

  return {
    sourceBriefs,
    sourceCountBefore,
    sourceCountAfter: sourceBriefs.length,
    quoteCountBefore,
    quoteCountAfter: sourceBriefs.reduce((sum, source) => sum + source.quotes.length, 0),
    droppedQuoteCount,
    dedupedQuoteCount,
    droppedSourceCount,
    filteredQuoteCount,
  };
}

function deriveSynthesisTargets(input: {
  sourceCount: number;
  quoteCount: number;
}): SynthesisPromptTargets {
  const sourceCount = Math.max(0, input.sourceCount);
  const quoteCount = Math.max(0, input.quoteCount);

  const minKeyFindingsRaw =
    sourceCount <= 2
      ? 1
      : sourceCount <= 4
        ? 2
        : sourceCount <= 7
          ? 3
          : sourceCount <= 12
            ? 4
            : Math.min(10, Math.max(5, Math.floor(sourceCount * 0.5)));

  const minKeyFindings = Math.min(minKeyFindingsRaw, Math.max(1, Math.ceil(quoteCount / 2)));
  const maxKeyFindings = Math.min(14, Math.max(minKeyFindings, minKeyFindings + 4));

  const minRecommendations =
    sourceCount <= 2
      ? 1
      : sourceCount <= 4
        ? 1
        : sourceCount <= 7
          ? 2
          : sourceCount <= 12
            ? 3
            : Math.min(8, Math.max(4, Math.floor(minKeyFindings * 0.75)));

  const maxRecommendations = Math.min(16, minRecommendations + 4);

  const minSummaryWords = deriveMinSummaryWords(sourceCount);

  return {
    minKeyFindings,
    maxKeyFindings,
    minRecommendations,
    maxRecommendations,
    minSummaryWords,
  };
}

function deriveMinSummaryWords(sourceCountRaw: number): number {
  const sourceCount = Math.max(0, sourceCountRaw);
  if (sourceCount <= 1) return 2;
  if (sourceCount <= 2) return 4;
  if (sourceCount <= 4) return 60;
  if (sourceCount <= 8) return 120;
  if (sourceCount <= 12) return 200;
  return SYNTHESIS_TARGET_MIN_SUMMARY_WORDS;
}

type SynthesisOutputSufficiency = {
  sufficient: boolean;
  summaryWordCount: number;
  findingCount: number;
  recommendationCount: number;
  failedChecks: string[];
  shortfalls: {
    summaryWords: number;
    findings: number;
    recommendations: number;
  };
  advanced?: {
    sourceCount: number;
    crossSourceFindings: number;
    minimumCrossSourceFindings: number;
    requiredCrossSourceFindings: number;
    requiredSourceCoverage: number;
    sourceCoverage: number;
    sourceIndexLength: number;
    thematicSynthesisLength: number;
    negativeSpaceCount: number;
    confidenceAppendixLength: number;
    checks: {
      crossSourceSynthesis: boolean;
      crossSourceDiversity: boolean;
      broadSourceCoverage: boolean;
      analyticScaffolding: boolean;
      synthesisPressure: boolean;
    };
    analyticScaffoldingMissing: string[];
  };
};

function evaluateSynthesisOutputSufficiency(input: {
  output: SynthesisOutput;
  targets: SynthesisPromptTargets;
  sourceCount: number;
}): SynthesisOutputSufficiency {
  const recommendations = input.output.recommendations ?? [];
  const summaryWordCount = input.output.summary.split(/\s+/).filter(Boolean).length;
  const findingCount = input.output.keyFindings.length;
  const recommendationCount = recommendations.length;

  const shortfalls = {
    summaryWords: Math.max(0, input.targets.minSummaryWords - summaryWordCount),
    findings: Math.max(0, input.targets.minKeyFindings - findingCount),
    recommendations: Math.max(0, input.targets.minRecommendations - recommendationCount),
  };
  const failedChecks: string[] = [];
  if (shortfalls.findings > 0) failedChecks.push("min_key_findings");
  if (shortfalls.recommendations > 0) failedChecks.push("min_recommendations");
  if (shortfalls.summaryWords > 0) failedChecks.push("min_summary_words");

  const baseSufficient = failedChecks.length === 0;
  if (!baseSufficient) {
    return {
      sufficient: false,
      summaryWordCount,
      findingCount,
      recommendationCount,
      failedChecks,
      shortfalls,
    };
  }

  if (input.sourceCount <= 2) {
    return {
      sufficient: true,
      summaryWordCount,
      findingCount,
      recommendationCount,
      failedChecks,
      shortfalls,
    };
  }

  const findingSourceCounts = input.output.keyFindings.map(
    (f) => new Set((f.citations ?? []).map((c) => c.source).filter(Boolean)).size
  );
  const crossSourceFindings = findingSourceCounts.filter((count) => count >= 2).length;
  const minimumCrossSourceFindings =
    input.sourceCount >= 4
      ? Math.max(
          1,
          Math.min(
            3,
            Math.ceil(Math.min(input.targets.minKeyFindings, input.output.keyFindings.length) * 0.3)
          )
        )
      : 0;
  const hasCrossSourceSynthesis = crossSourceFindings >= minimumCrossSourceFindings;
  const sourceCoverage = new Set(input.output.keyFindings.flatMap((finding) =>
    (finding.citations ?? []).map((citation) => citation.source).filter(Boolean)
  )).size;
  const sourceIndexLength = input.output.sourceIndex?.length ?? 0;
  const thematicSynthesisLength = input.output.thematicSynthesis?.length ?? 0;
  const negativeSpace = input.output.negativeSpace
    ? (input.output.negativeSpace.missingLinks.length +
      input.output.negativeSpace.unaskedQuestions.length +
      input.output.negativeSpace.temporalBlindspots.length)
    : 0;
  const confidenceAppendixLength = input.output.confidenceAppendix?.length ?? 0;
  const requiredCrossSourceFindings =
    input.sourceCount >= 4
      ? Math.max(
          1,
          Math.min(4, Math.min(input.sourceCount, Math.ceil(input.targets.minKeyFindings * 0.35)))
        )
      : 0;
  const requiredSourceCoverage =
    input.sourceCount <= 2
      ? 1
      : Math.min(input.sourceCount, Math.max(2, Math.ceil(input.sourceCount * 0.2)));
  const synthesisPressure = crossSourceFindings >= 1;
  const hasCrossSourceDiversity = crossSourceFindings >= requiredCrossSourceFindings;
  const hasBroadSourceCoverage = sourceCoverage >= requiredSourceCoverage;
  if (!hasCrossSourceSynthesis) failedChecks.push("cross_source_synthesis");
  if (!hasCrossSourceDiversity) failedChecks.push("cross_source_diversity");
  if (!hasBroadSourceCoverage) failedChecks.push("broad_source_coverage");
  const hasAnalyticScaffolding =
    input.sourceCount < 4 ||
    (sourceIndexLength >= SYNTHESIS_MIN_SOURCE_INDEX_ENTRIES &&
      thematicSynthesisLength >= 1 &&
      negativeSpace >= 1 &&
      confidenceAppendixLength >= 1);

  const analyticScaffoldingMissing: string[] = [];
  if (input.sourceCount >= 4) {
    if (sourceIndexLength < SYNTHESIS_MIN_SOURCE_INDEX_ENTRIES) analyticScaffoldingMissing.push("sourceIndex");
    if (thematicSynthesisLength < 1) analyticScaffoldingMissing.push("thematicSynthesis");
    if (negativeSpace < 1) analyticScaffoldingMissing.push("negativeSpace");
    if (confidenceAppendixLength < 1) analyticScaffoldingMissing.push("confidenceAppendix");
  }

  const hasSynthesisPressure = input.sourceCount < 4 || synthesisPressure;
  if (!hasAnalyticScaffolding) failedChecks.push("analytic_scaffolding");
  if (!hasSynthesisPressure) failedChecks.push("synthesis_pressure");

  const sufficient =
    hasCrossSourceSynthesis &&
    hasCrossSourceDiversity &&
    hasBroadSourceCoverage &&
    hasAnalyticScaffolding &&
    hasSynthesisPressure;

  return {
    sufficient,
    summaryWordCount,
    findingCount,
    recommendationCount,
    failedChecks,
    shortfalls,
    advanced: {
      sourceCount: input.sourceCount,
      crossSourceFindings,
      minimumCrossSourceFindings,
      requiredCrossSourceFindings,
      requiredSourceCoverage,
      sourceCoverage,
      sourceIndexLength,
      thematicSynthesisLength,
      negativeSpaceCount: negativeSpace,
      confidenceAppendixLength,
      checks: {
        crossSourceSynthesis: hasCrossSourceSynthesis,
        crossSourceDiversity: hasCrossSourceDiversity,
        broadSourceCoverage: hasBroadSourceCoverage,
        analyticScaffolding: hasAnalyticScaffolding,
        synthesisPressure: hasSynthesisPressure,
      },
      analyticScaffoldingMissing,
    },
  };
}

function cloneSourceBriefs(sourceBriefs: SynthesisSourceBrief[]): SynthesisSourceBrief[] {
  return sourceBriefs.map((source) => ({
    source: source.source,
    url: source.url,
    title: source.title,
    publisher: source.publisher,
    ...(source.fullText !== undefined ? { fullText: source.fullText } : {}),
    quotes: source.quotes.map((quote) => ({
      quoteId: quote.quoteId,
      start: quote.start,
      end: quote.end,
      text: quote.text,
    })),
  }));
}

type SourceAbstractLike = {
  source: string;
  methodology: string;
  temporalContext: string;
  stakeholderPosition: string;
  dataTypes?: string[] | undefined;
  representativeClaims?: string[] | undefined;
  keyConstraints?: string[] | undefined;
};

function normalizeSourceAbstract(input: SourceAbstractLike): SynthesisSourceAbstract {
  return {
    source: input.source,
    methodology: input.methodology,
    temporalContext: input.temporalContext,
    dataTypes: input.dataTypes ?? [],
    stakeholderPosition: input.stakeholderPosition,
    representativeClaims: input.representativeClaims ?? [],
    keyConstraints: input.keyConstraints ?? [],
  };
}

function trimSynthesisContextForBudget(input: {
  maxInputTokens: number;
  prompt: string;
  citationPolicy: CitationPolicy;
  sourceBriefs: SynthesisSourceBrief[];
  sourceAbstracts: SynthesisSourceAbstract[];
  criticalSourceContexts: Array<{ source: string; reason: string; excerpt: string }>;
  targets: SynthesisPromptTargets;
}): SynthesisContextTrimResult {
  const sourceCountBefore = input.sourceBriefs.length;
  const quoteCountBefore = input.sourceBriefs.reduce((sum, source) => sum + source.quotes.length, 0);
  const working = cloneSourceBriefs(input.sourceBriefs);
  let workingAbstracts = [...input.sourceAbstracts];
  let workingCriticalSourceContexts = [...input.criticalSourceContexts];

  const measure = (
    sources: SynthesisSourceBrief[],
    sourceAbstracts: SynthesisSourceAbstract[],
    criticalSourceContexts: Array<{ source: string; reason: string; excerpt: string }>
  ) =>
    estimateTokenCountFromJson(
      buildSynthesisPromptPayload({
        ...input,
        sources,
        sourceAbstracts,
        criticalSourceContexts,
        targets: input.targets,
      })
    );
  let before = measure(working, workingAbstracts, workingCriticalSourceContexts);

  const result: SynthesisContextTrimResult = {
    sourceBriefs: working,
    sourceAbstracts: workingAbstracts,
    criticalSourceContexts: workingCriticalSourceContexts,
    sourceCountBefore,
    sourceAbstractCountBefore: input.sourceAbstracts.length,
    sourceAbstractCountAfter: input.sourceAbstracts.length,
    sourceCountAfter: sourceCountBefore,
    quoteCountBefore,
    quoteCountAfter: quoteCountBefore,
    droppedSourceCount: 0,
    droppedQuoteCount: 0,
    truncatedQuoteCount: 0,
    droppedAbstractCount: 0,
    droppedCriticalContextCount: 0,
    trimmed: false,
    inputTokensBefore: before,
    inputTokensAfter: before,
  };

  if (before <= input.maxInputTokens) {
    return result;
  }

  result.trimmed = true;

  // Step 1: reduce each source to one quote if possible before heavier trimming.
  for (const source of working) {
    while (source.quotes.length > 1 && before > input.maxInputTokens) {
      source.quotes.pop();
      result.droppedQuoteCount++;
      result.quoteCountAfter--;
      before = measure(working, workingAbstracts, workingCriticalSourceContexts);
      result.inputTokensAfter = before;
      if (before <= input.maxInputTokens) return { ...result, sourceBriefs: working };
    }
  }

  const quoteCountCurrent = () => working.reduce((sum, source) => sum + source.quotes.length, 0);

  // Step 2: trim quote text lengths with a bounded binary search.
  let maxTextLen = 0;
  for (const source of working) {
    for (const quote of source.quotes) {
      maxTextLen = Math.max(maxTextLen, quote.text.length);
    }
  }
  if (maxTextLen > MIN_QUOTE_TEXT_LENGTH && quoteCountCurrent() > 0) {
    let lo = MIN_QUOTE_TEXT_LENGTH;
    let hi = maxTextLen;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = cloneSourceBriefs(working);
      for (const source of candidate) {
        for (const quote of source.quotes) {
          if (quote.text.length > mid) {
            quote.text = quote.text.slice(0, mid);
          }
        }
      }
      const candidateTokens = measure(candidate, workingAbstracts, workingCriticalSourceContexts);
      if (candidateTokens <= input.maxInputTokens) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }

    const finalLimit = lo;
    for (const source of working) {
      for (const quote of source.quotes) {
        if (quote.text.length > finalLimit) {
          quote.text = quote.text.slice(0, finalLimit);
          result.truncatedQuoteCount++;
          result.inputTokensAfter = before;
        }
      }
    }
    before = measure(working, workingAbstracts, workingCriticalSourceContexts);
    result.inputTokensAfter = before;
    result.quoteCountAfter = quoteCountCurrent();
  }

  // Step 3: drop entire sources from the end if still over budget.
  while (before > input.maxInputTokens && working.length > 1) {
    const dropped = working.pop();
    if (!dropped) break;
    result.droppedSourceCount++;
    result.sourceCountAfter--;
    result.droppedQuoteCount += dropped.quotes.length;
    result.quoteCountAfter -= dropped.quotes.length;
    before = measure(working, workingAbstracts, workingCriticalSourceContexts);
    result.inputTokensAfter = before;
  }

  // Step 4: drop non-critical source context snippets, since they are high-cost and supportive only.
  while (before > input.maxInputTokens && workingCriticalSourceContexts.length > 1) {
    workingCriticalSourceContexts.pop();
    result.droppedCriticalContextCount++;
    result.inputTokensAfter = before = measure(working, workingAbstracts, workingCriticalSourceContexts);
  }

  // Step 5: shorten source context excerpts and abstracts before dropping them.
  if (before > input.maxInputTokens && workingCriticalSourceContexts.length > 0) {
    workingCriticalSourceContexts = workingCriticalSourceContexts.map((context) => ({
      ...context,
      excerpt:
        context.excerpt.length > SYNTHESIS_MAX_ABSTRACT_TEXT_LENGTH
          ? context.excerpt.slice(0, SYNTHESIS_MAX_ABSTRACT_TEXT_LENGTH)
          : context.excerpt,
    }));
    before = measure(working, workingAbstracts, workingCriticalSourceContexts);
    result.inputTokensAfter = before;
  }

  while (before > input.maxInputTokens && workingAbstracts.length > 0) {
    workingAbstracts = workingAbstracts.slice(0, Math.max(0, workingAbstracts.length - 1));
    result.droppedAbstractCount++;
    result.sourceAbstractCountAfter = workingAbstracts.length;
    result.inputTokensAfter = before = measure(working, workingAbstracts, workingCriticalSourceContexts);
  }

  if (result.quoteCountAfter < 0) result.quoteCountAfter = 0;
  return {
    ...result,
    sourceBriefs: working,
    sourceAbstracts: workingAbstracts,
    sourceAbstractCountAfter: workingAbstracts.length,
    criticalSourceContexts: workingCriticalSourceContexts,
    sourceCountAfter: result.sourceCountAfter,
    quoteCountAfter: result.quoteCountAfter,
  };
}

function trimText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(120, maxChars - 3)).trimEnd()}...`;
}

function buildSourceAbstractFallback(source: SynthesisSourceBrief): SynthesisSourceAbstract {
  const representativeClaims = source.quotes.map((q) => summarizeClaimText(q.text));
  const dataTypeHint = source.quotes.length ? "descriptive" : "unspecified";
  return {
    source: source.source,
    methodology: "Methodology details were not fully extractable from the source payload.",
    temporalContext: "Not specified",
    dataTypes: [dataTypeHint],
    stakeholderPosition: "Source role inferred from extracted text.",
    representativeClaims: representativeClaims.slice(0, 3),
    keyConstraints: ["No clear method section parsed"],
  };
}

function selectCriticalSourceContexts(input: {
  sourceBriefs: SynthesisSourceBrief[];
}): Array<{ source: string; reason: string; excerpt: string }> {
  const ranked = [...input.sourceBriefs].sort(
    (a, b) => {
      const quoteDelta = b.quotes.length - a.quotes.length;
      if (quoteDelta !== 0) return quoteDelta;
      const aText = (a.fullText ?? "").length;
      const bText = (b.fullText ?? "").length;
      return bText - aText;
    }
  );
  const selected = ranked.slice(0, Math.min(SYNTHESIS_MAX_CRITICAL_SOURCE_CONTEXTS, ranked.length));
  return selected.map((sourceBrief) => {
    const text = sourceBrief.fullText?.trim()
      ? sourceBrief.fullText
      : sourceBrief.quotes.map((q) => q.text).join(" ");
    return {
      source: sourceBrief.source,
      reason: `High-coverage source used to anchor cross-source inference (${sourceBrief.quotes.length} cited claims).`,
      excerpt: trimText(text, SYNTHESIS_MAX_CRITICAL_SOURCE_EXCERPT_CHARS),
    };
  });
}

function buildSourceAbstractsPayload(input: {
  prompt: string;
  citationPolicy: CitationPolicy;
  sourceBriefs: SynthesisSourceBrief[];
}): unknown {
  const sourceSummaries = input.sourceBriefs.map((sourceBrief) => {
    const fullTextContext = trimText(sourceBrief.fullText ?? "", 2000);
    return {
      source: sourceBrief.source,
      url: sourceBrief.url,
      title: sourceBrief.title,
      publisher: sourceBrief.publisher,
      methodologicalCue: fullTextContext
        ? fullTextContext.slice(0, 220)
        : "Full text not yet available in structured metadata.",
      constraints:
        sourceBrief.quotes.length < 2
          ? "Fewer direct excerpts; require cross-source validation."
          : "Evidence present across multiple quote regions.",
      dataQuality: sourceBrief.quotes.length >= 2 ? "Cross-validated excerpt coverage" : "Single-cluster evidence",
      quoteSamples: sourceBrief.quotes.slice(0, 3).map((q) => summarizeClaimText(q.text)),
      sourceContext: fullTextContext,
      quoteCount: sourceBrief.quotes.length,
    };
  });

  return {
    prompt: input.prompt,
    citationPolicy: input.citationPolicy,
    sources: sourceSummaries,
  };
}

async function buildSourceAbstracts(input: {
  runId: string;
  userId: string;
  prompt: string;
  sources: SynthesisSourceBrief[];
  citationPolicy: CitationPolicy;
  provider: ModelProvider;
  model: string;
  thinkingMode: ThinkingMode;
  store: PipelineStore;
  objectStore: ObjectStore;
  checkpoint: RunCheckpoint;
  requestedSourceLimit: number;
}): Promise<{
  sourceAbstracts: SynthesisSourceAbstract[];
  criticalSourceContexts: Array<{ source: string; reason: string; excerpt: string }>;
}> {
  const sourceSubstr = input.sources.map((sourceBrief) => sourceBrief.source);
  let parsed: z.infer<typeof SYNTHESIS_SOURCE_ABSTRACTS_OUTPUT_SCHEMA> | null = null;
  let fallbackError: { name: string; message: string } | null = null;
  try {
    parsed = await callModelJsonLogged({
      runId: input.runId,
      userId: input.userId,
      phase: "synthesize",
      persona: "synthesis-source-compression",
      synthesisPurpose: "source-abstracts",
      provider: input.provider,
      model: input.model,
      messages: [
        {
          role: "system",
          content: SYNTHESIS_SOURCE_ABSTRACT_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: JSON.stringify(
            buildSourceAbstractsPayload({
              prompt: input.prompt,
              citationPolicy: input.citationPolicy,
              sourceBriefs: input.sources,
            })
          ),
        },
      ],
      schema: SYNTHESIS_SOURCE_ABSTRACTS_OUTPUT_SCHEMA,
      maxTokens: 2_000,
      reasoningEffort: input.thinkingMode,
      store: input.store,
      objectStore: input.objectStore,
      checkpoint: input.checkpoint,
      promptVersion: "synthesize.source-abstracts.v1",
    });
  } catch (error) {
    fallbackError =
      error instanceof Error ? { name: error.name, message: error.message } : { name: "UnknownError", message: String(error) };
  }

  const bySource = new Map<string, SynthesisSourceAbstract>();
  const normalizedAbstracts = (parsed?.sourceAbstracts ?? []).map((abstract) => normalizeSourceAbstract(abstract));
  for (const abstract of normalizedAbstracts) {
    bySource.set(abstract.source, abstract);
  }

  const sourceAbstracts = sourceSubstr
    .map((label) =>
      bySource.get(label) ?? buildSourceAbstractFallback(input.sources.find((s) => s.source === label)!)
    )
    .filter(Boolean)
    .slice(0, input.requestedSourceLimit);

  if (fallbackError) {
    await input.store
      .addRunEvent({
        runId: input.runId,
        level: "warn",
        phase: "synthesize",
        eventType: "synthesis_source_abstracts_fallback",
        message: "Source abstract generation failed; using deterministic fallback summaries",
        data: {
          requestedAbstracts: input.sources.length,
          producedAbstracts: sourceAbstracts.length,
          errorName: fallbackError.name,
          errorMessage: fallbackError.message,
        },
      })
      .catch(() => {});
  } else {
    await input.store
      .addRunEvent({
        runId: input.runId,
        level: "info",
        phase: "synthesize",
        eventType: "synthesis_source_abstracts_created",
        message: "Source abstracts generated for synthesis compression step",
        data: {
          requestedAbstracts: input.sources.length,
          producedAbstracts: sourceAbstracts.length,
        },
      })
      .catch(() => {});
  }

  return {
    sourceAbstracts,
    criticalSourceContexts: selectCriticalSourceContexts({
      sourceBriefs: input.sources,
    }),
  };
}

async function reviewSynthesisDraft(input: {
  runId: string;
  userId: string;
  prompt: string;
  sources: SynthesisSourceBrief[];
  sourceAbstracts?: SynthesisSourceAbstract[];
  synthesis: SynthesisOutput;
  provider: ModelProvider;
  model: string;
  thinkingMode: ThinkingMode;
  store: PipelineStore;
  objectStore: ObjectStore;
  checkpoint: RunCheckpoint;
}): Promise<SynthesisReviewOutput> {
  const summaryOfOutput = {
    summary: input.synthesis.summary,
    keyFindings: input.synthesis.keyFindings.map((item) => ({
      id: item.id,
      text: item.text,
      citations: item.citations,
    })),
    recommendations: input.synthesis.recommendations ?? [],
    unknowns: input.synthesis.unknowns,
  };

  const sourceAbstractBySource = new Map<string, SynthesisSourceAbstract>();
  for (const abstract of input.sourceAbstracts ?? []) {
    sourceAbstractBySource.set(abstract.source, normalizeSourceAbstract(abstract));
  }

  const review = await callModelJsonLogged({
      runId: input.runId,
      userId: input.userId,
      phase: "synthesize",
      persona: "synthesis-review",
      synthesisPurpose: "review",
      provider: input.provider,
    model: input.model,
      messages: [
        {
          role: "system",
          content: SYNTHESIS_SYSTEM_REVIEW_PROMPT_WITH_SCHEMA,
        },
      {
        role: "user",
        content: JSON.stringify({
          prompt: input.prompt,
          sources: input.sources.map((s) => {
            const sourceAbstract = sourceAbstractBySource.get(s.source);
            return {
              source: s.source,
              sampleClaims: s.quotes.slice(0, 3),
              abstract: sourceAbstract
                ? {
                    methodology: sourceAbstract.methodology,
                    temporalContext: sourceAbstract.temporalContext,
                    dataTypes: sourceAbstract.dataTypes,
                    stakeholderPosition: sourceAbstract.stakeholderPosition,
                    representativeClaims: sourceAbstract.representativeClaims,
                    keyConstraints: sourceAbstract.keyConstraints,
                  }
                : undefined,
            };
          }),
          draft: summaryOfOutput,
          reviewRequest:
            "Attack the report sentence-by-sentence: mark conclusions that exceed source evidence, point out missing evidence, and return concrete revisions.",
        }),
      },
    ],
    schema: SYNTHESIS_REVIEW_SCHEMA,
    maxTokens: 5_000,
    reasoningEffort: input.thinkingMode,
    store: input.store,
    objectStore: input.objectStore,
    checkpoint: input.checkpoint,
    promptVersion: "synthesize.review.v1",
  });
  return {
    verdict: review.verdict,
    unsupportedConclusions: review.unsupportedConclusions ?? [],
    missingEvidence: review.missingEvidence ?? [],
    requestedRevisions: review.requestedRevisions ?? [],
    confidenceRisk: review.confidenceRisk,
  };
}

async function synthesizePhase(input: {
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
}): Promise<SynthesisOutput> {
  if (!input.provider) {
    const findings = input.sources.slice(0, 5).map((s, i) => {
      const q = s.quotes[0];
      return {
        id: `F${i + 1}`,
        text: q ? q.text : `Finding based on ${s.url}`,
        citations: q ? [{ source: s.label, quoteId: q.quoteId }] : [{ source: s.label }],
      };
    });
    return SynthesisOutputSchema.parse({
      summary: `Best-effort synthesis from ${input.sources.length} sources.`,
      keyFindings: findings.length
        ? findings
        : [{ id: "F1", text: "Insufficient sources.", citations: [] }],
      unknowns: ["This run used deterministic synthesis (no model provider configured)."],
    });
  }

  const sourceBriefs: SynthesisSourceBrief[] = input.sources.map((s) => ({
    source: s.label,
    url: s.url,
    title: s.title,
    publisher: s.publisher,
    ...(s.contentText !== undefined ? { fullText: s.contentText } : {}),
    quotes: s.quotes.map((q) => ({ quoteId: q.quoteId, start: q.start, end: q.end, text: q.text })),
  }));
  const preTrim = summarizeSynthesisSources({ sourceBriefs, prompt: input.prompt });

  if (preTrim.droppedQuoteCount > 0) {
    input.store
      .addRunEvent({
        runId: input.runId,
        level: "info",
        phase: "synthesize",
      eventType: "synthesis_source_compaction",
      message: "Synthesis source claims were compacted and deduplicated before budget trim",
      data: {
        sourceCountBefore: preTrim.sourceCountBefore,
        sourceCountAfter: preTrim.sourceCountAfter,
        quoteCountBefore: preTrim.quoteCountBefore,
        quoteCountAfter: preTrim.quoteCountAfter,
        droppedQuotes: preTrim.droppedQuoteCount,
        droppedSources: preTrim.droppedSourceCount,
        filteredQuotes: preTrim.filteredQuoteCount,
        dedupedQuotes: preTrim.dedupedQuoteCount,
      },
    })
      .catch(() => {});
  }

  const targets = deriveSynthesisTargets({
    sourceCount: preTrim.sourceCountAfter,
    quoteCount: preTrim.quoteCountAfter,
  });
  // Keep the summary depth target based on the total available evidence, even if we cap sources
  // passed to the model for cost/latency reasons.
  const summarySourceCount = Math.max(0, preTrim.sourceCountBefore - preTrim.droppedSourceCount);
  targets.minSummaryWords = deriveMinSummaryWords(summarySourceCount);
  const sourceLabelsForPrompt = input.sources.length;
  const sourceCountCap = preTrim.sourceCountAfter;
  const quoteCountCap = preTrim.quoteCountAfter;
  const shouldRunAbstractPass =
    sourceCountCap >= 2 &&
    (sourceCountCap > SYNTHESIS_SOURCE_ABSTRACT_TRIGGER_SOURCE_COUNT ||
      estimateTokenCountFromJson(
        buildSynthesisPromptPayload({
          prompt: input.prompt,
          citationPolicy: input.citationPolicy,
          sources: preTrim.sourceBriefs,
          targets,
        })
      ) >
        Math.max(SYNTHESIS_MIN_QUOTE_TEXT_LENGTH, input.maxInputTokens * 0.9));
  const reviewEnabled =
    input.reviewPolicy !== "skip" && sourceCountCap >= SYNTHESIS_MIN_REVIEW_SOURCE_COUNT;
  let sourceAbstracts: SynthesisSourceAbstract[] = [];
  let criticalSourceContexts: Array<{ source: string; reason: string; excerpt: string }> =
    selectCriticalSourceContexts({ sourceBriefs: preTrim.sourceBriefs });

  if (shouldRunAbstractPass) {
    const abstractPack = await buildSourceAbstracts({
      runId: input.runId,
      userId: input.userId,
      prompt: input.prompt,
      sources: preTrim.sourceBriefs,
      citationPolicy: input.citationPolicy,
      provider: input.provider,
      model: input.model,
      thinkingMode: input.thinkingMode,
      store: input.store,
      objectStore: input.objectStore,
      checkpoint: input.checkpoint,
      requestedSourceLimit: Math.min(SYNTHESIS_MAX_SOURCE_ABSTRACTS, sourceCountCap),
    });
    sourceAbstracts = abstractPack.sourceAbstracts;
    criticalSourceContexts = abstractPack.criticalSourceContexts;
  }
  let previousSynthesis: SynthesisOutput | undefined = input.previousSynthesis;
  let lastTrimResult: SynthesisContextTrimResult | undefined;
  let reviewDirectives: string[] = [];
  let reviewFeedback: SynthesisReviewFeedbackPayload | undefined;
  let lastReviewVerdict: SynthesisReviewOutput["verdict"] | null = null;
  let lastOutput: SynthesisOutput | undefined;

  const logOutputCapEvent = async (
    trimResult: SynthesisContextTrimResult,
    outputCapFromContext: number,
    outputTokensToUse: number
  ) => {
    if (trimResult.trimmed) {
          const citationsImpact = {
            quoteCountBefore: trimResult.quoteCountBefore,
            quoteCountAfter: trimResult.quoteCountAfter,
            droppedQuotes: trimResult.droppedQuoteCount,
            droppedSources: trimResult.droppedSourceCount,
            droppedAbstracts: trimResult.droppedAbstractCount,
            droppedCriticalSourceContexts: trimResult.droppedCriticalContextCount,
            sourceAbstractsBefore: trimResult.sourceAbstractCountBefore,
            sourceAbstractsAfter: trimResult.sourceAbstractCountAfter,
          };
      await input.store
        .addRunEvent({
          runId: input.runId,
          level: "warn",
          phase: "synthesize",
          eventType: "synthesis_context_trimmed",
          message: "Synthesis context exceeded input token budget and was trimmed",
          data: {
            budgetTokensApplied: input.maxInputTokens,
            requestedInputBudget: input.requestedMaxInputTokens,
            inputTokensBefore: trimResult.inputTokensBefore,
            inputTokensAfter: trimResult.inputTokensAfter,
            sourceCountBefore: trimResult.sourceCountBefore,
            sourceCountAfter: trimResult.sourceCountAfter,
            sourceCountCap,
            quoteCountCap,
            requestedOutputTokens: input.requestedMaxOutputTokens,
            outputTokensApplied: outputTokensToUse,
            outputCapFromContext,
            citationsImpact,
          },
        })
        .catch(() => {});
      return;
    }

    if (outputTokensToUse < input.requestedMaxOutputTokens) {
      await input.store
        .addRunEvent({
          runId: input.runId,
          level: "warn",
          phase: "synthesize",
          eventType: "synthesis_output_cap_applied",
          message: "Synthesis output token budget was reduced to fit context constraints",
          data: {
            requestedInputBudget: input.requestedMaxInputTokens,
            requestedOutputTokens: input.requestedMaxOutputTokens,
            outputTokensApplied: outputTokensToUse,
            outputCapFromContext,
            contextWindowTokens: input.synthesisContextWindowTokens,
            inputTokensAfter: trimResult.inputTokensAfter,
            sourceCountBefore: trimResult.sourceCountBefore,
            sourceCountAfter: trimResult.sourceCountAfter,
            sourceCountCap,
            quoteCountCap,
          },
        })
        .catch(() => {});
    }
  };

  const attempts = SYNTHESIS_REFINEMENT_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const trimResult = trimSynthesisContextForBudget({
      maxInputTokens: input.maxInputTokens,
      prompt: input.prompt,
      citationPolicy: input.citationPolicy,
      sourceBriefs: preTrim.sourceBriefs,
      sourceAbstracts,
      criticalSourceContexts,
      targets,
    });
    lastTrimResult = trimResult;
    const outputCapFromContext = Math.max(
      SYNTHESIS_MIN_OUTPUT_TOKENS,
      Math.max(
        1,
        input.synthesisContextWindowTokens -
          trimResult.inputTokensAfter -
          SYNTHESIS_OUTPUT_TOKEN_SAFETY_BUFFER
      )
    );
    const outputTokensToUse = Math.min(input.maxOutputTokens, outputCapFromContext);
    await logOutputCapEvent(trimResult, outputCapFromContext, outputTokensToUse);

    const sys: ChatMessage = {
      role: "system",
      content: SYNTHESIS_SYSTEM_PROMPT,
    };
    const user: ChatMessage = {
      role: "user",
      content: JSON.stringify(
        buildSynthesisPromptPayload({
          prompt: input.prompt,
          citationPolicy: input.citationPolicy,
          sources: trimResult.sourceBriefs,
          sourceAbstracts: trimResult.sourceAbstracts,
          criticalSourceContexts: trimResult.criticalSourceContexts,
          ...(reviewFeedback ? { reviewFeedback } : {}),
          targets,
          sourceCountBefore: sourceCountCap,
          ...(previousSynthesis ? { previousSynthesis } : {}),
          refinementPass: attempt,
          ...(reviewFeedback ? { requireReviewIteration: true } : {}),
        })
      ),
    };

    const parsed = await callModelJsonLogged({
      runId: input.runId,
      userId: input.userId,
      phase: "synthesize",
      persona: "synthesis-writing",
      synthesisPurpose: "writing",
      provider: input.provider,
      model: input.model,
      messages: [sys, user],
      schema: SynthesisOutputSchema,
      maxTokens: outputTokensToUse,
      reasoningEffort: input.thinkingMode,
      store: input.store,
      objectStore: input.objectStore,
      checkpoint: input.checkpoint,
      promptVersion: "synthesize.v1",
    });

    const out: SynthesisOutput = {
      ...parsed,
      sourceIndex: parsed.sourceIndex ?? [],
      negativeSpace: parsed.negativeSpace
        ? {
            missingLinks: parsed.negativeSpace.missingLinks ?? [],
            unaskedQuestions: parsed.negativeSpace.unaskedQuestions ?? [],
            temporalBlindspots: parsed.negativeSpace.temporalBlindspots ?? [],
          }
        : undefined,
      thematicSynthesis: (parsed.thematicSynthesis ?? []).map((theme) => ({
        ...theme,
        citations: theme.citations ?? [],
      })),
      unknowns: parsed.unknowns ?? [],
      keyFindings: parsed.keyFindings.map((c, i) => ({
        ...c,
        id: c.id || `F${i + 1}`,
        citations: c.citations ?? [],
      })),
      recommendations: parsed.recommendations ?? [],
      contradictions: parsed.contradictions ?? [],
      confidenceAppendix: parsed.confidenceAppendix
        ? parsed.confidenceAppendix.map((item) => ({
            ...item,
            alternativeInterpretations: item.alternativeInterpretations ?? [],
          }))
        : undefined,
    };
    lastOutput = out;

    const reviewIfNeeded = async () => {
      if (!reviewEnabled || !input.provider) return true;
      const review = await reviewSynthesisDraft({
        runId: input.runId,
        userId: input.userId,
        prompt: input.prompt,
        sources: trimResult.sourceBriefs,
        sourceAbstracts: trimResult.sourceAbstracts,
        synthesis: out,
        provider: input.provider,
        model: input.model,
        thinkingMode: input.thinkingMode,
        store: input.store,
        objectStore: input.objectStore,
        checkpoint: input.checkpoint,
      });
      const unsupportedConclusions = review.unsupportedConclusions ?? [];
      const requestedRevisions = review.requestedRevisions ?? [];
      const missingEvidence = review.missingEvidence ?? [];
      lastReviewVerdict = review.verdict;

      await input.store
        .addRunEvent({
          runId: input.runId,
          level: "info",
          phase: "synthesize",
          eventType: "synthesis_review_feedback",
          message: "Reviewer feedback received for synthesis draft",
          data: {
            verdict: review.verdict,
            attempt: attempt + 1,
            confidenceRisk: review.confidenceRisk,
            unsupportedConclusions: unsupportedConclusions.map((issue) => ({
              findingId: issue.findingId,
              issue: issue.issue,
              why: issue.why,
              strengtheningAlternative: issue.strengtheningAlternative,
            })),
            missingEvidence,
            requestedRevisions,
          },
        })
        .catch(() => {});

      if (review.verdict === "accept") return true;

      if (review.verdict === "revise" || review.verdict === "reject") {
        if (unsupportedConclusions.length > 0) {
          reviewDirectives = unsupportedConclusions
            .map((i) => i.strengtheningAlternative)
            .slice(0, 4);
        } else if (requestedRevisions.length > 0) {
          reviewDirectives = requestedRevisions.slice(0, 4);
        }
        previousSynthesis = {
          ...out,
          unknowns: [
            ...out.unknowns,
            ...unsupportedConclusions.map(
              (issue) => `Reviewer issue (${issue.findingId}): ${issue.issue}`
            ),
          ],
        };
        reviewFeedback = {
          verdict: review.verdict,
          unsupportedConclusions,
          missingEvidence,
          requestedRevisions,
          directives: reviewDirectives,
          ...(review.confidenceRisk === undefined ? {} : { confidenceRisk: review.confidenceRisk }),
        };
        await input.store
          .addRunEvent({
            runId: input.runId,
            level: "info",
            phase: "synthesize",
            eventType: "synthesis_review_requested",
            message: "Reviewer flagged unsupported conclusions; requesting one more draft with revision guidance",
            data: {
              verdict: review.verdict,
              confidenceRisk: review.confidenceRisk,
              unsupportedCount: unsupportedConclusions.length,
              revisionHints: reviewDirectives.length,
              attempt: attempt + 1,
            },
          })
          .catch(() => {});
      }
      return false;
    };

    const sufficiency = evaluateSynthesisOutputSufficiency({
      output: out,
      targets,
      sourceCount: trimResult.sourceCountAfter,
    });
    const isSufficient = sufficiency.sufficient;
    const reviewerAccepted = await reviewIfNeeded();
    if (isSufficient && reviewerAccepted) {
      if (attempt > 0) {
        await input.store
          .addRunEvent({
            runId: input.runId,
            level: "info",
            phase: "synthesize",
            eventType: "synthesis_refinement_succeeded",
            message: "Synthesis refinement met target depth and source coverage",
            data: {
              attemptsUsed: attempt + 1,
              targetSummaryWords: targets.minSummaryWords,
              minKeyFindings: targets.minKeyFindings,
              minRecommendations: targets.minRecommendations,
              sourceLabelsAvailable: sourceLabelsForPrompt,
              sourceCountCap,
              quoteCountCap,
            },
          })
          .catch(() => {});
      }
      return out;
    }

    previousSynthesis = out;
    if (attempt < attempts - 1) {
      const depthShortfalls = [
        sufficiency.shortfalls.findings > 0 ? `findings+${sufficiency.shortfalls.findings}` : null,
        sufficiency.shortfalls.recommendations > 0
          ? `recs+${sufficiency.shortfalls.recommendations}`
          : null,
        sufficiency.shortfalls.summaryWords > 0 ? `summaryWords+${sufficiency.shortfalls.summaryWords}` : null,
      ].filter(Boolean) as string[];
      const failureSummary = depthShortfalls.length
        ? depthShortfalls.join(" ")
        : sufficiency.failedChecks.length
          ? `failed=${sufficiency.failedChecks.join(",")}`
          : "insufficient_depth";
      const refinementReason = isSufficient ? "review_pending" : "insufficient_depth";
      await input.store
        .addRunEvent({
          runId: input.runId,
          level: "info",
          phase: "synthesize",
          eventType: "synthesis_refinement_requested",
          message:
            refinementReason === "review_pending"
              ? `Synthesis reviewer requested revisions; requesting one more pass`
              : `Synthesis output did not meet target depth (${failureSummary}); requesting one more pass`,
          data: {
            attempt: attempt + 1,
            attemptsAllowed: attempts,
            reason: refinementReason,
            gotSummaryWordCount: sufficiency.summaryWordCount,
            gotFindingCount: sufficiency.findingCount,
            gotRecommendationCount: sufficiency.recommendationCount,
            targetSummaryWords: targets.minSummaryWords,
            targetFindings: targets.minKeyFindings,
            targetRecommendations: targets.minRecommendations,
            shortfalls: sufficiency.shortfalls,
            failedChecks: sufficiency.failedChecks,
            advanced: sufficiency.advanced ?? null,
            reviewDirectives: reviewDirectives.length,
          },
        })
        .catch(() => {});
      continue;
    }
  }

  await input.store
    .addRunEvent({
      runId: input.runId,
      level: "warn",
      phase: "synthesize",
      eventType: "synthesis_refinement_exhausted",
      message:
        reviewEnabled && lastReviewVerdict && lastReviewVerdict !== "accept"
          ? "Synthesis refinement loop exhausted; failing synthesis phase"
          : "Synthesis refinement loop exhausted; returning best-effort synthesis",
      data: {
        attemptsUsed: attempts,
        targetSummaryWords: targets.minSummaryWords,
        targetFindings: targets.minKeyFindings,
        targetRecommendations: targets.minRecommendations,
        sourceCountCap,
        quoteCountCap,
        lastReviewVerdict,
        lastTrim: lastTrimResult
          ? {
              inputTokensAfter: lastTrimResult.inputTokensAfter,
              sourceCountAfter: lastTrimResult.sourceCountAfter,
              quoteCountAfter: lastTrimResult.quoteCountAfter,
              sourceAbstractCountAfter: lastTrimResult.sourceAbstractCountAfter,
              sourceAbstractCountBefore: lastTrimResult.sourceAbstractCountBefore,
            }
          : null,
      },
    })
    .catch(() => {});

  if (reviewEnabled && lastReviewVerdict && lastReviewVerdict !== "accept") {
    throw new Error("Synthesis could not reach requested depth after refinement loop.");
  }

  if (lastOutput) return lastOutput;

  throw new Error("Synthesis refinement exhausted without producing output.");
}
