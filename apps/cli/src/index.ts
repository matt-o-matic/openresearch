import { Command } from "commander";
import { format } from "node:util";

import {
  loadConfig,
  runCitationMapKey,
  runOutputKey,
  runResearchPipeline,
} from "@openresearch/core";
import {
  BraveSearchAdapter,
  HttpFetchAdapterImpl,
  OpenRouterModelProvider,
  PlaywrightRenderAdapter,
  SearxngSearchAdapter,
} from "@openresearch/adapters";
import { buildApiServer } from "@openresearch/api";
import { runWorker } from "@openresearch/worker";
import { DiskCache, FilesystemObjectStore, PostgresStore } from "@openresearch/storage";

const program = new Command();

program.name("openresearch").description("OpenResearch CLI").version("0.1.0");

program
  .command("version")
  .description("Print version")
  .action(() => {
    console.log("0.1.0");
  });

program
  .command("migrate")
  .description("Run database migrations")
  .action(async () => {
    const config = await loadConfig();
    const store = new PostgresStore({ databaseUrl: config.postgres.url });
    try {
      const { applied } = await store.migrate();
      if (applied.length === 0) {
        console.log("Migrations: up to date");
      } else {
        console.log(`Migrations applied: ${applied.join(", ")}`);
      }
    } finally {
      await store.close();
    }
  });

async function buildServices(config: Awaited<ReturnType<typeof loadConfig>>) {
  const store = new PostgresStore({ databaseUrl: config.postgres.url });
  await store.migrate();

  const objectStore = new FilesystemObjectStore({ rootPath: config.objectStore.rootPath });
  const cache = new DiskCache({
    enabled: config.cache.enabled,
    rootPath: config.cache.rootPath,
    ttlMs: config.cache.ttlDays * 24 * 60 * 60 * 1000,
  });

  const searx = new SearxngSearchAdapter({
    baseUrl: config.search.searxng.baseUrl,
    userAgent: config.safety.userAgent,
    maxResultsPerQuery: config.search.maxResultsPerQuery,
    cache,
  });

  const brave = config.search.brave.apiKey
    ? new BraveSearchAdapter({
        apiKey: config.search.brave.apiKey,
        userAgent: config.safety.userAgent,
        maxResultsPerQuery: config.search.maxResultsPerQuery,
        cache,
      })
    : null;

  const search = config.search.backend === "brave" && brave ? brave : searx;

  const httpFetch = new HttpFetchAdapterImpl({
    cache,
    userAgent: config.safety.userAgent,
    defaultMaxBytes: config.safety.maxContentBytes,
  });

  const browserRender = new PlaywrightRenderAdapter({ userAgent: config.safety.userAgent });

  const modelProvider = config.openRouter.apiKey
    ? new OpenRouterModelProvider(
        (() => {
          const out: { apiKey: string; baseUrl?: string; appName?: string; appUrl?: string } = {
            apiKey: config.openRouter.apiKey,
            baseUrl: config.openRouter.baseUrl,
            appName: config.openRouter.appName,
          };
          if (config.openRouter.appUrl) out.appUrl = config.openRouter.appUrl;
          return out;
        })()
      )
    : undefined;

  const services: Parameters<typeof runResearchPipeline>[0]["services"] = {
    store,
    objectStore,
    search,
    httpFetch,
    browserRender,
  };
  if (modelProvider) services.modelProvider = modelProvider;

  return { store, objectStore, services };
}

type DbRunEvent = {
  id: string;
  created_at: string;
  level: "debug" | "info" | "warn" | "error";
  phase: string | null;
  event_type: string;
  message: string | null;
  data: unknown;
};

type DbRun = {
  id: string;
  status: "queued" | "running" | "failed" | "completed" | "canceled";
  phase: string | null;
  started_at: string | null;
  finished_at: string | null;
  state: unknown;
};

type DbSource = {
  id: string;
  url: string;
  status: "pending" | "fetched" | "rendered" | "extracted" | "failed" | "skipped";
};

type DbModelCall = {
  id: string;
  run_id: string;
  phase: string;
  model_id: string;
  created_at: string;
  tokens_in: number | null;
  tokens_out: number | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runLogKey(runId: string): string {
  return `runs/${runId}/run.log`;
}

type CliLog = (...parts: unknown[]) => void;

type VerbosityLevel = 0 | 1 | 2 | 3;

function coerceVerbosityLevel(value: unknown): VerbosityLevel {
  const raw = typeof value === "string" ? Number.parseInt(value, 10) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(raw)) return 2;
  const normalized = Math.max(0, Math.min(3, Math.floor(raw)));
  if (normalized === 0) return 0;
  if (normalized === 1) return 1;
  if (normalized === 2) return 2;
  return 3;
}

type RunLogWriter = {
  log: CliLog;
  write: (text: string) => void;
  flush: () => Promise<void>;
};

function createRunLogWriter({
  runId,
  objectStore,
}: {
  runId: string;
  objectStore: FilesystemObjectStore;
}): RunLogWriter {
  const chunks: string[] = [];
  const writeChunk = (chunk: string) => {
    if (!chunk) return;
    process.stdout.write(chunk);
    chunks.push(chunk);
  };
  const log: CliLog = (...parts) => {
    const message = `${format(...parts)}\n`;
    writeChunk(message);
  };
  return {
    log,
    write: writeChunk,
    flush: async () => {
      await objectStore.putText(runLogKey(runId), chunks.join(""));
    },
  };
}

