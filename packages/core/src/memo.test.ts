import { describe, expect, it } from "vitest";

import type { CitationMap, SynthesisOutput } from "./memo.js";
import { renderResearchMemoMarkdown, SynthesisOutputSchema } from "./memo.js";
import { OutlinePlanSchema } from "./outline-plan.js";

describe("memo rendering", () => {
  it("renders a stable research memo markdown", () => {
    const synthesis: SynthesisOutput = {
      summary: "A short summary.",
      keyFindings: [
        { id: "F1", text: "First finding.", citations: [{ source: "S1" }] },
        { id: "F2", text: "Second finding.", citations: [{ source: "S2" }] },
      ],
      unknowns: ["One unknown."],
    };

    const citationMap: CitationMap = {
      version: 1,
      runId: "run-123",
      createdAt: "2020-01-01T00:00:00.000Z",
      policy: "balanced",
      sources: [
        {
          label: "S1",
          sourceId: "src-1",
          url: "https://example.com/1",
          title: "Example 1",
          publisher: "Example",
          fetchedAt: "2020-01-01T00:00:00.000Z",
        },
        {
          label: "S2",
          sourceId: "src-2",
          url: "https://example.com/2",
          title: "Example 2",
          publisher: "Example",
          fetchedAt: "2020-01-01T00:00:00.000Z",
        },
      ],
      claims: [
        { id: "F1", text: "First finding.", citations: [{ sourceLabel: "S1", sourceId: "src-1" }] },
        {
          id: "F2",
          text: "Second finding.",
          citations: [{ sourceLabel: "S2", sourceId: "src-2" }],
        },
      ],
    };

    const md = renderResearchMemoMarkdown({ synthesis, citationMap });
    expect(md).toMatchInlineSnapshot(`
      "# Research memo

      ## Summary

      A short summary.

      ## Key findings

      - First finding. [^S1]
      - Second finding. [^S2]

      ## Unknowns

      - One unknown.

      ## Sources

      [^S1]: Example 1 — https://example.com/1 (fetched 2020-01-01T00:00:00.000Z)
      [^S2]: Example 2 — https://example.com/2 (fetched 2020-01-01T00:00:00.000Z)
      "
    `);
  });

  it("does not throw when keyFindings is empty", () => {
    const parsed = SynthesisOutputSchema.safeParse({
      summary: "A short summary.",
      keyFindings: [],
      unknowns: [],
    });
    if (!parsed.success) throw parsed.error;

    const citationMap: CitationMap = {
      version: 1,
      runId: "run-empty",
      createdAt: "2020-01-01T00:00:00.000Z",
      policy: "balanced",
      sources: [],
      claims: [],
    };

    const md = renderResearchMemoMarkdown({ synthesis: parsed.data, citationMap });
    expect(md).toContain("## Key findings");
  });

  it("renders dynamic outline sections when provided by synthesis output", () => {
    const synthesis: SynthesisOutput = {
      summary: "Summary text.",
      keyFindings: [{ id: "F1", text: "Finding.", citations: [{ source: "S1" }] }],
      unknowns: [],
      outlineSections: [
        {
          heading: "Executive Summary",
          body: "Dynamic section body.",
          citations: [{ source: "S1" }],
        },
      ],
    };
    const citationMap: CitationMap = {
      version: 1,
      runId: "run-dynamic",
      createdAt: "2020-01-01T00:00:00.000Z",
      policy: "balanced",
      sources: [
        {
          label: "S1",
          sourceId: "src-1",
          url: "https://example.com/1",
          title: "Example 1",
          publisher: "Example",
          fetchedAt: "2020-01-01T00:00:00.000Z",
        },
      ],
      claims: [{ id: "F1", text: "Finding.", citations: [{ sourceLabel: "S1", sourceId: "src-1" }] }],
    };

    const md = renderResearchMemoMarkdown({ synthesis, citationMap });
    expect(md).toContain("## Executive Summary");
    expect(md).toContain("Dynamic section body.");
    expect(md).toContain("Citations: [^S1]");
    expect(md).not.toContain("## Key findings");
  });

  it("renders planner outline sections when synthesis does not provide dynamic sections", () => {
    const synthesis: SynthesisOutput = {
      summary: "A short summary.",
      keyFindings: [{ id: "F1", text: "First finding.", citations: [{ source: "S1" }] }],
      unknowns: [],
    };
    const citationMap: CitationMap = {
      version: 1,
      runId: "run-outline-plan",
      createdAt: "2020-01-01T00:00:00.000Z",
      policy: "balanced",
      sources: [
        {
          label: "S1",
          sourceId: "src-1",
          url: "https://example.com/1",
          title: "Example 1",
          publisher: "Example",
          fetchedAt: "2020-01-01T00:00:00.000Z",
        },
      ],
      claims: [{ id: "F1", text: "First finding.", citations: [{ sourceLabel: "S1", sourceId: "src-1" }] }],
    };
    const outlinePlan = OutlinePlanSchema.parse({
      version: 1,
      rationale: "Test outline",
      sections: [
        {
          id: "summary",
          heading: "Summary",
          intent: "Summarize findings",
          dependsOnQuestionIds: [],
        },
        {
          id: "findings",
          heading: "Key Findings",
          intent: "List findings",
          dependsOnQuestionIds: [],
        },
      ],
      notes: [],
    });

    const md = renderResearchMemoMarkdown({ synthesis, citationMap, outlinePlan });
    expect(md).toContain("## Summary");
    expect(md).toContain("## Key Findings");
    expect(md).not.toContain("## Key findings");
  });
});
