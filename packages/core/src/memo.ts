import { z } from "zod";

import type { CitationPolicy } from "./config.js";
import type { ExtractedQuote } from "./extract.js";

export const SynthesisCitationSchema = z.object({
  source: z.string().min(1),
  quoteId: z.string().min(1).optional(),
});

export const SynthesisClaimSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  citations: z.array(SynthesisCitationSchema).default([]),
});

export const SynthesisOutputSchema = z.object({
  summary: z.string().min(1),
  keyFindings: z.array(SynthesisClaimSchema).min(1),
  contradictions: z.array(z.string().min(1)).optional(),
  recommendations: z.array(z.string().min(1)).optional(),
  unknowns: z.array(z.string().min(1)).default([]),
});

export type SynthesisOutput = z.infer<typeof SynthesisOutputSchema>;

export type LabeledSource = {
  label: string; // e.g. "S1"
  sourceId: string;
  url: string;
  title: string | null;
  publisher: string | null;
  fetchedAt: string | null;
  quotes: Array<ExtractedQuote & { quoteId: string }>;
};

export type CitationMap = {
  version: 1;
  runId: string;
  createdAt: string;
  policy: CitationPolicy;
  sources: Array<{
    label: string;
    sourceId: string;
    url: string;
    title: string | null;
    publisher: string | null;
    fetchedAt: string | null;
  }>;
  claims: Array<{
    id: string;
    text: string;
    citations: Array<{
      sourceLabel: string;
      sourceId: string;
      quote?: { quoteId: string; start: number; end: number; text: string };
    }>;
  }>;
};

export function buildCitationMap(input: {
  runId: string;
  policy: CitationPolicy;
  synthesis: SynthesisOutput;
  sources: LabeledSource[];
}): CitationMap {
  const sourcesByLabel = new Map(input.sources.map((s) => [s.label, s]));
  return {
    version: 1,
    runId: input.runId,
    createdAt: new Date().toISOString(),
    policy: input.policy,
    sources: input.sources.map((s) => ({
      label: s.label,
      sourceId: s.sourceId,
      url: s.url,
      title: s.title,
      publisher: s.publisher,
      fetchedAt: s.fetchedAt,
    })),
    claims: input.synthesis.keyFindings.map((c) => {
      const citations = c.citations
        .map((cit) => {
          const src = sourcesByLabel.get(cit.source);
          if (!src) return null;
          const quote = cit.quoteId ? src.quotes.find((q) => q.quoteId === cit.quoteId) : undefined;
          return {
            sourceLabel: src.label,
            sourceId: src.sourceId,
            quote: quote
              ? { quoteId: quote.quoteId, start: quote.start, end: quote.end, text: quote.text }
              : undefined,
          };
        })
        .filter(Boolean) as Array<{
        sourceLabel: string;
        sourceId: string;
        quote?: { quoteId: string; start: number; end: number; text: string };
      }>;

      return { id: c.id, text: c.text, citations };
    }),
  };
}

function mdEscape(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

export function renderResearchMemoMarkdown(input: {
  synthesis: SynthesisOutput;
  citationMap: CitationMap;
}): string {
  const lines: string[] = [];
  lines.push("# Research memo");
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push(mdEscape(input.synthesis.summary));
  lines.push("");

  lines.push("## Key findings");
  lines.push("");
  for (const claim of input.citationMap.claims) {
    const footnotes = Array.from(new Set(claim.citations.map((c) => c.sourceLabel)))
      .sort((a, b) => a.localeCompare(b))
      .map((l) => `[^${l}]`)
      .join("");
    lines.push(`- ${mdEscape(claim.text)}${footnotes ? ` ${footnotes}` : ""}`);
  }
  lines.push("");

  if (input.synthesis.contradictions?.length) {
    lines.push("## Contradictions / Disagreements");
    lines.push("");
    for (const item of input.synthesis.contradictions) lines.push(`- ${mdEscape(item)}`);
    lines.push("");
  }

  if (input.synthesis.recommendations?.length) {
    lines.push("## Recommendations");
    lines.push("");
    for (const item of input.synthesis.recommendations) lines.push(`- ${mdEscape(item)}`);
    lines.push("");
  }

  lines.push("## Unknowns");
  lines.push("");
  if (input.synthesis.unknowns.length === 0) {
    lines.push("- None noted.");
  } else {
    for (const item of input.synthesis.unknowns) lines.push(`- ${mdEscape(item)}`);
  }
  lines.push("");

  lines.push("## Sources");
  lines.push("");
  for (const s of input.citationMap.sources) {
    const title = s.title ?? s.url;
    const fetched = s.fetchedAt ? ` (fetched ${s.fetchedAt})` : "";
    lines.push(`[^${s.label}]: ${mdEscape(title)} — ${s.url}${fetched}`);
  }
  lines.push("");

  return lines.join("\n");
}