function formatElapsed(startedAt: number): string {
  const totalMs = Math.max(0, Date.now() - startedAt);
  const totalSec = Math.floor(totalMs / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = String(totalSec % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "unknown";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function formatDurationMs(ms: number): string {
  const totalMs = Math.max(0, Math.floor(ms));
  const totalSec = Math.floor(totalMs / 1000);
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = String(totalSec % 60).padStart(2, "0");
  if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
  return `${mins}m ${secs}s`;
}

function normalizeCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }
  return 0;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

type CliTodoItem = {
  index: number;
  text: string;
};

function formatTodoItems(rawItems: unknown): CliTodoItem[] {
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .map((item, defaultIndex) => {
      if (typeof item === "string") {
        const text = item.trim();
        if (!text) return null;
        return { index: defaultIndex + 1, text };
      }
      if (item && typeof item === "object") {
        const asObject = item as { text?: unknown; index?: unknown };
        if (typeof asObject.text === "string") {
          const normalized = asObject.text.trim();
          const indexValue =
            typeof asObject.index === "number" && Number.isFinite(asObject.index)
              ? asObject.index
              : defaultIndex + 1;
          if (normalized) return { index: indexValue, text: normalized };
        }
      }
      return null;
    })
    .filter((value): value is CliTodoItem => value !== null);
}

function formatTodoHints(rawHints: unknown): string[] {
  if (!Array.isArray(rawHints)) return [];
  return rawHints
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((value): value is string => Boolean(value));
}

function formatReviewUnsupportedConclusions(rawConclusions: unknown): Array<{
  findingId: string;
  issue: string;
  why: string;
  strengtheningAlternative: string;
}> {
  if (!Array.isArray(rawConclusions)) return [];
  return rawConclusions
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const source = item as {
        findingId?: unknown;
        issue?: unknown;
        why?: unknown;
        strengtheningAlternative?: unknown;
      };
      const findingId = typeof source.findingId === "string" ? source.findingId.trim() : "";
      const issue = typeof source.issue === "string" ? source.issue.trim() : "";
      const why = typeof source.why === "string" ? source.why.trim() : "";
      const strengtheningAlternative =
        typeof source.strengtheningAlternative === "string"
          ? source.strengtheningAlternative.trim()
          : "";
      if (!findingId || !issue || !why || !strengtheningAlternative) return null;
      return { findingId, issue, why, strengtheningAlternative };
    })
    .filter(
      (
        value
      ): value is {
        findingId: string;
        issue: string;
        why: string;
        strengtheningAlternative: string;
      } => value !== null
    );
}

function formatStringList(rawValues: unknown): string[] {
  if (!Array.isArray(rawValues)) return [];
  return rawValues
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((value): value is string => Boolean(value));
}

