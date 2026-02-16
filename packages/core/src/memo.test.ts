import { describe, expect, it } from "vitest";

import type { CitationMap, SynthesisOutput } from "./memo.js";
import { renderResearchMemoMarkdown } from "./memo.js";

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
});
