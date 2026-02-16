import { describe, expect, it } from "vitest";

import { extractFromText } from "./extract.js";
import { validateCitations } from "./verify.js";

describe("validateCitations", () => {
  it("flags quote mismatches (tampered quote/offsets)", () => {
    const ev = extractFromText("Hello world.");
    const runId = "run-1";
    const sourceId = "src-1";

    const { report } = validateCitations({
      runId,
      policy: "balanced",
      citationMap: {
        version: 1,
        runId,
        createdAt: "2020-01-01T00:00:00.000Z",
        policy: "balanced",
        sources: [
          {
            label: "S1",
            sourceId,
            url: "https://example.com",
            title: "Example",
            publisher: "Example",
            fetchedAt: "2020-01-01T00:00:00.000Z",
          },
        ],
        claims: [
          {
            id: "F1",
            text: "Hello was said.",
            citations: [
              {
                sourceLabel: "S1",
                sourceId,
                quote: { quoteId: "Q1", start: 0, end: 5, text: "WRONG" },
              },
            ],
          },
        ],
      },
      evidenceBySourceId: { [sourceId]: ev },
    });

    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === "quote_mismatch" && i.severity === "error")).toBe(
      true
    );
  });
});