function eventLabel(event: DbRunEvent): string {
  const data = asRecord(event.data);
  if (event.event_type === "plan_todo_list_ready") {
    const message = event.message ?? "Plan to-do list generated";
    const items = formatTodoItems(data?.items);
    const hints = formatTodoHints(data?.queryHints);
    if (items.length === 0) {
      return message;
    }
    const lines = [message, ...items.map((item) => `  [${item.index}] ${item.text}`)];
    if (hints.length > 0) {
      lines.push(`  Hints: ${hints.join(" | ")}`);
    }
    return lines.join("\n");
  }
  if (event.event_type === "synthesis_review_feedback") {
    const verdictRaw = data?.verdict;
    const verdict = typeof verdictRaw === "string" ? verdictRaw : "unknown";
    const attemptRaw = data?.attempt;
    const attempt =
      typeof attemptRaw === "number" && Number.isFinite(attemptRaw) ? attemptRaw : undefined;
    const confidenceRiskRaw = data?.confidenceRisk;
    const confidenceRisk =
      typeof confidenceRiskRaw === "number" && Number.isFinite(confidenceRiskRaw)
        ? confidenceRiskRaw
        : undefined;
    const unsupported = formatReviewUnsupportedConclusions(data?.unsupportedConclusions);
    const missingEvidence = formatStringList(data?.missingEvidence);
    const revisions = formatStringList(data?.requestedRevisions);
    const lines = [
      `Reviewer feedback received${attempt ? ` (attempt ${attempt})` : ""}: ${verdict}`,
    ];
    if (unsupported.length > 0) {
      lines.push("  Unsupported conclusions:");
      unsupported.slice(0, 4).forEach((item, index) => {
        lines.push(`    [${index + 1}] ${item.findingId}: ${item.issue}`);
        lines.push(`      Why: ${item.why}`);
        lines.push(`      Revision: ${item.strengtheningAlternative}`);
      });
      if (unsupported.length > 4) {
        lines.push(`    + ${unsupported.length - 4} more unsupported findings omitted`);
      }
    }
    if (missingEvidence.length > 0) {
      lines.push("  Missing evidence:");
      missingEvidence.slice(0, 4).forEach((item, index) => {
        lines.push(`    [${index + 1}] ${item}`);
      });
      if (missingEvidence.length > 4) {
        lines.push(`    + ${missingEvidence.length - 4} more missing-evidence items omitted`);
      }
    }
    if (revisions.length > 0) {
      lines.push("  Requested revisions:");
      revisions.slice(0, 4).forEach((item, index) => {
        lines.push(`    [${index + 1}] ${item}`);
      });
      if (revisions.length > 4) {
        lines.push(`    + ${revisions.length - 4} more requested revisions omitted`);
      }
    }
    if (confidenceRisk !== undefined) {
      lines.push(`  Confidence risk: ${confidenceRisk}`);
    }
    return lines.join("\n");
  }

  if (event.event_type === "model_call_started") {
    const reason =
      (data?.reasoningEffort as string) ??
      (data?.reasoning_effort as string) ??
      "unknown";
    const modelCallId = safeString(data?.modelCallId);
    const persona = safeString(data?.persona ?? data?.phase);
    const purpose = safeString(data?.synthesisPurpose);
    const maxTokens = normalizeCount(data?.maxTokens);
    const maxRetries = Number(data?.maxRetries);
    const retryPolicy =
      Number.isFinite(maxRetries) && maxRetries >= 0 ? ` maxRetries=${maxRetries}` : "";
    return `Model call started: persona=${persona} id=${modelCallId} purpose=${purpose || "n/a"} model=${safeString(data?.model)} reasoning=${safeString(reason)} maxTokens=${String(
        maxTokens || "unknown"
    )} ${retryPolicy}`;
  }
  if (event.event_type === "model_call_retry") {
    const reason = safeString(data?.errorMessage);
    const modelCallId = safeString(data?.modelCallId);
    const reasoning =
      (data?.reasoningEffort as string) ??
      (data?.reasoning_effort as string) ??
      "unknown";
    const attempt = normalizeCount(data?.retryAttempt);
    const displayAttempt = attempt + 1;
    const maxTokens = normalizeCount(data?.maxTokens);
    const maxAttempts = Number(data?.maxAttempts);
    const persona = safeString(data?.persona ?? data?.phase);
    const model = safeString(data?.model);
    const attemptLabel = `attempt=${displayAttempt}`;
    const totalLabel = Number.isFinite(maxAttempts)
      ? `/${Math.max(1, Math.floor(maxAttempts - 1))}`
      : "";
    return `Retrying model call: persona=${persona} id=${modelCallId} purpose=${safeString(data?.synthesisPurpose) || "n/a"} model=${model} reasoning=${safeString(
      reasoning
    )} maxTokens=${String(maxTokens || "unknown")} (${attemptLabel}${totalLabel}) reason=${reason}`;
  }
  if (event.event_type === "model_call_completed") {
    const persona = safeString(data?.persona ?? data?.phase);
    const purpose = safeString(data?.synthesisPurpose);
    const modelCallId = safeString(data?.modelCallId);
    const reasoning =
      (data?.reasoningEffort as string) ??
      (data?.reasoning_effort as string) ??
      "unknown";
    const retryAttempt = normalizeCount(data?.retryAttempt);
    const maxTokens = normalizeCount(data?.maxTokens);
    const attemptLabel = ` attempt=${retryAttempt}`;
    const compat = safeString(data?.schemaCompatMode);
    const base = `Model call completed: persona=${persona} id=${modelCallId} purpose=${purpose || "n/a"} model=${safeString(
      data?.model
    )} reasoning=${safeString(reasoning)} maxTokens=${String(maxTokens || "unknown")} ${attemptLabel}`;
    return compat && compat !== "unknown" ? `${base} compat=${compat}` : base;
  }
  if (event.message) return event.message;

  switch (event.event_type) {
    case "search_result_candidate":
      return `Candidate source: ${safeString(data?.url)}`;
    case "source_fetch_started":
      return `Fetching source: ${safeString(data?.url)}`;
    case "source_fetch_completed":
      return `Fetched source: ${safeString(data?.url)}`;
    case "source_fetch_failed":
      return `Fetch failed: ${safeString(data?.url)}`;
    case "source_extract_started":
      return `Extracting source: ${safeString(data?.url)}`;
    case "source_extract_completed":
      return `Extracted source: ${safeString(data?.url)}`;
    case "source_extract_failed":
      return `Extraction failed: ${safeString(data?.url)}`;
    case "search_query_started":
      return `Searching web for: ${safeString(data?.query)}`;
    case "search_query_completed":
      return `Search complete for: ${safeString(data?.query)}`;
    case "phase_started":
      return `Phase started: ${event.phase ?? "unknown"}`;
    case "phase_completed":
      return `Phase completed: ${event.phase ?? "unknown"}`;
    default:
      return `${event.event_type}`;
  }
}

function summarizeSources(sources: DbSource[]): string {
  const counts: Record<DbSource["status"], number> = {
    pending: 0,
    fetched: 0,
    rendered: 0,
    extracted: 0,
    failed: 0,
    skipped: 0,
  };
  for (const source of sources) {
    counts[source.status] += 1;
  }
  return `pending=${counts.pending} fetched=${counts.fetched} rendered=${counts.rendered} extracted=${counts.extracted} failed=${counts.failed} skipped=${counts.skipped}`;
}

function summarizeCheckpoint(state: unknown): string {
  if (!state || typeof state !== "object") return "no checkpoints yet";
  const checkpoints = state as { counters?: Record<string, number> };
  const counters = checkpoints.counters ?? {};
  return `search=${String(counters.searchCalls ?? 0)}, fetch=${String(
    counters.fetches ?? 0
  )}, render=${String(counters.renders ?? 0)}, model=${String(counters.modelCalls ?? 0)}`;
}

