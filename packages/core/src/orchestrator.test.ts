import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
  runVerificationMarkdownKey,
  runVerificationJsonKey,
  sourceEvidenceKey,
  sourceRawBodyKey,
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

    if (user.includes('"reviewRequest"') || user.includes("Attack the report")) {
      return {
        text: JSON.stringify({
          verdict: "accept",
          unsupportedConclusions: [],
          missingEvidence: [],
          requestedRevisions: [],
        }),
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
                strengtheningAlternative:
                  "Track where each source confirms the mechanism separately.",
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
          refinementPass:
            typeof requestPayload.refinementPass === "number"
              ? requestPayload.refinementPass
              : undefined,
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
        summary: Array.from(
          { length: 80 },
          () =>
            "Synthesized conclusions for the two-source memo are consistent with observed system-level signals and long-form evidence collection."
        ).join(" "),
        sourceIndex: [
          {
            source: "S1",
            reliabilityAssessment: "High quality",
            rationale: "Primary source with direct telemetry.",
          },
          {
            source: "S2",
            reliabilityAssessment: "Secondary corroboration",
            rationale: "Cross-validates source framing.",
          },
          {
            source: "S3",
            reliabilityAssessment: "Additional corroboration",
            rationale: "Provides third-path validation.",
          },
        ],
        thematicSynthesis: [
          {
            theme: "Cross-source consistency",
            observation: "Both sources report overlapping signal behavior.",
            inference: "This suggests the effect is robust across contexts.",
            implication: "Adopt implementation practices that preserve the shared controls.",
            citations: [
              { source: "S1", quoteId: "Q1" },
              { source: "S2", quoteId: "Q1" },
            ],
          },
        ],
        keyFindings: Array.from({ length: 6 }, (_, i) => ({
          id: `F${i + 1}`,
          text: `Finding ${i + 1} based on both source families and aligned evidence path.`,
          citations: [
            { source: "S1", quoteId: "Q1" },
            { source: "S2", quoteId: "Q1" },
          ],
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

class RetryableSynthesisModelProvider implements ModelProvider {
  readonly name = "mock-retryable-synthesis";
  public requestCount = 0;

  private transientFailures: number;

  constructor(transientFailures = 2) {
    this.transientFailures = transientFailures;
  }

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

    let parsedUser: unknown = null;
    try {
      parsedUser = JSON.parse(user);
    } catch {
      parsedUser = null;
    }

    const parsedObject = parsedUser as Record<string, unknown> | null;
    const userSources =
      parsedObject && "sources" in parsedObject && Array.isArray(parsedObject.sources)
        ? (parsedObject.sources as unknown[])
        : [];

    if (
      typeof parsedUser === "object" &&
      parsedUser !== null &&
      "draft" in parsedUser &&
      "sources" in parsedUser
    ) {
      return {
        text: JSON.stringify({
          verdict: "accept",
          unsupportedConclusions: [],
          missingEvidence: [],
          requestedRevisions: [],
        }),
        usage: { inputTokens: 6, outputTokens: 12, costUsd: 0.01 },
        raw: { mock: true },
      };
    }

    if (
      parsedObject &&
      userSources.some((source) => {
        const sourceObject = source as Record<string, unknown>;
        return (
          sourceObject && typeof sourceObject === "object" && "methodologicalCue" in sourceObject
        );
      }) &&
      this.transientFailures > 0
    ) {
      this.transientFailures -= 1;
      throw new Error("Transient failure generating source abstracts");
    }

    if (user.includes("keyFindings") || user.includes('"sources"') || user.includes("summary")) {
      if (this.transientFailures > 0) {
        this.transientFailures -= 1;
        throw new Error("Transient failure during synthesis");
      }

      return {
        text: JSON.stringify({
          summary: "Summary based on sources after retries.",
          keyFindings: [
            {
              id: "F1",
              text: "Retry-enabled synthesis grounded in extracted source evidence.",
              citations: [{ source: "S1", quoteId: "Q1" }],
            },
          ],
          unknowns: [],
        }),
        usage: { inputTokens: 31, outputTokens: 50, costUsd: 0.02 },
        raw: { mock: true },
      };
    }

    throw new Error(`Unhandled retryable mock model request: ${user.slice(0, 80)}`);
  }
}

type RetryableStepName = "plan" | "sourceAbstracts" | "synthesis" | "review";

class AllStepRetryableModelProvider implements ModelProvider {
  readonly name = "mock-all-step-retry";
  public requestCount = 0;
  public planCallCount = 0;
  public sourceAbstractCallCount = 0;
  public synthesisCallCount = 0;
  public reviewCallCount = 0;

  private readonly remainingFailures: Record<RetryableStepName, number>;

  constructor(failures: Partial<Record<RetryableStepName, number>> = {}) {
    this.remainingFailures = {
      plan: 0,
      sourceAbstracts: 0,
      synthesis: 0,
      review: 0,
      ...failures,
    };
  }

  private parseRequest(content: string): unknown {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private classifyStep(req: Parameters<ModelProvider["chat"]>[0]): {
    step: RetryableStepName;
    parsed: unknown;
  } {
    const user = req.messages.find((m) => m.role === "user")?.content ?? "";
    if (user.includes("Generate a research plan")) {
      return { step: "plan", parsed: null };
    }

    const parsed = this.parseRequest(user);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "reviewRequest" in parsed
    ) {
      return { step: "review", parsed };
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "sources" in parsed &&
      Array.isArray((parsed as { sources?: unknown }).sources)
    ) {
      const sources = (parsed as { sources?: Array<Record<string, unknown>> }).sources ?? [];
      const hasMethodologicalCue = sources.some(
        (source) => source && typeof source === "object" && "methodologicalCue" in source
      );
      if (hasMethodologicalCue) {
        return { step: "sourceAbstracts", parsed };
      }
      return { step: "synthesis", parsed };
    }

    if (user.includes("Attack the report")) {
      return { step: "review", parsed };
    }

    return { step: "synthesis", parsed };
  }

  private buildSourceAbstractResponse(parsed: unknown) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { sourceAbstracts: [], synthesisNotes: [] };
    }

    const sources =
      ((parsed as Record<string, unknown>).sources as Array<Record<string, unknown>> | undefined) ??
      [];
    return {
      sourceAbstracts: sources
        .filter((source): source is Record<string, unknown> => source && typeof source === "object")
        .map((source, index) => ({
          source: typeof source.source === "string" ? source.source : `S${index + 1}`,
          methodology: "Primary extraction and normalization from source excerpt",
          temporalContext: "Current era evidence with historical comparators.",
          stakeholderPosition: "Producer and regulatory ecosystem signals were both observed.",
          dataTypes: ["empirical", "descriptive"],
          representativeClaims: [
            "This source supports deployment outcomes under reported constraints.",
          ],
          keyConstraints: ["Methodological metadata is partial in prompt payload."],
        })),
      synthesisNotes: [
        `Abstracted ${sources.length} source payload objects for synthesis compression.`,
      ],
    };
  }

  private buildSynthesisResponse() {
    return {
      summary:
        "Cross-source evidence synthesis confirms long-tail system behavior, while also identifying the operational constraints that can invert expected performance if unaddressed in design assumptions and portfolio strategy planning. "
          .repeat(18)
          .trim(),
      keyFindings: Array.from({ length: 6 }, (_, index) => ({
        id: `F${index + 1}`,
        text: `Finding ${index + 1} links method, deployment, and reliability assumptions across source families under the same workload constraints.`,
        citations: [
          { source: "S1", quoteId: "Q1" },
          { source: "S2", quoteId: "Q1" },
        ],
      })),
      unknowns: [
        "Further disaggregation by market segment and geography would improve robustness.",
      ],
      recommendations: [
        "Preserve redundancy across source families when drawing cross-domain inference.",
        "Prioritize sensitivity analysis around missing mechanism evidence in deployment forecasts.",
        "Align procurement criteria to include verified performance persistence under high-load conditions.",
        "Track operational deltas between testbench conditions and production environments.",
      ],
      contradictions: ["No major contradiction was observed among the current source set."],
      sourceIndex: [
        { source: "S1", reliabilityAssessment: "Primary report with direct operational metrics." },
        {
          source: "S2",
          reliabilityAssessment: "Supplemental source with policy and deployment framing.",
        },
      ],
      thematicSynthesis: [
        {
          theme: "Method-performance coupling",
          observation:
            "Sources consistently report deployment speed and outcomes correlate with assumptions.",
          inference: "Coupling suggests hidden constraints become dominant at scale.",
          implication: "Build margin for operational variance in planning assumptions.",
          citations: [
            { source: "S1", quoteId: "Q1" },
            { source: "S2", quoteId: "Q1" },
          ],
        },
      ],
      negativeSpace: {
        missingLinks: ["Missing stress testing during extreme weather states."],
        unaskedQuestions: ["What constraints collapse under compound shocks?"],
        temporalBlindspots: ["Need refreshed evidence for post-policy-shift conditions."],
      },
      confidenceAppendix: [
        {
          type: "INFERRED",
          statement:
            "Observed cross-source patterns suggest hidden coupling between deployment scale and quality controls.",
          alternativeInterpretations: [
            "Observed couplings could reflect omitted sample-selection bias.",
            "Results may be dominated by one sector with unusual governance exposure.",
          ],
          evidenceNotes:
            "The inferences are synthesized from aligned source families that still leave measurement variance.",
        },
      ],
    };
  }

  async chat(req: Parameters<ModelProvider["chat"]>[0]) {
    this.requestCount += 1;
    const { step, parsed } = this.classifyStep(req);

    if (step === "plan") {
      this.planCallCount += 1;
      if (this.remainingFailures.plan > 0) {
        this.remainingFailures.plan -= 1;
        throw new Error("Transient plan LLM failure");
      }
      return {
        text: JSON.stringify({
          subquestions: ["Plan for system constraints."],
          queries: ["query for source quality constraints", "query for deployment assumptions"],
          followUpTasks: ["expand evidence for review pathways", "validate counterfactuals"],
          continuePlanning: false,
        }),
        usage: { inputTokens: 8, outputTokens: 10, costUsd: 0.01 },
        raw: { mock: true },
      };
    }

    if (step === "sourceAbstracts") {
      this.sourceAbstractCallCount += 1;
      if (this.remainingFailures.sourceAbstracts > 0) {
        this.remainingFailures.sourceAbstracts -= 1;
        throw new Error("Transient source abstract LLM failure");
      }
      const response = this.buildSourceAbstractResponse(parsed);
      return {
        text: JSON.stringify(response),
        usage: { inputTokens: 12, outputTokens: 14, costUsd: 0.02 },
        raw: { mock: true },
      };
    }

    if (step === "review") {
      this.reviewCallCount += 1;
      if (this.remainingFailures.review > 0) {
        this.remainingFailures.review -= 1;
        throw new Error("Transient review LLM failure");
      }
      return {
        text: JSON.stringify({
          verdict: "accept",
          unsupportedConclusions: [],
          missingEvidence: [],
          requestedRevisions: [],
        }),
        usage: { inputTokens: 11, outputTokens: 16, costUsd: 0.02 },
        raw: { mock: true },
      };
    }

    this.synthesisCallCount += 1;
    if (this.remainingFailures.synthesis > 0) {
      this.remainingFailures.synthesis -= 1;
      throw new Error("Transient synthesis LLM failure");
    }

    return {
      text: JSON.stringify(this.buildSynthesisResponse()),
      usage: { inputTokens: 32, outputTokens: 120, costUsd: 0.03 },
      raw: { mock: true },
    };
  }
}

class InvalidSourceAbstractJsonModelProvider implements ModelProvider {
  readonly name = "mock-invalid-source-abstract-json";
  public planCallCount = 0;
  public sourceAbstractCallCount = 0;
  public synthesisCallCount = 0;
  public reviewCallCount = 0;

  private parseRequest(content: string): unknown {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async chat(req: Parameters<ModelProvider["chat"]>[0]) {
    const user = req.messages.find((m) => m.role === "user")?.content ?? "";

    if (user.includes("Generate a research plan")) {
      this.planCallCount += 1;
      return {
        text: JSON.stringify({
          subquestions: ["Plan for invalid source abstract JSON."],
          queries: ["query for source abstract failure coverage"],
          followUpTasks: [],
          continuePlanning: false,
        }),
        usage: { inputTokens: 8, outputTokens: 10, costUsd: 0.01 },
        raw: { mock: true },
      };
    }

    const parsed = this.parseRequest(user);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "reviewRequest" in parsed) {
      this.reviewCallCount += 1;
      return {
        text: JSON.stringify({
          verdict: "accept",
          unsupportedConclusions: [],
          missingEvidence: [],
          requestedRevisions: [],
        }),
        usage: { inputTokens: 11, outputTokens: 16, costUsd: 0.02 },
        raw: { mock: true },
      };
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "sources" in parsed &&
      Array.isArray((parsed as { sources?: unknown }).sources)
    ) {
      const sources = (parsed as { sources?: Array<Record<string, unknown>> }).sources ?? [];
      const hasMethodologicalCue = sources.some(
        (source) => source && typeof source === "object" && "methodologicalCue" in source
      );
      if (hasMethodologicalCue) {
        this.sourceAbstractCallCount += 1;
        return {
          text:
            "**Source Summary**\n\n**Source S1**\n- Methodology: summarized from excerpt\n- Temporal context: described in snippet\n\n(continuing in markdown; not JSON)",
          usage: { inputTokens: 12, outputTokens: 14, costUsd: 0.02 },
          raw: { mock: true },
        };
      }

      this.synthesisCallCount += 1;
      return {
        text: JSON.stringify({
          summary: "Synthesis succeeds even if source abstract JSON is invalid.",
          keyFindings: [
            {
              id: "F1",
              text: "Key finding grounded in S1 evidence.",
              citations: [{ source: "S1", quoteId: "Q1" }],
            },
          ],
          unknowns: [],
        }),
        usage: { inputTokens: 32, outputTokens: 120, costUsd: 0.03 },
        raw: { mock: true },
      };
    }

    throw new Error(`Unhandled invalid-source-abstract mock request: ${user.slice(0, 80)}`);
  }
}

class ExhaustedSynthesisRefinementModelProvider implements ModelProvider {
  readonly name = "mock-synthesis-refinement-exhausted";
  public synthCallCount = 0;
  public reviewCallCount = 0;

  private readonly poorSummary = Array.from(
    { length: 340 },
    () => "Source-driven synthesis remains partial"
  ).join(" ");

  async chat(req: Parameters<ModelProvider["chat"]>[0]) {
    const user = req.messages.find((m) => m.role === "user")?.content ?? "";

    if (user.includes("Generate a research plan")) {
      return {
        text: JSON.stringify({ subquestions: [], queries: ["example query"] }),
        usage: { inputTokens: 6, outputTokens: 10, costUsd: 0.01 },
        raw: { mock: true },
      };
    }

    if (user.includes("Attack the report")) {
      this.reviewCallCount += 1;
      return {
        text: JSON.stringify({
          verdict: "revise",
          unsupportedConclusions: [
            {
              findingId: "F1",
              issue: "The conclusion overclaims transferability from a single source family.",
              why: "Evidence is clustered and misses contradictory framing from a second source family.",
              strengtheningAlternative:
                "Split this claim into source-specific conditions and add divergence framing.",
            },
          ],
          missingEvidence: [
            "Need independent corroboration for the claimed causal mechanism in a second source family.",
          ],
          requestedRevisions: [
            "Add at least one claim supported by disjoint evidence pathways and separate causal inference by source family.",
          ],
        }),
        usage: { inputTokens: 12, outputTokens: 18, costUsd: 0.03 },
        raw: { mock: true },
      };
    }

    this.synthCallCount += 1;
    return {
      text: JSON.stringify({
        summary: this.poorSummary,
        keyFindings: [
          {
            id: "F1",
            text: "Source A appears to indicate early-stage signal.",
            citations: [{ source: "S1", quoteId: "Q1" }],
          },
          {
            id: "F2",
            text: "Source B suggests a parallel but narrow operational pattern.",
            citations: [{ source: "S2", quoteId: "Q1" }],
          },
        ],
        contradictions: ["Findings are not robustly separated across sources."],
        recommendations: [
          "Collect additional independent source coverage before synthesis conclusions.",
        ],
        unknowns: ["Refinement still cannot establish broad causal coverage."],
        sourceIndex: [
          { source: "S1", reliabilityAssessment: "Narrow and source-specific context." },
          { source: "S2", reliabilityAssessment: "Narrow and source-specific context." },
        ],
      }),
      usage: { inputTokens: 24, outputTokens: 160, costUsd: 0.05 },
      raw: { mock: true },
    };
  }
}

type RetryAwareFailureMode = "none" | "empty" | "invalid-json";

class RetryAwareModelProvider implements ModelProvider {
  readonly name = "mock-retry-aware";
  public requestCount = 0;
  public planCallCount = 0;
  public sourceAbstractCallCount = 0;
  public synthesisCallCount = 0;
  public reviewCallCount = 0;
  public seenMaxTokens: Array<number | undefined> = [];
  public seenPhases: string[] = [];
  public seenOutputTokensByPhase: Array<{
    phase: "plan" | "sourceAbstracts" | "synthesis" | "review";
    maxTokens: number | undefined;
  }> = [];

  private readonly failureMode: RetryAwareFailureMode;

  constructor(failureMode: RetryAwareFailureMode = "none") {
    this.failureMode = failureMode;
  }

  private parseRequest(content: string): unknown {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private classify(req: Parameters<ModelProvider["chat"]>[0]): "plan" | "sourceAbstracts" | "synthesis" | "review" {
    const user = req.messages.find((m) => m.role === "user")?.content ?? "";

    if (user.includes("Generate a research plan")) {
      return "plan";
    }

    const parsed = this.parseRequest(user);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "reviewRequest" in (parsed as Record<string, unknown>)
    ) {
      return "review";
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "sources" in (parsed as Record<string, unknown>)
    ) {
      const sources = (parsed as { sources?: Array<Record<string, unknown>> }).sources ?? [];
      const hasMethodologicalCue = sources.some(
        (source) => source && typeof source === "object" && "methodologicalCue" in source
      );
      if (hasMethodologicalCue) return "sourceAbstracts";
    }

    return "synthesis";
  }

  async chat(req: Parameters<ModelProvider["chat"]>[0]) {
    this.requestCount += 1;
    const phase = this.classify(req);
    this.seenPhases.push(phase);
    this.seenMaxTokens.push(req.maxTokens);
    this.seenOutputTokensByPhase.push({ phase, maxTokens: req.maxTokens });

    const sourceText =
      "Synthesis evidence demonstrates multi-source overlap and controlled uncertainty around method boundaries.";
    const output = (prefix: string) =>
      `${prefix} across cited source families with transparent confidence and explicit uncertainty bounds.`;

    if (phase === "plan") {
      this.planCallCount += 1;
      return {
        text: JSON.stringify({
          subquestions: ["First plan item"],
          queries: ["synthesis source plan query"],
          followUpTasks: [],
          continuePlanning: false,
        }),
        usage: { inputTokens: 8, outputTokens: 10, costUsd: 0.01 },
        raw: { mock: true },
      };
    }

    if (phase === "sourceAbstracts") {
      this.sourceAbstractCallCount += 1;
      return {
        text: JSON.stringify({
          sourceAbstracts: [
            {
              source: "S1",
              methodology: "Structured evidence summary from source claims.",
              temporalContext: "Primary and follow-on updates are included.",
              dataTypes: ["observational", "analytical"],
              stakeholderPosition: "Policy and operator viewpoints were both represented.",
              representativeClaims: ["Cross-source checks constrain over-confidence."],
              keyConstraints: ["Inference quality is limited by context noise."],
            },
          ],
          synthesisNotes: ["Source abstracts were synthesized from extraction summaries."],
        }),
        usage: { inputTokens: 12, outputTokens: 14, costUsd: 0.02 },
        raw: { mock: true },
      };
    }

    if (phase === "review") {
      this.reviewCallCount += 1;
      return {
        text: JSON.stringify({
          verdict: "accept",
          unsupportedConclusions: [],
          missingEvidence: [],
          requestedRevisions: [],
        }),
        usage: { inputTokens: 11, outputTokens: 16, costUsd: 0.02 },
        raw: { mock: true },
      };
    }

    this.synthesisCallCount += 1;
    if (this.failureMode === "empty" && this.synthesisCallCount === 1) {
      return {
        text: "   ",
        usage: { inputTokens: 31, outputTokens: 0, costUsd: 0.02 },
        raw: { mock: true, failureMode: this.failureMode },
      };
    }

    if (this.failureMode === "invalid-json" && this.synthesisCallCount === 1) {
      return {
        text: "Not valid JSON for this synthesis request.",
        usage: { inputTokens: 31, outputTokens: 0, costUsd: 0.02 },
        raw: { mock: true, failureMode: this.failureMode },
      };
    }

    return {
      text: JSON.stringify({
        summary: output(sourceText),
        keyFindings: [
          {
            id: "F1",
            text: `${sourceText} (${sourceText.length} chars)`,
            citations: [{ source: "S1", quoteId: "Q1" }],
          },
        ],
        unknowns: [],
      }),
      usage: { inputTokens: 31, outputTokens: 50, costUsd: 0.02 },
      raw: { mock: true },
    };
  }
}

class LegacyPayloadCompatModelProvider implements ModelProvider {
  readonly name = "mock-legacy-compat";
  private reviewLegacyUsed = false;

  constructor(
    private readonly legacySourceAbstract = false,
    private readonly legacyReview = false,
    private readonly stringDataTypes = false
  ) {}

  private parseRequest(content: string): unknown {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private classify(req: Parameters<ModelProvider["chat"]>[0]): "plan" | "sourceAbstracts" | "synthesis" | "review" {
    const user = req.messages.find((m) => m.role === "user")?.content ?? "";
    if (user.includes("Generate a research plan")) return "plan";

    const parsed = this.parseRequest(user);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "reviewRequest" in (parsed as Record<string, unknown>)
    ) {
      return "review";
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "sources" in (parsed as Record<string, unknown>)
    ) {
      const sources = (parsed as { sources?: Array<Record<string, unknown>> }).sources ?? [];
      const hasMethodologicalCue = sources.some(
        (source) => source && typeof source === "object" && "methodologicalCue" in source
      );
      if (hasMethodologicalCue) return "sourceAbstracts";
    }

    return "synthesis";
  }

  async chat(req: Parameters<ModelProvider["chat"]>[0]) {
    const step = this.classify(req);

    if (step === "sourceAbstracts" && this.legacySourceAbstract) {
      return {
        text: JSON.stringify({
          synthesis: [
            {
              sourceId: "S1",
              methodology: "Legacy source abstract payload with sourceId field.",
              temporalContext: "Historical and contemporary sources over time.",
              stakeholderPosition: "Derived from mixed reporting stakeholders.",
              representativeClaims: ["Evidence is strongest in operational summaries."],
              keyConstraints: ["Constraints were inferred from source labels only."],
            },
          ],
          synthesisNotes: ["Legacy source abstract variant was normalized."],
        }),
        usage: { inputTokens: 12, outputTokens: 20, costUsd: 0.02 },
        raw: { mock: true },
      };
    }

    if (step === "sourceAbstracts") {
      const sourceAbstractDataTypes = this.stringDataTypes
        ? "Tax credit percentages, certification requirements (SRCC), eligibility exclusions"
        : ["observational", "analytical"];

      return {
        text: JSON.stringify({
          sourceAbstracts: [
            {
              source: "S1",
              methodology: "Structured evidence summary from source claims.",
              temporalContext: "Primary and follow-on updates are included.",
              dataTypes: sourceAbstractDataTypes,
              stakeholderPosition: "Policy and operator viewpoints were both represented.",
              representativeClaims: ["Cross-source checks constrain over-confidence."],
              keyConstraints: ["Inference quality is limited by context noise."],
            },
          ],
          synthesisNotes: ["Source abstracts were synthesized from extraction summaries."],
        }),
        usage: { inputTokens: 12, outputTokens: 14, costUsd: 0.02 },
        raw: { mock: true },
      };
    }

    if (step === "review") {
      if (this.legacyReview && !this.reviewLegacyUsed) {
        this.reviewLegacyUsed = true;
        return {
          text: JSON.stringify({
            summaryIssues: [
              {
                id: "legacy-1",
                sentence: "Conclusion appears unsupported by explicit source triangulation.",
                details: "One source overstates cross-source generalization.",
                suggestedRevision: "Ground this claim in a second source family.",
              },
            ],
            keyFindingsIssues: [],
            recommendationsIssues: [
              { text: "Add explicit corroboration from a second source family." },
            ],
          }),
          usage: { inputTokens: 11, outputTokens: 16, costUsd: 0.02 },
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
        usage: { inputTokens: 11, outputTokens: 16, costUsd: 0.02 },
        raw: { mock: true },
      };
    }

    return {
      text: JSON.stringify({
        summary:
          "Cross-source evidence synthesis remains stable after compatibility normalization and review pass-through.",
        keyFindings: [
          {
            id: "F1",
            text: "Compatibility handling succeeded with constrained source evidence.",
            citations: [{ source: "S1", quoteId: "Q1" }],
          },
        ],
        unknowns: [],
      }),
      usage: { inputTokens: 31, outputTokens: 48, costUsd: 0.02 },
      raw: { mock: true },
    };
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
              agenticLoop: { maxPlanPasses: 5, maxFollowUpTasksPerPass: 10 },
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
              agenticLoop: { maxPlanPasses: 5, maxFollowUpTasksPerPass: 10 },
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
      async fetch(url: string) {
        return { ok: false as const, url, status: 500, error: "mock fetch failure" };
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
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
              agenticLoop: {
                maxPlanPasses: 5,
                maxFollowUpTasksPerPass: 10,
              },
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
      async fetch(url: string) {
        return { ok: false as const, url, status: 500, error: "mock fetch failure" };
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
              agenticLoop: { maxPlanPasses: 5, maxFollowUpTasksPerPass: 10 },
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
              agenticLoop: { maxPlanPasses: 5, maxFollowUpTasksPerPass: 10 },
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
      async fetch(url: string) {
        return { ok: false as const, url, status: 500, error: "mock fetch failure" };
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
              agenticLoop: { maxPlanPasses: 5, maxFollowUpTasksPerPass: 10 },
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
              agenticLoop: { maxPlanPasses: 5, maxFollowUpTasksPerPass: 10 },
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
    expect(
      (todoEvent?.data as { passCount?: number; maxPlanPasses?: number } | null)?.passCount
    ).toBe(1);
  }, 60_000);

  it("passes synthesis output caps and trims oversized source context", async () => {
    const user = await store!.createUser({ role: "user" });
    const run = await store!.createRun({
      userId: user.id,
      prompt: "Large context test",
      budgets: {
        maxRuntimeMs: 60_000,
      maxSources: 9,
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
      maxSources: 9,
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
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
              agenticLoop: { maxPlanPasses: 5, maxFollowUpTasksPerPass: 10 },
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
          async fetch(url: string) {
            return { ok: false as const, url, status: 500, error: "mock fetch failure" };
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

  it("normalizes low token budgets to the minimum 8,000 before all model calls", async () => {
    const user = await store!.createUser({ role: "user" });
    const run = await store!.createRun({
      userId: user.id,
      prompt: "Token floor regression coverage",
      budgets: {
        maxRuntimeMs: 60_000,
        maxSources: 10,
        maxFetches: 0,
        maxBrowserRenders: 0,
        fetchConcurrency: 1,
        extractConcurrency: 1,
      },
      modelConfig: {
        planner: "mock/planner",
        synthesizer: "mock/retry-aware",
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

    const sourceUrls = Array.from({ length: 9 }, (_, i) => `https://example.com/token-floor-${i + 1}`);
    const objectStore = new FilesystemObjectStore({ rootPath: objectStoreRoot! });
    for (const url of sourceUrls) {
      const source = await store!.createSource({ runId: run.id, url });
      const evidence = {
        contentText: "Source text discussing policy and operational context ".repeat(20),
        metadata: { title: `Source ${source.id}`, publisher: "Example", authors: [], publishedAt: null },
        quotes: [
          {
            text: "Source text discussing policy and operational context.",
            start: 0,
            end: 54,
          },
        ],
        chunks: [{ start: 0, end: 54, text: "Source text discussing policy and operational context." }],
      };
      await store!.updateSource({
        sourceId: source.id,
        status: "extracted",
        finalUrl: url,
        title: `Source ${source.id}`,
        publisher: "Example",
        extractKey: sourceEvidenceKey(run.id, source.id),
      });
      await objectStore.putJson(sourceEvidenceKey(run.id, source.id), evidence);
    }

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

    const modelProvider = new RetryAwareModelProvider("none");
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
          synthesizer: "mock/retry-aware",
          verifier: "mock/verify",
          verifierStrong: "mock/verify-strong",
        },
        budgets: {
          maxRuntimeMs: 60_000,
          maxSources: 10,
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
                synthesizer: "mock/retry-aware",
                verifier: "mock/verify",
                verifierStrong: "mock/verify-strong",
              },
              budgets: {},
              enablePlaywright: false,
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              agenticLoop: { maxPlanPasses: 1, maxFollowUpTasksPerPass: 10 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
            },
            degraded: {
              name: "degraded",
              searchBackend: "searxng",
              thinkingMode: "low",
              models: {
                planner: "mock/planner",
                synthesizer: "mock/retry-aware",
                verifier: "mock/verify",
                verifierStrong: "mock/verify-strong",
              },
              budgets: {},
              enablePlaywright: false,
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              agenticLoop: { maxPlanPasses: 5, maxFollowUpTasksPerPass: 10 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
          async fetch(url: string) {
            return { ok: false as const, url, status: 500, error: "mock fetch failure" };
          },
        },
        modelProvider,
      },
    });

    const finalRun = await store!.getRun(run.id);
    expect(finalRun?.status).toBe("completed");
    expect(modelProvider.sourceAbstractCallCount).toBeGreaterThanOrEqual(1);
    expect(modelProvider.reviewCallCount).toBeGreaterThanOrEqual(1);

    const sourceAbstractTokens = modelProvider.seenOutputTokensByPhase
      .filter((item) => item.phase === "sourceAbstracts")
      .map((item) => item.maxTokens);
    const reviewTokens = modelProvider.seenOutputTokensByPhase
      .filter((item) => item.phase === "review")
      .map((item) => item.maxTokens);
    const synthTokens = modelProvider.seenOutputTokensByPhase
      .filter((item) => item.phase === "synthesis")
      .map((item) => item.maxTokens);

    expect(sourceAbstractTokens).toContain(8000);
    expect(reviewTokens).toContain(8000);
    expect(synthTokens[0]).toBeGreaterThanOrEqual(8000);

    const modelCalls = await store!.listModelCalls(run.id);
    const synthCalls = modelCalls.filter((modelCall) => modelCall.phase === "synthesize");
    const personas = synthCalls
      .map((modelCall) => {
        const params = (modelCall.params as Record<string, unknown> | null) ?? {};
        return typeof params.persona === "string" ? params.persona : undefined;
      })
      .filter((persona): persona is string => typeof persona === "string");
    expect(personas).toContain("synthesis-source-compression");
    expect(personas).toContain("synthesis-review");
    expect(personas).toContain("synthesis-writing");
  }, 120_000);

  it("retries once when model output is empty and then succeeds", async () => {
    const user = await store!.createUser({ role: "user" });
    const run = await store!.createRun({
      userId: user.id,
      prompt: "Retry synthesis after an empty model response",
      budgets: {
        maxRuntimeMs: 60_000,
        maxSources: 9,
        maxFetches: 0,
        maxBrowserRenders: 0,
        fetchConcurrency: 1,
        extractConcurrency: 1,
      },
      modelConfig: {
        planner: "mock/planner",
        synthesizer: "mock/retry-aware",
        verifier: "mock/verify",
        verifierStrong: "mock/verify-strong",
      },
    });

    const source = await store!.createSource({
      runId: run.id,
      url: "https://example.com/retry-empty",
    });
    await store!.updateSource({
      sourceId: source.id,
      status: "extracted",
      finalUrl: "https://example.com/retry-empty",
      title: "Retry Empty Source",
      publisher: "Example",
      extractKey: sourceEvidenceKey(run.id, source.id),
    });

    const objectStore = new FilesystemObjectStore({ rootPath: objectStoreRoot! });
    await objectStore.putJson(sourceEvidenceKey(run.id, source.id), {
      contentText: "A robust synthesis requires multiple independent evidence points.",
      metadata: {
        title: "Retry Empty Source",
        publisher: "Example",
        authors: [],
        publishedAt: null,
      },
      quotes: [
        {
          text: "A robust synthesis requires multiple independent evidence points.",
          start: 0,
          end: 66,
        },
      ],
      chunks: [
        {
          start: 0,
          end: 66,
          text: "A robust synthesis requires multiple independent evidence points.",
        },
      ],
    });

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

    const modelProvider = new RetryAwareModelProvider("empty");

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
          synthesizer: "mock/retry-aware",
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
                synthesizer: "mock/retry-aware",
                verifier: "mock/verify",
                verifierStrong: "mock/verify-strong",
              },
              budgets: {},
              enablePlaywright: false,
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              agenticLoop: { maxPlanPasses: 1, maxFollowUpTasksPerPass: 10 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
            },
            degraded: {
              name: "degraded",
              searchBackend: "searxng",
              thinkingMode: "low",
              models: {
                planner: "mock/planner",
                synthesizer: "mock/retry-aware",
                verifier: "mock/verify",
                verifierStrong: "mock/verify-strong",
              },
              budgets: {},
              enablePlaywright: false,
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              agenticLoop: { maxPlanPasses: 5, maxFollowUpTasksPerPass: 10 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
          async fetch(url: string) {
            return { ok: false as const, url, status: 500, error: "mock fetch failure" };
          },
        },
        modelProvider,
      },
    });

    const finalRun = await store!.getRun(run.id);
    expect(finalRun?.status).toBe("completed");
    expect(modelProvider.synthesisCallCount).toBeGreaterThanOrEqual(2);

    const events = await store!.listRunEvents(run.id, { limit: 200 });
    expect(
      events.some(
        (event) =>
          event.event_type === "model_call_retry" &&
          String((event.data as { errorMessage?: unknown } | null)?.errorMessage ?? "").includes(
            "Empty model response"
          )
      )
    ).toBe(true);
  }, 120_000);

  it("retries on malformed JSON and succeeds with valid JSON on retry", async () => {
    const user = await store!.createUser({ role: "user" });
    const run = await store!.createRun({
      userId: user.id,
      prompt: "Retry synthesis after malformed JSON",
      budgets: {
        maxRuntimeMs: 60_000,
        maxSources: 9,
        maxFetches: 0,
        maxBrowserRenders: 0,
        fetchConcurrency: 1,
        extractConcurrency: 1,
      },
      modelConfig: {
        planner: "mock/planner",
        synthesizer: "mock/retry-aware",
        verifier: "mock/verify",
        verifierStrong: "mock/verify-strong",
      },
    });

    const source = await store!.createSource({
      runId: run.id,
      url: "https://example.com/retry-malformed",
    });
    await store!.updateSource({
      sourceId: source.id,
      status: "extracted",
      finalUrl: "https://example.com/retry-malformed",
      title: "Retry Malformed Source",
      publisher: "Example",
      extractKey: sourceEvidenceKey(run.id, source.id),
    });

    const objectStore = new FilesystemObjectStore({ rootPath: objectStoreRoot! });
    await objectStore.putJson(sourceEvidenceKey(run.id, source.id), {
      contentText: "Synthesis can fail on the first JSON parse and then recover.",
      metadata: {
        title: "Retry Malformed Source",
        publisher: "Example",
        authors: [],
        publishedAt: null,
      },
      quotes: [
        {
          text: "Synthesis can fail on the first JSON parse and then recover.",
          start: 0,
          end: 62,
        },
      ],
      chunks: [
        {
          start: 0,
          end: 62,
          text: "Synthesis can fail on the first JSON parse and then recover.",
        },
      ],
    });

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

    const modelProvider = new RetryAwareModelProvider("invalid-json");

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
          synthesizer: "mock/retry-aware",
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
                synthesizer: "mock/retry-aware",
                verifier: "mock/verify",
                verifierStrong: "mock/verify-strong",
              },
              budgets: {},
              enablePlaywright: false,
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              agenticLoop: { maxPlanPasses: 1, maxFollowUpTasksPerPass: 10 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
            },
            degraded: {
              name: "degraded",
              searchBackend: "searxng",
              thinkingMode: "low",
              models: {
                planner: "mock/planner",
                synthesizer: "mock/retry-aware",
                verifier: "mock/verify",
                verifierStrong: "mock/verify-strong",
              },
              budgets: {},
              enablePlaywright: false,
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              agenticLoop: { maxPlanPasses: 5, maxFollowUpTasksPerPass: 10 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
          async fetch(url: string) {
            return { ok: false as const, url, status: 500, error: "mock fetch failure" };
          },
        },
        modelProvider,
      },
    });

    const finalRun = await store!.getRun(run.id);
    expect(finalRun?.status).toBe("completed");
    expect(modelProvider.synthesisCallCount).toBeGreaterThanOrEqual(2);
    const events = await store!.listRunEvents(run.id, { limit: 200 });
    expect(
      events.some(
        (event) => event.event_type === "model_call_retry" && event.data && typeof event.data === "object"
      )
    ).toBe(true);

    const md = await objectStore.getText(runOutputKey(run.id));
    expect(md).toBeTruthy();
  }, 120_000);

  it("persists required model-call metadata including retry attempt", async () => {
    const user = await store!.createUser({ role: "user" });
    const run = await store!.createRun({
      userId: user.id,
      prompt: "Persist model call metadata for retry inspection",
      budgets: {
        maxRuntimeMs: 60_000,
        maxSources: 9,
        maxFetches: 0,
        maxBrowserRenders: 0,
        fetchConcurrency: 1,
        extractConcurrency: 1,
      },
      modelConfig: {
        planner: "mock/planner",
        synthesizer: "mock/retry-aware",
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
        synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
      },
    });

    const source = await store!.createSource({
      runId: run.id,
      url: "https://example.com/metadata-source",
    });
    await store!.updateSource({
      sourceId: source.id,
      status: "extracted",
      finalUrl: "https://example.com/metadata-source",
      title: "Metadata Source",
      publisher: "Example",
      extractKey: sourceEvidenceKey(run.id, source.id),
    });

    const objectStore = new FilesystemObjectStore({ rootPath: objectStoreRoot! });
    await objectStore.putJson(sourceEvidenceKey(run.id, source.id), {
      contentText: "Metadata test source with constrained evidence for retry tracking.",
      metadata: {
        title: "Metadata Source",
        publisher: "Example",
        authors: [],
        publishedAt: null,
      },
      quotes: [
        {
          text: "Metadata test source with constrained evidence for retry tracking.",
          start: 0,
          end: 71,
        },
      ],
      chunks: [
        {
          start: 0,
          end: 71,
          text: "Metadata test source with constrained evidence for retry tracking.",
        },
      ],
    });

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

    const modelProvider = new RetryAwareModelProvider("empty");
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
          synthesizer: "mock/retry-aware",
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
                synthesizer: "mock/retry-aware",
                verifier: "mock/verify",
                verifierStrong: "mock/verify-strong",
              },
              budgets: {},
              enablePlaywright: false,
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              agenticLoop: { maxPlanPasses: 1, maxFollowUpTasksPerPass: 10 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
            },
            degraded: {
              name: "degraded",
              searchBackend: "searxng",
              thinkingMode: "low",
              models: {
                planner: "mock/planner",
                synthesizer: "mock/retry-aware",
                verifier: "mock/verify",
                verifierStrong: "mock/verify-strong",
              },
              budgets: {},
              enablePlaywright: false,
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              agenticLoop: { maxPlanPasses: 5, maxFollowUpTasksPerPass: 10 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
          async fetch(url: string) {
            return { ok: false as const, url, status: 500, error: "mock fetch failure" };
          },
        },
        modelProvider,
      },
    });

    const modelCalls = await store!.listModelCalls(run.id);
    const synthCall = modelCalls.find(
      (modelCall) =>
        modelCall.phase === "synthesize" &&
        ((modelCall.params as Record<string, unknown> | null) ?? {}).persona ===
          "synthesis-writing"
    );
    expect(synthCall).toBeDefined();

    const params = (synthCall?.params as Record<string, unknown> | null) ?? {};
    expect(params.persona).toBe("synthesis-writing");
    expect(params.model).toBe("mock/retry-aware");
    expect(params.reasoningEffort).toBe("high");
    expect(params.synthesisPurpose).toBe("writing");
    expect(typeof params.maxTokens).toBe("number");
    expect((params.maxTokens as number) >= 8_000).toBe(true);
    expect(params.effectiveMaxTokens).toBe((params.maxTokens as number));
    expect(params.retryAttempt).toBe(1);
    expect(typeof params.modelCallId).toBe("string");

    const completedEvents = await store!.listRunEvents(run.id, { limit: 200 });
    const completedEvent = completedEvents.find(
      (event) =>
        event.event_type === "model_call_completed" &&
        (event.data as { persona?: unknown } | null)?.persona === "synthesis-writing"
    );
    expect(completedEvent).toBeDefined();
    const completedData = (completedEvent?.data as Record<string, unknown> | null) ?? {};
    expect(completedData.model).toBe("mock/retry-aware");
    expect(completedData.reasoningEffort).toBe("high");
    expect(typeof completedData.modelCallId).toBe("string");
  }, 120_000);

  it("normalizes legacy source-abstract JSON shapes via compatibility shim", async () => {
    const user = await store!.createUser({ role: "user" });
    const run = await store!.createRun({
      userId: user.id,
      prompt: "Normalize source abstract legacy payloads",
      budgets: {
        maxRuntimeMs: 60_000,
        maxSources: 9,
        maxFetches: 0,
        maxBrowserRenders: 0,
        fetchConcurrency: 1,
        extractConcurrency: 1,
      },
      modelConfig: {
        planner: "mock/planner",
        synthesizer: "mock/legacy-compat",
        verifier: "mock/verify",
        verifierStrong: "mock/verify-strong",
      },
    });

    const objectStore = new FilesystemObjectStore({ rootPath: objectStoreRoot! });
    const sourceUrls = Array.from({ length: 9 }, (_, i) => `https://example.com/legacy-source-abstracts-${i + 1}`);
    for (const [index, url] of sourceUrls.entries()) {
      const sourceText = `Legacy source abstract payload variant ${index + 1} with unique evidence text.`;
      const source = await store!.createSource({ runId: run.id, url });
      await store!.updateSource({
        sourceId: source.id,
        status: "extracted",
        finalUrl: url,
        title: `Legacy Source Abstract Source ${url}`,
        publisher: "Example",
        extractKey: sourceEvidenceKey(run.id, source.id),
      });
      await objectStore.putJson(sourceEvidenceKey(run.id, source.id), {
        contentText: sourceText,
        metadata: {
          title: `Legacy Source Abstract Source ${url}`,
          publisher: "Example",
          authors: [],
          publishedAt: null,
        },
        quotes: [
          {
            text: sourceText,
            start: 0,
            end: sourceText.length,
          },
        ],
        chunks: [
          {
            start: 0,
            end: sourceText.length,
            text: sourceText,
          },
        ],
      });
    }

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
          synthesizer: "mock/legacy-compat",
          verifier: "mock/verify",
          verifierStrong: "mock/verify-strong",
        },
        budgets: {
          maxRuntimeMs: 60_000,
          maxSources: 9,
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
                synthesizer: "mock/legacy-compat",
                verifier: "mock/verify",
                verifierStrong: "mock/verify-strong",
              },
              budgets: {},
              enablePlaywright: false,
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              agenticLoop: { maxPlanPasses: 1, maxFollowUpTasksPerPass: 10 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
            },
            degraded: {
              name: "degraded",
              searchBackend: "searxng",
              thinkingMode: "low",
              models: {
                planner: "mock/planner",
                synthesizer: "mock/legacy-compat",
                verifier: "mock/verify",
                verifierStrong: "mock/verify-strong",
              },
              budgets: {},
              enablePlaywright: false,
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              agenticLoop: { maxPlanPasses: 5, maxFollowUpTasksPerPass: 10 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
          async fetch(url: string) {
            return { ok: false as const, url, status: 500, error: "mock fetch failure" };
          },
        },
        modelProvider: new LegacyPayloadCompatModelProvider(true, false),
      },
    });

    const finalRun = await store!.getRun(run.id);
    expect(finalRun?.status).toBe("completed");

    const modelCalls = await store!.listModelCalls(run.id);
    const sourceAbstractCall = modelCalls.find(
      (modelCall) => ((modelCall.params as Record<string, unknown> | null) ?? {}).schemaCompatMode === "legacy-source-abstracts-shim"
    );
    expect(sourceAbstractCall).toBeDefined();

    const sourceAbstractParams =
      (sourceAbstractCall?.params as Record<string, unknown> | null) ?? {};
    expect(sourceAbstractParams.persona).toBe("synthesis-source-compression");
    expect(sourceAbstractParams.synthesisPurpose).toBe("source-abstracts");
    expect(sourceAbstractParams.schemaCompatMode).toBe("legacy-source-abstracts-shim");
    expect(sourceAbstractParams.model).toBe("mock/legacy-compat");
    expect((sourceAbstractParams.maxTokens as number) >= 8_000).toBe(true);
  }, 120_000);

  it("normalizes sourceAbstracts dataTypes strings into arrays via compatibility shim", async () => {
    const user = await store!.createUser({ role: "user" });
    const run = await store!.createRun({
      userId: user.id,
      prompt: "Normalize source abstract dataTypes strings",
      budgets: {
        maxRuntimeMs: 60_000,
        maxSources: 9,
        maxFetches: 0,
        maxBrowserRenders: 0,
        fetchConcurrency: 1,
        extractConcurrency: 1,
      },
      modelConfig: {
        planner: "mock/planner",
        synthesizer: "mock-legacy-compat",
        verifier: "mock-verify",
        verifierStrong: "mock-verify-strong",
      },
    });

    const objectStore = new FilesystemObjectStore({ rootPath: objectStoreRoot! });
    const sourceUrls = Array.from({ length: 9 }, (_, i) => `https://example.com/data-type-string-${i + 1}`);
    for (const [index, url] of sourceUrls.entries()) {
      const sourceText = `String data-type source ${index + 1} evidence summary for compatibility coverage.`;
      const source = await store!.createSource({ runId: run.id, url });
      await store!.updateSource({
        sourceId: source.id,
        status: "extracted",
        finalUrl: url,
        title: `String DataType Source ${url}`,
        publisher: "Example",
        extractKey: sourceEvidenceKey(run.id, source.id),
      });
      await objectStore.putJson(sourceEvidenceKey(run.id, source.id), {
        contentText: sourceText,
        metadata: {
          title: `String DataType Source ${url}`,
          publisher: "Example",
          authors: [],
          publishedAt: null,
        },
        quotes: [
          {
            text: sourceText,
            start: 0,
            end: sourceText.length,
          },
        ],
        chunks: [
          {
            start: 0,
            end: sourceText.length,
            text: sourceText,
          },
        ],
      });
    }

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
          synthesizer: "mock-legacy-compat",
          verifier: "mock/verify",
          verifierStrong: "mock-verify-strong",
        },
        budgets: {
          maxRuntimeMs: 60_000,
          maxSources: 9,
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
                synthesizer: "mock-legacy-compat",
                verifier: "mock-verify",
                verifierStrong: "mock-verify-strong",
              },
              budgets: {},
              enablePlaywright: false,
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              agenticLoop: { maxPlanPasses: 1, maxFollowUpTasksPerPass: 10 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
            },
            degraded: {
              name: "degraded",
              searchBackend: "searxng",
              thinkingMode: "low",
              models: {
                planner: "mock/planner",
                synthesizer: "mock-legacy-compat",
                verifier: "mock-verify",
                verifierStrong: "mock-verify-strong",
              },
              budgets: {},
              enablePlaywright: false,
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              agenticLoop: { maxPlanPasses: 5, maxFollowUpTasksPerPass: 10 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
          async fetch(url: string) {
            return { ok: false as const, url, status: 500, error: "mock fetch failure" };
          },
        },
        modelProvider: new LegacyPayloadCompatModelProvider(false, false, true),
      },
    });

    const finalRun = await store!.getRun(run.id);
    expect(finalRun?.status).toBe("completed");

    const modelCalls = await store!.listModelCalls(run.id);
    const sourceAbstractCall = modelCalls.find(
      (modelCall) =>
        modelCall.phase === "synthesize" &&
        ((modelCall.params as Record<string, unknown> | null) ?? {}).persona ===
          "synthesis-source-compression"
    );
    expect(sourceAbstractCall).toBeDefined();

    const sourceAbstractParams = (sourceAbstractCall?.params as Record<string, unknown> | null) ?? {};
    expect(sourceAbstractParams.persona).toBe("synthesis-source-compression");
    expect(sourceAbstractParams.synthesisPurpose).toBe("source-abstracts");
    expect(sourceAbstractParams.schemaCompatMode).toBe("legacy-source-abstracts-shim");
    expect(sourceAbstractParams.model).toBe("mock-legacy-compat");
    expect((sourceAbstractParams.maxTokens as number) >= 8_000).toBe(true);
  }, 120_000);

  it("normalizes legacy review payloads with compatible schema shim", async () => {
    const user = await store!.createUser({ role: "user" });
    const run = await store!.createRun({
      userId: user.id,
      prompt: "Normalize legacy review payloads",
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
        synthesizer: "mock/legacy-compat",
        verifier: "mock/verify",
        verifierStrong: "mock/verify-strong",
      },
    });

    const objectStore = new FilesystemObjectStore({ rootPath: objectStoreRoot! });
    const reviewSourceUrls = ["https://example.com/legacy-review-a", "https://example.com/legacy-review-b"];
    for (const [index, url] of reviewSourceUrls.entries()) {
      const reviewSourceText = `A robust review workflow can tolerate legacy schema drift with source ${index + 1}.`;
      const source = await store!.createSource({ runId: run.id, url });
      await store!.updateSource({
        sourceId: source.id,
        status: "extracted",
        finalUrl: url,
        title: `Legacy Review Source ${url}`,
        publisher: "Example",
        extractKey: sourceEvidenceKey(run.id, source.id),
      });
      await objectStore.putJson(sourceEvidenceKey(run.id, source.id), {
        contentText: reviewSourceText,
        metadata: {
          title: `Legacy Review Source ${url}`,
          publisher: "Example",
          authors: [],
          publishedAt: null,
        },
        quotes: [
          {
            text: reviewSourceText,
            start: 0,
            end: reviewSourceText.length,
          },
        ],
        chunks: [
          {
            start: 0,
            end: reviewSourceText.length,
            text: reviewSourceText,
          },
        ],
      });
    }

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
          synthesizer: "mock-legacy-compat",
          verifier: "mock/verify",
          verifierStrong: "mock/verify-strong",
        },
        budgets: {
          maxRuntimeMs: 60_000,
          maxSources: 2,
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
                synthesizer: "mock/legacy-compat",
                verifier: "mock/verify",
                verifierStrong: "mock/verify-strong",
              },
              budgets: {},
              enablePlaywright: false,
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              agenticLoop: { maxPlanPasses: 1, maxFollowUpTasksPerPass: 10 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
            },
            degraded: {
              name: "degraded",
              searchBackend: "searxng",
              thinkingMode: "low",
              models: {
                planner: "mock/planner",
                synthesizer: "mock/legacy-compat",
                verifier: "mock/verify",
                verifierStrong: "mock/verify-strong",
              },
              budgets: {},
              enablePlaywright: false,
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              agenticLoop: { maxPlanPasses: 5, maxFollowUpTasksPerPass: 10 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
          async fetch(url: string) {
            return { ok: false as const, url, status: 500, error: "mock fetch failure" };
          },
        },
        modelProvider: new LegacyPayloadCompatModelProvider(false, true),
      },
    });

    const finalRun = await store!.getRun(run.id);
    expect(finalRun?.status).toBe("completed");

    const modelCalls = await store!.listModelCalls(run.id);
    const reviewCall = modelCalls.find(
      (modelCall) =>
        modelCall.phase === "synthesize" &&
        ((modelCall.params as Record<string, unknown> | null) ?? {}).persona ===
          "synthesis-review"
    );
    expect(reviewCall).toBeDefined();

    const reviewParams = (reviewCall?.params as Record<string, unknown> | null) ?? {};
    expect(reviewParams.persona).toBe("synthesis-review");
    expect(reviewParams.synthesisPurpose).toBe("review");
    expect(reviewParams.schemaCompatMode).toBe("legacy-review-shim");
    expect(reviewParams.model).toBe("mock/legacy-compat");

    const events = await store!.listRunEvents(run.id, { limit: 200 });
    expect(
      events.some(
        (event) =>
          event.event_type === "model_call_completed" &&
          (event.data as { phase?: string } | null)?.phase === "synthesize"
      )
    ).toBe(true);
  }, 120_000);

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

    const source1 = await store!.createSource({
      runId: run.id,
      url: "https://example.com/review-a",
    });
    const source2 = await store!.createSource({
      runId: run.id,
      url: "https://example.com/review-b",
    });
    const source3 = await store!.createSource({
      runId: run.id,
      url: "https://example.com/review-c",
    });
    const evidence1 = {
      contentText:
        "A consistent policy signal appeared in both telemetry streams and operations logs.",
      metadata: { title: "Source A", publisher: "Example", authors: [], publishedAt: null },
      quotes: [
        {
          text: "A consistent policy signal appeared in both telemetry streams and operations logs.",
          start: 0,
          end: 77,
        },
      ],
      chunks: [
        {
          start: 0,
          end: 77,
          text: "A consistent policy signal appeared in both telemetry streams.",
        },
      ],
    };
    const evidence2 = {
      contentText:
        "Independent reporting confirmed the same operational pattern across environments.",
      metadata: { title: "Source B", publisher: "Example", authors: [], publishedAt: null },
      quotes: [
        {
          text: "Independent reporting confirmed the same operational pattern across environments.",
          start: 0,
          end: 73,
        },
      ],
      chunks: [
        {
          start: 0,
          end: 73,
          text: "Independent reporting confirmed the same operational pattern.",
        },
      ],
    };
    const evidence3 = {
      contentText:
        "Third-source signals independently validated the operational pattern under a separate regime.",
      metadata: { title: "Source C", publisher: "Example", authors: [], publishedAt: null },
      quotes: [
        {
          text: "Third-source signals independently validated the operational pattern under a separate regime.",
          start: 0,
          end: 88,
        },
      ],
      chunks: [
        {
          start: 0,
          end: 88,
          text: "Third-source signals independently validated the same pattern.",
        },
      ],
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
              agenticLoop: { maxPlanPasses: 5, maxFollowUpTasksPerPass: 10 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              agenticLoop: { maxPlanPasses: 5, maxFollowUpTasksPerPass: 10 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
          async fetch(url: string) {
            return { ok: false as const, url, status: 500, error: "mock fetch failure" };
          },
        },
        modelProvider,
      },
    });

    const events = await store!.listRunEvents(run.id, { limit: 200 });
    expect(events.find((event) => event.event_type === "synthesis_review_requested")).toBeDefined();
    const reviewFeedbackEvents = events.filter(
      (event) => event.event_type === "synthesis_review_feedback"
    );
    expect(reviewFeedbackEvents.length).toBeGreaterThanOrEqual(1);
    const hasUnsupportedFeedback = reviewFeedbackEvents.some((event) => {
      const data = event.data as { unsupportedConclusions?: unknown[] } | undefined;
      return Array.isArray(data?.unsupportedConclusions) && data.unsupportedConclusions.length > 0;
    });
    expect(hasUnsupportedFeedback).toBe(true);
    const firstSynthesisRequest = modelProvider.synthesisRequests.at(0);
    const refinedSynthesisRequest = modelProvider.synthesisRequests
      .slice(1)
      .find((request) => request.hasReviewFeedback);
    expect(firstSynthesisRequest?.hasReviewFeedback).toBe(false);
    expect(refinedSynthesisRequest).toBeDefined();
    expect(refinedSynthesisRequest?.reviewFeedback).toMatchObject({
      verdict: "revise",
      unsupportedConclusions: [{ findingId: "F1" }],
      missingEvidence: ["Need explicit mechanism evidence in independent source families."],
      requestedRevisions: ["Add at least one explicit cross-source mechanism citation."],
      directives: ["Track where each source confirms the mechanism separately."],
    });
    expect(
      events.find((event) => event.event_type === "synthesis_refinement_succeeded")
    ).toBeDefined();
    expect(modelProvider.synthCallCount).toBeGreaterThanOrEqual(2);
    expect(modelProvider.reviewCallCount).toBeGreaterThanOrEqual(1);
    const output = await objectStore.getText(runOutputKey(run.id));
    expect(output).toContain("Cross-source consistency");
  }, 60_000);

  it("continues extraction when one raw-html source triggers stack-overflow and fallback fails", async () => {
    const user = await store!.createUser({ role: "user" });
    const run = await store!.createRun({
      userId: user.id,
      prompt: "Overflow-safe extraction regression",
      budgets: {
        maxRuntimeMs: 60_000,
        maxSources: 2,
        maxFetches: 0,
        maxBrowserRenders: 0,
        fetchConcurrency: 1,
        extractConcurrency: 2,
      },
      modelConfig: {
        planner: "mock/planner",
        synthesizer: "mock/synth",
        verifier: "mock/verify",
        verifierStrong: "mock/verify-strong",
      },
    });

    const sourceGood = await store!.createSource({
      runId: run.id,
      url: "https://example.com/good-source",
    });
    const sourceOverflow = await store!.createSource({
      runId: run.id,
      url: "https://example.com/overflow-source",
    });

    const objectStore = new FilesystemObjectStore({ rootPath: objectStoreRoot! });
    const extractModule = await import("./extract.js");
    const originalExtractFromHtml = extractModule.extractFromHtml;
    const spy = vi.spyOn(extractModule, "extractFromHtml");

    try {
      spy.mockImplementation((html: string, opts?: { url?: string }) => {
        if (opts?.url === "https://example.com/overflow-source") {
          throw new RangeError("Maximum call stack size exceeded");
        }
        return originalExtractFromHtml(html, opts);
      });

      const goodBody = `<html><body><p>${"Normal extracted evidence sentence. ".repeat(30)}</p></body></html>`;
      const overflowBody =
        "<html><body><script>for(var i=0;i<10000;i++){console.log(i);}</script></body></html>";
      const goodBodyKey = sourceRawBodyKey(run.id, sourceGood.id);
      const overflowBodyKey = sourceRawBodyKey(run.id, sourceOverflow.id);
      await objectStore.putBytes(goodBodyKey, new TextEncoder().encode(goodBody));
      await objectStore.putBytes(overflowBodyKey, new TextEncoder().encode(overflowBody));

      await store!.updateSource({
        sourceId: sourceGood.id,
        status: "fetched",
        finalUrl: "https://example.com/good-source",
        rawBodyKey: goodBodyKey,
      });
      await store!.updateSource({
        sourceId: sourceOverflow.id,
        status: "fetched",
        finalUrl: "https://example.com/overflow-source",
        rawBodyKey: overflowBodyKey,
      });

      await store!.updateRun({
        runId: run.id,
        state: {
          version: 1,
          nextPhase: "extract",
          counters: { searchCalls: 0, fetches: 0, renders: 0, modelCalls: 0 },
          artifacts: {},
          startedAt: new Date().toISOString(),
          debug: { enabled: false },
        },
      });

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
            maxFetches: 0,
            maxBrowserRenders: 0,
            fetchConcurrency: 1,
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
                synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
                agenticLoop: {
                  maxPlanPasses: 5,
                  maxFollowUpTasksPerPass: 10,
                },
                researchLoop: {
                  enabled: false,
                  maxIterations: 5,
                  mode: "auto",
                  switchToHybridAfterRejects: 2,
                },
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
                synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
                agenticLoop: {
                  maxPlanPasses: 5,
                  maxFollowUpTasksPerPass: 10,
                },
                researchLoop: {
                  enabled: false,
                  maxIterations: 5,
                  mode: "auto",
                  switchToHybridAfterRejects: 2,
                },
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
            async fetch(url: string) {
              return { ok: false as const, url, status: 500, error: "mock fetch failure" };
            },
          },
          modelProvider: new MockModelProvider(),
        },
      });

      const finalRun = await store!.getRun(run.id);
      expect(finalRun?.status).toBe("completed");

      const sources = await store!.listSources(run.id);
      expect(sources.filter((source) => source.id === sourceGood.id)[0]!.status).toBe("extracted");
      expect(sources.filter((source) => source.id === sourceOverflow.id)[0]!.status).toBe("failed");

      const events = await store!.listRunEvents(run.id, { limit: 300 });
      expect(
        events.some(
          (event) =>
            event.event_type === "source_extract_fallback" &&
            (event.data as { sourceId?: string } | null)?.sourceId === sourceOverflow.id
        )
      ).toBe(true);
      const failedEvent = events.find(
        (event) =>
          event.event_type === "source_extract_failed" &&
          (event.data as { sourceId?: string } | null)?.sourceId === sourceOverflow.id
      );
      expect(failedEvent).toBeDefined();
      expect((failedEvent?.data as { errorType?: string } | null)?.errorType).toBe("stack_overflow");
    } finally {
      spy.mockRestore();
    }
  }, 120_000);

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

    const source = await store!.createSource({
      runId: run.id,
      url: "https://example.com/failing-synth-source",
    });
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
      metadata: {
        title: "Failing Synth Source",
        publisher: "Example",
        authors: [],
        publishedAt: null,
      },
      quotes: [
        {
          text: "A policy signal appears under both positive and negative conditions.",
          start: 0,
          end: 73,
        },
      ],
      chunks: [
        {
          start: 0,
          end: 73,
          text: "A policy signal appears under both positive and negative conditions.",
        },
      ],
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
              agenticLoop: { maxPlanPasses: 5, maxFollowUpTasksPerPass: 10 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              agenticLoop: { maxPlanPasses: 5, maxFollowUpTasksPerPass: 10 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
          async fetch(url: string) {
            return { ok: false as const, url, status: 500, error: "mock fetch failure" };
          },
        },
        modelProvider,
      },
    });

    const finalRun = await store!.getRun(run.id);
    expect(finalRun?.status).toBe("failed");
    expect(finalRun?.phase).toBe("synthesize");

    expect(modelProvider.requestCount).toBe(4);
    expect(await objectStore.getText(runOutputKey(run.id))).toBeNull();
    expect(await objectStore.getText(runCitationMapKey(run.id))).toBeNull();
    expect(await objectStore.getText(runVerificationMarkdownKey(run.id))).toBeNull();

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

  it("retries all model phases when transient failures occur (plan, source abstracts, synthesis, review)", async () => {
    const user = await store!.createUser({ role: "user" });
    const run = await store!.createRun({
      userId: user.id,
      prompt: "Run all model phases with transient retryable failures.",
      budgets: {
        maxRuntimeMs: 120_000,
        maxSources: 10,
        maxFetches: 10,
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

    const searchResultUrls = Array.from(
      { length: 12 },
      (_, i) => `https://example.com/source-${i + 1}`
    );
    const search = {
      name: "mock-search",
      async search() {
        return searchResultUrls.map((url) => ({
          url,
          title: `Source ${url}`,
          snippet: `Source ${url} contributes explicit managed planning evidence for this synthesis failure test.`,
        }));
      },
    };
    const objectStore = new FilesystemObjectStore({ rootPath: objectStoreRoot! });
    const httpFetch = {
      name: "mock-http",
      async fetch(url: string) {
        const html = `<html><head><title>${url}</title></head><body><p>Source ${url} explains synthetic planning evidence for managed testing scenarios and synthesis review pathways.</p><p>It provides structured operational and strategic signal evidence in detail with explicit data points on planning, synthesis, review, and source quality.</p></body></html>`;
        return {
          ok: true as const,
          url,
          status: 200,
          contentType: "text/html",
          body: new TextEncoder().encode(html),
        };
      },
    };

    const modelProvider = new AllStepRetryableModelProvider({
      plan: 1,
      sourceAbstracts: 1,
      synthesis: 1,
      review: 1,
    });

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
          maxRuntimeMs: 120_000,
          maxSources: 10,
          maxFetches: 10,
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
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              agenticLoop: {
                maxPlanPasses: 1,
                maxFollowUpTasksPerPass: 10,
              },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              agenticLoop: { maxPlanPasses: 5, maxFollowUpTasksPerPass: 10 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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

    const finalRun = await store!.getRun(run.id);
    expect(finalRun?.status).toBe("completed");
    expect(modelProvider.planCallCount).toBeGreaterThanOrEqual(2);
    expect(modelProvider.sourceAbstractCallCount).toBeGreaterThanOrEqual(2);
    expect(modelProvider.synthesisCallCount).toBeGreaterThanOrEqual(2);
    expect(modelProvider.reviewCallCount).toBeGreaterThanOrEqual(2);

    const events = await store!.listRunEvents(run.id, { limit: 300 });
    const retryEvents = events.filter((event) => event.event_type === "model_call_retry");
    expect(retryEvents.length).toBeGreaterThanOrEqual(4);
    const retryPhases = retryEvents
      .map((event) => (event.data as { phase?: string } | undefined)?.phase)
      .filter((phase): phase is string => !!phase)
      .sort();
    expect(retryPhases).toContain("plan");
    expect(retryPhases).toContain("synthesize");
    expect(
      retryEvents.some(
        (event) => (event.data as { phase?: string } | undefined)?.phase === "synthesize"
      )
    ).toBe(true);
    expect(
      events.find((event) => event.event_type === "synthesis_source_abstracts_created")
    ).toBeDefined();
    expect(events.find((event) => event.event_type === "synthesis_review_feedback")).toBeDefined();

    const output = await objectStore.getText(runOutputKey(run.id));
    expect(output).toContain("# Research memo");
  }, 120_000);

  it("falls back when source abstracts are not valid JSON and still completes synthesis", async () => {
    const user = await store!.createUser({ role: "user" });
    const run = await store!.createRun({
      userId: user.id,
      prompt: "Ensure synthesis survives invalid source abstract JSON output.",
      budgets: {
        maxRuntimeMs: 120_000,
        maxSources: 10,
        maxFetches: 10,
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

    const searchResultUrls = Array.from({ length: 12 }, (_, i) => `https://example.com/source-${i + 1}`);
    const search = {
      name: "mock-search",
      async search() {
        return searchResultUrls.map((url) => ({
          url,
          title: `Source ${url}`,
          snippet: `Source ${url} contributes explicit managed planning evidence for source abstract fallback tests.`,
        }));
      },
    };
    const objectStore = new FilesystemObjectStore({ rootPath: objectStoreRoot! });
    const httpFetch = {
      name: "mock-http",
      async fetch(url: string) {
        const html = `<html><head><title>${url}</title></head><body><p>Source ${url} provides planning and synthesis evidence.</p><p>It provides structured operational and strategic signal evidence in detail with explicit data points on planning, synthesis, review, and source quality.</p></body></html>`;
        return {
          ok: true as const,
          url,
          status: 200,
          contentType: "text/html",
          body: new TextEncoder().encode(html),
        };
      },
    };

    const modelProvider = new InvalidSourceAbstractJsonModelProvider();

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
          maxRuntimeMs: 120_000,
          maxSources: 10,
          maxFetches: 10,
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
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              agenticLoop: {
                maxPlanPasses: 1,
                maxFollowUpTasksPerPass: 10,
              },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              agenticLoop: { maxPlanPasses: 5, maxFollowUpTasksPerPass: 10 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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

    expect(modelProvider.sourceAbstractCallCount).toBeGreaterThan(0);
    const finalRun = await store!.getRun(run.id);
    expect(finalRun?.status).toBe("completed");

    const events = await store!.listRunEvents(run.id, { limit: 400 });
    expect(events.find((event) => event.event_type === "synthesis_source_abstracts_fallback")).toBeDefined();

    const output = await objectStore.getText(runOutputKey(run.id));
    expect(output).toContain("# Research memo");
  }, 120_000);

  it("retries transient synthesis LLM failures and succeeds once the retry budget is exhausted", async () => {
    const user = await store!.createUser({ role: "user" });
    const run = await store!.createRun({
      userId: user.id,
      prompt: "Track synthesis retry behavior on transient failures.",
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

    const source = await store!.createSource({
      runId: run.id,
      url: "https://example.com/retry-synth-source",
    });
    await store!.updateSource({
      sourceId: source.id,
      status: "extracted",
      finalUrl: "https://example.com/retry-synth-source",
      title: "Retry Synth Source",
      publisher: "Example",
      extractKey: sourceEvidenceKey(run.id, source.id),
    });
    const evidence = {
      contentText: "A robust synthetic conclusion requires cross-source validation.",
      metadata: {
        title: "Retry Synth Source",
        publisher: "Example",
        authors: [],
        publishedAt: null,
      },
      quotes: [
        {
          text: "A robust synthetic conclusion requires cross-source validation.",
          start: 0,
          end: 72,
        },
      ],
      chunks: [
        {
          start: 0,
          end: 72,
          text: "A robust synthetic conclusion requires cross-source validation.",
        },
      ],
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

    const modelProvider = new RetryableSynthesisModelProvider(2);
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
              agenticLoop: { maxPlanPasses: 5, maxFollowUpTasksPerPass: 10 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              agenticLoop: { maxPlanPasses: 5, maxFollowUpTasksPerPass: 10 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
          async fetch(url: string) {
            return { ok: false as const, url, status: 500, error: "mock fetch failure" };
          },
        },
        modelProvider,
      },
    });

    const finalRun = await store!.getRun(run.id);
    expect(finalRun?.status).toBe("completed");
    expect(modelProvider.requestCount).toBeGreaterThanOrEqual(5);
    const output = await objectStore.getText(runOutputKey(run.id));
    expect(output).toContain("Summary based on sources after retries.");
  }, 60_000);

  it("fails synthesis when refinement attempts are exhausted before sufficient output", async () => {
    const user = await store!.createUser({ role: "user" });
    const run = await store!.createRun({
      userId: user.id,
      prompt: "Synthetic deep loop should fail after retry exhaustion without running verify.",
      budgets: {
        maxRuntimeMs: 60_000,
        maxSources: 3,
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

    const sourceValues = [
      {
        url: "https://example.com/exhaust-source-a",
        title: "Exhaust Source A",
        contentText: "Source A reports constrained capacity claims under high-load conditions.",
      },
      {
        url: "https://example.com/exhaust-source-b",
        title: "Exhaust Source B",
        contentText: "Source B reports deployment cadence and procurement timing patterns.",
      },
      {
        url: "https://example.com/exhaust-source-c",
        title: "Exhaust Source C",
        contentText: "Source C reports policy signaling changes in mixed geography contexts.",
      },
    ];

    const objectStore = new FilesystemObjectStore({ rootPath: objectStoreRoot! });
    const sourceIds = await Promise.all(
      sourceValues.map((sourceValue) =>
        store!.createSource({ runId: run.id, url: sourceValue.url }).then(async (source) => {
          await store!.updateSource({
            sourceId: source.id,
            status: "extracted",
            finalUrl: sourceValue.url,
            title: sourceValue.title,
            publisher: "Example",
            extractKey: sourceEvidenceKey(run.id, source.id),
          });
          return { source, sourceValue };
        })
      )
    );

    for (let sourceIndex = 0; sourceIndex < sourceIds.length; sourceIndex += 1) {
      const current = sourceIds[sourceIndex]!;
      const evidence = {
        contentText: current.sourceValue.contentText,
        metadata: {
          title: current.sourceValue.title,
          publisher: "Example",
          authors: [],
          publishedAt: null,
        },
        quotes: [
          {
            text: current.sourceValue.contentText,
            start: 0,
            end: current.sourceValue.contentText.length,
          },
        ],
        chunks: [
          {
            start: 0,
            end: current.sourceValue.contentText.length,
            text: current.sourceValue.contentText,
          },
        ],
      };
      await objectStore.putJson(sourceEvidenceKey(run.id, current.source.id), evidence);
    }

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

    const modelProvider = new ExhaustedSynthesisRefinementModelProvider();

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
              agenticLoop: { maxPlanPasses: 5, maxFollowUpTasksPerPass: 10 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
              synthesis: { maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
              agenticLoop: { maxPlanPasses: 5, maxFollowUpTasksPerPass: 10 },
              researchLoop: {
                enabled: false,
                maxIterations: 5,
                mode: "auto",
                switchToHybridAfterRejects: 2,
              },
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
          async fetch(url: string) {
            return { ok: false as const, url, status: 500, error: "mock fetch failure" };
          },
        },
        modelProvider,
      },
    });

    const finalRun = await store!.getRun(run.id);
    expect(finalRun?.status).toBe("failed");
    expect(finalRun?.phase).toBe("synthesize");
    const errorMessage =
      finalRun?.error && typeof finalRun.error === "object" && "message" in finalRun.error
        ? String((finalRun.error as { message?: unknown }).message)
        : String(finalRun?.error ?? "");
    expect(errorMessage).toContain(
      "Synthesis could not reach requested depth after refinement loop."
    );

    expect(modelProvider.synthCallCount).toBeGreaterThanOrEqual(4);
    expect(modelProvider.reviewCallCount).toBeGreaterThanOrEqual(4);

    const events = await store!.listRunEvents(run.id, { limit: 300 });
    expect(
      events.find((event) => event.event_type === "synthesis_refinement_exhausted")
    ).toBeDefined();
    expect(events.find((event) => event.event_type === "synthesis_review_feedback")).toBeDefined();
    expect(events.find((event) => event.event_type === "synthesis_review_requested")).toBeDefined();
    expect(
      events.find((event) => event.event_type === "phase_started" && event.phase === "verify")
    ).toBeUndefined();

    expect(await objectStore.getText(runOutputKey(run.id))).toBeNull();
    expect(await objectStore.getText(runVerificationMarkdownKey(run.id))).toBeNull();
  }, 60_000);
});