type PhaseTokenBucket = {
  calls: number;
  tokensIn: number;
  tokensOut: number;
};

function collectRunFinalStats(input: {
  run: DbRun;
  sources: DbSource[];
  events: DbRunEvent[];
  modelCalls: DbModelCall[];
  verifiedClaims?: number;
}) {
  const status = input.run.status;
  const totalSources = input.sources.length;
  const sourceStatusCounts: Record<DbSource["status"], number> = {
    pending: 0,
    fetched: 0,
    rendered: 0,
    extracted: 0,
    failed: 0,
    skipped: 0,
  };
  for (const source of input.sources) {
    sourceStatusCounts[source.status] += 1;
  }

  const eventTypeCounts: Record<string, number> = {};
  const phaseCounts: Record<string, number> = {};
  let searchQueries = 0;
  let searchQueryResultCount = 0;
  const discoveredUrls = new Set<string>();
  let planPasses = 0;
  let planPassCompletions = 0;
  let planFollowUpsTrimmed = 0;
  let planContinueRequests = 0;
  let planCapReached = 0;
  let synthesisAttemptsUsed = 1;
  let synthesisRefinementRequests = 0;
  let synthesisRefinementCompleted = 0;
  let reviewFeedbacks = 0;
  let reviewRequests = 0;
  let reviewAttempts = 0;
  let errorEvents = 0;
  let warningEvents = 0;

  for (const event of input.events) {
    eventTypeCounts[event.event_type] = (eventTypeCounts[event.event_type] ?? 0) + 1;
    if (event.phase) phaseCounts[event.phase] = (phaseCounts[event.phase] ?? 0) + 1;
    if (event.level === "error") errorEvents += 1;
    if (event.level === "warn") warningEvents += 1;

    const data = asRecord(event.data);
    if (
      event.event_type === "search_query_started" ||
      event.event_type === "search_query_completed"
    ) {
      searchQueries += 1;
    }
    if (event.event_type === "search_query_completed") {
      searchQueryResultCount += normalizeCount(data?.results);
    }
    if (event.event_type === "search_result_candidate") {
      const url = normalizeText(data?.url);
      if (url) discoveredUrls.add(url);
    }

    if (event.event_type === "plan_pass_started" || event.event_type === "plan_pass_completed") {
      const pass = normalizeCount(data?.pass);
      if (pass > planPasses) planPasses = pass;
    }
    if (event.event_type === "plan_pass_completed") {
      planPassCompletions += 1;
    }
    if (event.event_type === "plan_follow_ups_trimmed") {
      planFollowUpsTrimmed += 1;
    }
    if (event.event_type === "plan_continue_requested") {
      planContinueRequests += 1;
      const pass = normalizeCount(data?.pass);
      if (pass > planPasses) planPasses = pass;
    }
    if (event.event_type === "plan_loop_cap_reached") planCapReached += 1;

    if (event.event_type === "synthesis_refinement_requested") {
      synthesisRefinementRequests += 1;
      const attempt = normalizeCount(data?.attempt);
      if (attempt > 0) {
        synthesisAttemptsUsed = Math.max(synthesisAttemptsUsed, attempt + 1);
      }
    }
    if (
      event.event_type === "synthesis_refinement_succeeded" ||
      event.event_type === "synthesis_refinement_exhausted"
    ) {
      const attemptsUsed = normalizeCount(data?.attemptsUsed);
      if (attemptsUsed > 0) synthesisAttemptsUsed = Math.max(synthesisAttemptsUsed, attemptsUsed);
      synthesisRefinementCompleted += 1;
    }
    if (event.event_type === "synthesis_review_requested") {
      reviewRequests += 1;
    }
    if (event.event_type === "synthesis_review_feedback") {
      reviewFeedbacks += 1;
      const attempt = normalizeCount(data?.attempt);
      if (attempt > 0) synthesisAttemptsUsed = Math.max(synthesisAttemptsUsed, attempt);
      reviewAttempts = Math.max(reviewAttempts, attempt || reviewAttempts);
    }
  }

  const phaseTokenStats: Record<string, PhaseTokenBucket> = {};
  let totalModelCalls = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  for (const modelCall of input.modelCalls) {
    const phase = modelCall.phase || "unknown";
    const bucket = phaseTokenStats[phase] ?? { calls: 0, tokensIn: 0, tokensOut: 0 };
    bucket.calls += 1;
    bucket.tokensIn += Math.max(0, modelCall.tokens_in ?? 0);
    bucket.tokensOut += Math.max(0, modelCall.tokens_out ?? 0);
    phaseTokenStats[phase] = bucket;
    totalModelCalls += 1;
    totalTokensIn += Math.max(0, modelCall.tokens_in ?? 0);
    totalTokensOut += Math.max(0, modelCall.tokens_out ?? 0);
  }

  const scannedSources = discoveredUrls.size || searchQueryResultCount;
  const filteredSources = sourceStatusCounts.skipped + sourceStatusCounts.failed;
  const parsedSources = sourceStatusCounts.extracted;
  const verifiedClaims = input.verifiedClaims ?? 0;

  const parsedStart = input.run.started_at ? Date.parse(input.run.started_at) : NaN;
  const parsedFinish = input.run.finished_at ? Date.parse(input.run.finished_at) : Date.now();
  const durationMs = Number.isFinite(parsedStart)
    ? Math.max(0, parsedFinish - parsedStart)
    : undefined;

  return {
    startedAt: Number.isFinite(parsedStart) ? new Date(parsedStart).toISOString() : "unknown",
    finishedAt: Number.isFinite(parsedFinish) ? new Date(parsedFinish).toISOString() : "unknown",
    status,
    totalSources,
    sourceStatusCounts,
    scannedSources,
    filteredSources,
    parsedSources,
    verifiedClaims,
    events: {
      total: input.events.length,
      errorEvents,
      warningEvents,
      eventTypeCounts,
      phaseCounts,
    },
    retrieval: {
      searchQueries,
      searchQueryResultCount,
      discoveredUrls: discoveredUrls.size,
    },
    passes: {
      planPasses,
      planContinueRequests,
      planCapReached,
      planPassCompletions,
      planFollowUpsTrimmed,
      synthesisAttemptsUsed,
      synthesisRefinementRequests,
      synthesisRefinementCompleted,
      reviewFeedbacks,
      reviewRequests,
      reviewAttempts,
    },
    model: {
      totalModelCalls,
      totalTokensIn,
      totalTokensOut,
      byPhase: phaseTokenStats,
    },
    durationMs,
  };
}

function printRunFinalStats(input: {
  summary: ReturnType<typeof collectRunFinalStats>;
  log: CliLog;
}) {
  const { summary, log } = input;
  const orderedPhases = [
    "plan",
    "retrieve",
    "fetch",
    "extract",
    "synthesize",
    "verify",
    "finalize",
    "unknown",
  ];
  const modelRows = orderedPhases
    .filter((phase) => summary.model.byPhase[phase]?.calls)
    .map((phase) => {
      const bucket = summary.model.byPhase[phase]!;
      return `    ${phase.padEnd(9)} calls=${String(bucket.calls).padStart(3)} in=${String(
        bucket.tokensIn
      ).padStart(7)} out=${String(bucket.tokensOut).padStart(7)}`;
    });

  const allBuckets = Object.entries(summary.model.byPhase)
    .filter(([phase]) => !orderedPhases.includes(phase))
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [phase, bucket] of allBuckets) {
    modelRows.push(
      `    ${phase.padEnd(9)} calls=${String(bucket.calls).padStart(3)} in=${String(
        bucket.tokensIn
      ).padStart(7)} out=${String(bucket.tokensOut).padStart(7)}`
    );
  }

  if (modelRows.length === 0) {
    modelRows.push("    no model calls were recorded");
  }

  const loopPassSummaryParts: string[] = [];
  if (summary.passes.planPassCompletions > 0) {
    loopPassSummaryParts.push(`plan=${summary.passes.planPassCompletions}`);
  }
  if (summary.passes.reviewRequests > 0) {
    loopPassSummaryParts.push(`review=${summary.passes.reviewRequests}`);
  }
  if (summary.passes.synthesisRefinementCompleted > 0) {
    loopPassSummaryParts.push(`refinement=${summary.passes.synthesisRefinementCompleted}`);
  }
  const loopSummary = loopPassSummaryParts.length > 0 ? loopPassSummaryParts.join(", ") : "n/a";

  log(`Run Status: ${summary.status}`);
  log(`Run Final Stats`);
  log(
    `  Time: ${
      summary.durationMs === undefined ? "unknown" : formatDurationMs(summary.durationMs)
    } (started: ${summary.startedAt}, finished: ${summary.finishedAt})`
  );
  log(
    `  Items: scanned=${summary.scannedSources} selected=${summary.totalSources} parsed=${summary.parsedSources} filtered=${summary.filteredSources} verified=${summary.verifiedClaims}`
  );
  log(
    `  Source health: failed=${summary.sourceStatusCounts.failed} skipped=${summary.sourceStatusCounts.skipped}`
  );
  log(`  Verified: claims=${summary.verifiedClaims}`);
  log(
    `  Tokens: total in=${summary.model.totalTokensIn} out=${summary.model.totalTokensOut} calls=${summary.model.totalModelCalls}`
  );
  log("  Tokens by phase:");
  for (const row of modelRows) log(row);
  log(
    `  Retrieval: queries=${summary.retrieval.searchQueries} candidates=${summary.retrieval.discoveredUrls} result-items=${summary.retrieval.searchQueryResultCount}`
  );
  log(`  Loop passes: ${loopSummary}`);
  log(
    `  Planning: maxPass=${summary.passes.planPasses} completed=${summary.passes.planPassCompletions} continueRequests=${summary.passes.planContinueRequests} trimmed=${summary.passes.planFollowUpsTrimmed} capped=${summary.passes.planCapReached}`
  );
  log(
    `  Synthesis loop: attempts=${summary.passes.synthesisAttemptsUsed} refinementRequested=${summary.passes.synthesisRefinementRequests} reviewRequested=${summary.passes.reviewRequests} reviewFeedback=${summary.passes.reviewFeedbacks}`
  );
  if (summary.passes.reviewAttempts > 0) {
    log(`  Synthesis review attempts tracked: ${summary.passes.reviewAttempts}`);
  }
  log(
    `  Events: total=${summary.events.total} warnings=${summary.events.warningEvents} errors=${summary.events.errorEvents}`
  );
}

async function streamRunProgress({
  runId,
  store,
  startedAt,
  log,
  verbosity,
}: {
  runId: string;
  store: PostgresStore;
  startedAt: number;
  log: CliLog;
  verbosity: VerbosityLevel;
}) {
  const seenEvents = new Set<string>();
  let lastPhase = "";
  let lastSourceSummary = "";
  let lastCheckpoint = "";
  let lastHeartbeat = 0;

  const noisyEventTypes = new Set<string>([
    "search_query_started",
    "search_query_completed",
    "search_result_candidate",
    "source_fetch_started",
    "source_fetch_completed",
    "source_extract_started",
    "source_extract_completed",
  ]);

  const shouldPrintEvent = (event: DbRunEvent): boolean => {
    if (verbosity >= 3) return true;
    if (event.level === "debug") return false;
    if (verbosity <= 0) return event.level === "error";
    if (verbosity === 1) return event.level === "warn" || event.level === "error";
    if (noisyEventTypes.has(event.event_type) && event.level === "info") return false;
    return true;
  };

  while (true) {
    const [run, sources, events] = await Promise.all([
      store.getRun(runId) as Promise<DbRun | null>,
      store.listSources(runId) as Promise<DbSource[]>,
      store.listRunEvents(runId, { limit: verbosity >= 3 ? 200 : 500 }) as Promise<DbRunEvent[]>,
    ]);

    if (!run) return;
    const elapsed = formatElapsed(startedAt);
    const now = Date.now();
    const phase = run.phase ?? "queued";
    const sourceSummary = summarizeSources(sources);
    const checkpoint = summarizeCheckpoint(run.state);

    for (const event of [...events].reverse()) {
      if (seenEvents.has(event.id)) continue;
      seenEvents.add(event.id);
      if (!shouldPrintEvent(event)) continue;
      log(`[${elapsed}] ${eventLabel(event)}`);
    }

    if (verbosity >= 2 && phase !== lastPhase) {
      log(`[${elapsed}] Step: ${phase}`);
      lastPhase = phase;
    }

    if (verbosity >= 2 && sourceSummary !== lastSourceSummary) {
      log(`[${elapsed}] Sources: ${sourceSummary}`);
      lastSourceSummary = sourceSummary;
    }

    if (verbosity >= 2 && checkpoint !== lastCheckpoint) {
      log(`[${elapsed}] Counters: ${checkpoint}`);
      lastCheckpoint = checkpoint;
    }

    if (run.status !== "running" && run.status !== "queued") {
      if (verbosity >= 1 || run.status === "failed") {
        log(`[${elapsed}] Final status: ${run.status}`);
      }
      if (run.status === "failed") {
        log(`[${elapsed}] Hint: openresearch resume ${runId}`);
      }
      return;
    }

    if (verbosity >= 2 && now - lastHeartbeat > 60000) {
      const started = run.started_at ? ` started=${run.started_at}` : "";
      log(`[${elapsed}] Running${started} — ${phase} (${sourceSummary})`);
      lastHeartbeat = now;
    }

    await sleep(700);
  }
}

program
  .command("run")
  .description("Run the research pipeline locally (synchronous)")
  .argument("<prompt>", "Research prompt")
  .option("--debug-capture", "Enable Playwright debug capture (trace/html)", false)
  .option("--no-research-loop", "Disable the iterative research loop")
  .option("--debug-loop", "Print per-iteration research loop summaries", false)
  .option("--advanced", "Print intermediate artifact keys (advanced)", false)
  .option(
    "--verbosity <level>",
    "Verbosity level (0=silent, 1=stats, 2=default, 3=debug)",
    "2"
  )
  .action(
    async (
      prompt: string,
      opts: {
        debugCapture: boolean;
        researchLoop: boolean;
        debugLoop: boolean;
        advanced: boolean;
        verbosity: string;
      }
    ) => {
      const verbosity = coerceVerbosityLevel(opts.verbosity);
      const config = await loadConfig();
      const { store, objectStore, services } = await buildServices(config);
      let commandError: unknown = null;
      let pipelineLogWriter: RunLogWriter | null = null;
      try {
        const users = await store.listUsers();
        const admin =
          users.find((u) => u.role === "admin" && u.status === "active") ??
          (await store.createUser({
            role: "admin",
            email: "local@openresearch",
            policy: config.policies.defaultUserPolicy,
          }));

        const run = await store.createRun({
          userId: admin.id,
          prompt,
          citationPolicy: config.citationPolicy,
          budgets: config.budgets,
          modelConfig: config.models,
          adapterConfig: {
            searchBackend: config.search.backend,
            enablePlaywright: true,
            thinkingMode: config.policies.qualityProfiles.full.thinkingMode,
            debugCapture: opts.debugCapture,
            agenticLoop: config.policies.qualityProfiles.full.agenticLoop,
            synthesis: config.policies.qualityProfiles.full.synthesis,
            researchLoop: {
              ...config.policies.qualityProfiles.full.researchLoop,
              enabled: opts.researchLoop,
            },
          },
          qualityTier: "full",
        });
        pipelineLogWriter = createRunLogWriter({
          runId: run.id,
          objectStore,
        });
        if (verbosity >= 1) pipelineLogWriter.log(`Run ID: ${run.id}`);

        const pipelineInput: Parameters<typeof runResearchPipeline>[0] = {
          runId: run.id,
          config,
          services,
        };
        if (opts.debugCapture)
          pipelineInput.debugCapture = { enabled: true, reason: "cli --debug-capture" };

        const runStart = Date.now();
        await Promise.all(
          [
            runResearchPipeline(pipelineInput),
            verbosity >= 2
              ? streamRunProgress({
                  runId: run.id,
                  store,
                  startedAt: runStart,
                  log: pipelineLogWriter.log,
                  verbosity,
                })
              : null,
          ].filter(Boolean)
        );

        const md = await objectStore.getText(runOutputKey(run.id));
        if (md) pipelineLogWriter.write(md);

        const [finalRun, sources, events, modelCalls] = await Promise.all([
          store.getRun(run.id),
          store.listSources(run.id),
          store.listRunEvents(run.id, { limit: 1000 }),
          store.listModelCalls(run.id),
        ]);
        if (finalRun) {
          let verifiedClaims = 0;
          const citationMap = await objectStore.getJson(runCitationMapKey(run.id));
          if (citationMap && typeof citationMap === "object") {
            const claims = (citationMap as { claims?: unknown[] }).claims;
            if (Array.isArray(claims)) verifiedClaims = claims.length;
          }
          const summary = collectRunFinalStats({
            run: finalRun as DbRun,
            sources,
            events,
            modelCalls,
            verifiedClaims,
          });
          if (verbosity >= 1) printRunFinalStats({ summary, log: pipelineLogWriter.log });

          if (opts.debugLoop || opts.advanced) {
            const state = finalRun.state as unknown;
            const researchLoop =
              state && typeof state === "object" && !Array.isArray(state)
                ? ((state as { researchLoop?: unknown }).researchLoop as unknown)
                : undefined;

            const loopObject =
              researchLoop && typeof researchLoop === "object" && !Array.isArray(researchLoop)
                ? (researchLoop as Record<string, unknown>)
                : null;

            if (!loopObject) {
              pipelineLogWriter.log("\nResearch loop: not present in checkpoint state");
            } else {
              const enabled =
                typeof loopObject.enabled === "boolean" ? loopObject.enabled : undefined;
              const mode = typeof loopObject.mode === "string" ? loopObject.mode : "unknown";
              const modeSetting =
                typeof loopObject.modeSetting === "string" ? loopObject.modeSetting : "unknown";
              const stopReason =
                typeof loopObject.stopReason === "string" ? loopObject.stopReason : "unknown";
              const iterations = Array.isArray(loopObject.iterations)
                ? (loopObject.iterations as unknown[])
                : [];
              const iterationCountCompleted =
                typeof loopObject.iterationCountCompleted === "number" &&
                Number.isFinite(loopObject.iterationCountCompleted)
                  ? loopObject.iterationCountCompleted
                  : iterations.length;

              pipelineLogWriter.log(
                `\nResearch loop: enabled=${String(enabled)} modeSetting=${modeSetting} mode=${mode} stopReason=${stopReason} iterations=${iterationCountCompleted}`
              );

              for (const raw of iterations) {
                if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
                const it = raw as Record<string, unknown>;
                const iteration =
                  typeof it.iteration === "number" && Number.isFinite(it.iteration)
                    ? it.iteration
                    : 0;
                const itMode = typeof it.mode === "string" ? it.mode : "unknown";
                const netNewSources =
                  typeof it.netNewSources === "number" && Number.isFinite(it.netNewSources)
                    ? it.netNewSources
                    : 0;
                const reviewVerdict =
                  typeof it.reviewVerdict === "string" ? it.reviewVerdict : "unknown";
                const itStopReason = typeof it.stopReason === "string" ? it.stopReason : null;

                pipelineLogWriter.log(
                  `  [${iteration}] mode=${itMode} netNewSources=${netNewSources} review=${reviewVerdict}${
                    itStopReason ? ` stopReason=${itStopReason}` : ""
                  }`
                );

                const artifacts =
                  it.artifacts && typeof it.artifacts === "object" && !Array.isArray(it.artifacts)
                    ? (it.artifacts as Record<string, unknown>)
                    : null;
                const planKey =
                  artifacts && typeof artifacts.planKey === "string" ? artifacts.planKey : null;

                if (opts.debugLoop && planKey) {
                  const plan = await objectStore.getJson(planKey);
                  if (plan && typeof plan === "object" && !Array.isArray(plan)) {
                    const outputs = (plan as { outputs?: unknown }).outputs;
                    if (outputs && typeof outputs === "object" && !Array.isArray(outputs)) {
                      const out = outputs as Record<string, unknown>;
                      const nextQueries = Array.isArray(out.nextQueries)
                        ? (out.nextQueries as unknown[])
                            .filter((q) => typeof q === "string")
                            .slice(0, 6)
                        : [];
                      const nextTasks = Array.isArray(out.nextTasks)
                        ? (out.nextTasks as unknown[])
                            .filter((t) => typeof t === "string")
                            .slice(0, 6)
                        : [];
                      const notes = Array.isArray(out.planNotes)
                        ? (out.planNotes as unknown[])
                            .filter((n) => typeof n === "string")
                            .slice(0, 3)
                        : [];
                      pipelineLogWriter.log(
                        `    nextQueries: ${nextQueries.length ? nextQueries.join(" | ") : "n/a"}`
                      );
                        pipelineLogWriter.log(
                        `    nextTasks: ${nextTasks.length ? nextTasks.join(" | ") : "n/a"}`
                      );
                      if (notes.length)
                      pipelineLogWriter.log(`    planNotes: ${notes.join(" | ")}`);
                    }
                  }
                }

              if (opts.advanced && artifacts) {
                const keys: Array<[string, string]> = [];
                for (const [k, v] of Object.entries(artifacts)) {
                  if (typeof v === "string" && v.trim()) keys.push([k, v.trim()]);
                }
                  if (keys.length) {
                    pipelineLogWriter.log("    artifacts:");
                    for (const [k, v] of keys) pipelineLogWriter.log(`      ${k}: ${v}`);
                  }
                }
              }
            }
          }
        }
      } catch (error) {
        commandError = error;
      }
      if (pipelineLogWriter) {
        await pipelineLogWriter.flush();
      }
      await store.close();
      if (commandError !== null) {
        throw commandError;
      }
    }
  );

program
  .command("resume")
  .description("Resume a run from the last checkpoint (default: via API)")
  .argument("<runId>", "Run ID")
  .option("--local", "Resume by running the pipeline locally (no API call)", false)
  .option("--api-url <url>", "API base URL (or set OPENRESEARCH_API_URL)")
  .option("--api-key <key>", "API key (or set OPENRESEARCH_API_KEY)")
  .action(async (runId: string, opts: { local: boolean; apiUrl?: string; apiKey?: string }) => {
    const config = await loadConfig();

    if (opts.local) {
      const { store, services } = await buildServices(config);
      try {
        await runResearchPipeline({ runId, config, services });
        console.log(`Resumed locally: ${runId}`);
      } finally {
        await store.close();
      }
      return;
    }

    const baseUrl =
      (opts.apiUrl ?? process.env.OPENRESEARCH_API_URL ?? `http://127.0.0.1:${config.server.port}`).replace(
        /\/+$/,
        ""
      );
    const apiKey = opts.apiKey ?? process.env.OPENRESEARCH_API_KEY;
    if (!apiKey) {
      console.error("Missing API key. Provide --api-key or set OPENRESEARCH_API_KEY.");
      process.exitCode = 1;
      return;
    }

    const res = await fetch(`${baseUrl}/runs/${runId}/resume`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
    });

    const text = await res.text();
    const body = (() => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    })();

    if (!res.ok) {
      console.error(body);
      process.exitCode = 1;
      return;
    }

    const jobId =
      body && typeof body === "object" && !Array.isArray(body) && "jobId" in body ? (body as { jobId?: unknown }).jobId : null;
    console.log(jobId ? `Resume enqueued: ${runId} (jobId=${String(jobId)})` : `Resume requested: ${runId}`);
  });

program
  .command("explain")
  .description("Explain a run (status, events, artifacts)")
  .argument("<runId>", "Run ID")
  .action(async (runId: string) => {
    const config = await loadConfig();
    const store = new PostgresStore({ databaseUrl: config.postgres.url });
    await store.migrate();
    const objectStore = new FilesystemObjectStore({ rootPath: config.objectStore.rootPath });
    try {
      const run = await store.getRun(runId);
      if (!run) {
        console.error("Run not found");
        process.exitCode = 1;
        return;
      }

      const events = await store.listRunEvents(runId, { limit: 25 });
      const sources = await store.listSources(runId);
      const artifacts = await objectStore.list(`runs/${runId}`);

      console.log(
        JSON.stringify(
          { run, sourcesCount: sources.length, recentEvents: events, artifacts },
          null,
          2
        )
      );
    } finally {
      await store.close();
    }
  });

program
  .command("serve")
  .description("Start the API server")
  .action(async () => {
    const config = await loadConfig();
    const store = new PostgresStore({ databaseUrl: config.postgres.url });
    await store.migrate();
    const objectStore = new FilesystemObjectStore({ rootPath: config.objectStore.rootPath });
    const app = await buildApiServer({ config, store, objectStore });
    await app.listen({ port: config.server.port, host: config.server.host });
  });

program
  .command("worker")
  .description("Run the job worker loop")
  .option("--once", "Process at most one lease cycle", false)
  .action(async (opts: { once: boolean }) => {
    await runWorker({ once: opts.once });
  });

const admin = program.command("admin").description("Admin utilities (local)");

admin
  .command("create-user")
  .description("Create a user")
  .option("--email <email>", "Email (optional)")
  .option("--role <role>", "Role: admin|user", "user")
  .action(async (opts: { email?: string; role: "admin" | "user" }) => {
    const config = await loadConfig();
    const store = new PostgresStore({ databaseUrl: config.postgres.url });
    try {
      const input: { email?: string; role: "admin" | "user" } = { role: opts.role };
      if (opts.email) input.email = opts.email;
      const user = await store.createUser(input);
      console.log(user.id);
    } finally {
      await store.close();
    }
  });

admin
  .command("create-key")
  .description("Create an API key for a user")
  .requiredOption("--user <userId>", "User ID")
  .option("--label <label>", "Key label")
  .action(async (opts: { user: string; label?: string }) => {
    const config = await loadConfig();
    const store = new PostgresStore({ databaseUrl: config.postgres.url });
    try {
      const input: { userId: string; label?: string } = { userId: opts.user };
      if (opts.label) input.label = opts.label;
      const { apiKey } = await store.createApiKey(input);
      console.log(apiKey);
    } finally {
      await store.close();
    }
  });

program.parseAsync(process.argv);
