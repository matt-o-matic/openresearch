/// <reference lib="dom" />

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

export type ExtractedMetadata = {
  title: string | null;
  publisher: string | null;
  authors: string[];
  publishedAt: string | null;
};

export type ExtractedQuote = {
  text: string;
  start: number;
  end: number;
};

export type ExtractedChunk = {
  start: number;
  end: number;
  text: string;
};

export type ExtractedEvidence = {
  contentText: string;
  metadata: ExtractedMetadata;
  quotes: ExtractedQuote[];
  chunks: ExtractedChunk[];
};

const INJECTION_LINE_PATTERNS: RegExp[] = [
  /ignore (all|any|previous) instructions/i,
  /disregard (all|any|previous) instructions/i,
  /\byou are (an|a)\b.*\b(chatgpt|ai|assistant)\b/i,
  /\b(system|developer)\s+(prompt|message)\b/i,
  /\bBEGIN\s+(SYSTEM|INSTRUCTIONS|PROMPT)\b/i,
  /\bEND\s+(SYSTEM|INSTRUCTIONS|PROMPT)\b/i,
  /\bdo not (follow|comply|answer)\b/i,
  /\bact as\b/i,
];

export function stripPromptInjection(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      kept.push("");
      continue;
    }
    if (INJECTION_LINE_PATTERNS.some((p) => p.test(trimmed))) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

function normalizeWhitespace(text: string): string {
  return (
    text
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n")
      .replaceAll("\t", " ")
      // collapse runs of spaces but preserve newlines for paragraph-ish structure
      .replace(/[ \u00A0]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function getMeta(doc: Document, nameOrProp: string): string | null {
  const byName = doc.querySelector(`meta[name="${nameOrProp}"]`)?.getAttribute("content");
  if (byName) return byName;
  const byProp = doc.querySelector(`meta[property="${nameOrProp}"]`)?.getAttribute("content");
  if (byProp) return byProp;
  return null;
}

function splitSentences(text: string): string[] {
  // Minimal heuristic: sentence-ish splits with punctuation.
  const parts = text.split(/(?<=[.!?])\s+/g);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function buildQuotes(text: string, maxQuotes: number): ExtractedQuote[] {
  const sentences = splitSentences(text);
  const quotes: ExtractedQuote[] = [];
  let cursor = 0;

  for (const s of sentences) {
    if (quotes.length >= maxQuotes) break;
    if (s.length < 40) continue;
    if (s.length > 280) continue;
    const idx = text.indexOf(s, cursor);
    if (idx < 0) continue;
    const start = idx;
    const end = idx + s.length;
    quotes.push({ text: s, start, end });
    cursor = end;
  }

  if (quotes.length === 0 && text.length > 0) {
    const snippet = text.slice(0, Math.min(200, text.length));
    quotes.push({ text: snippet, start: 0, end: snippet.length });
  }

  return quotes;
}

function buildChunks(
  text: string,
  opts?: { chunkSize?: number; overlap?: number }
): ExtractedChunk[] {
  const chunkSize = opts?.chunkSize ?? 2000;
  const overlap = opts?.overlap ?? 200;
  if (chunkSize <= 0) return [];
  const chunks: ExtractedChunk[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + chunkSize);
    chunks.push({ start, end, text: text.slice(start, end) });
    if (end >= text.length) break;
    start = Math.max(0, end - overlap);
  }
  return chunks;
}

export function extractFromHtml(html: string, opts?: { url?: string }): ExtractedEvidence {
  const dom = new JSDOM(html, { url: opts?.url ?? "https://example.invalid" });
  const doc = dom.window.document;

  // Remove the most common non-content nodes before readability.
  doc.querySelectorAll("script, style, noscript").forEach((n) => n.remove());

  const reader = new Readability(doc);
  const article = reader.parse();

  const rawText = article?.textContent?.trim()
    ? article.textContent
    : doc.body?.textContent?.trim()
      ? doc.body.textContent
      : "";

  const title =
    (article?.title && article.title.trim()) ||
    doc.querySelector("title")?.textContent?.trim() ||
    null;

  const publisher =
    getMeta(doc, "og:site_name") ||
    getMeta(doc, "application-name") ||
    getMeta(doc, "twitter:site") ||
    null;

  const authors = [
    ...(getMeta(doc, "author") ? [getMeta(doc, "author")!] : []),
    ...(article?.byline ? [article.byline] : []),
  ]
    .map((a) => a.trim())
    .filter(Boolean);

  const publishedAt =
    getMeta(doc, "article:published_time") ||
    getMeta(doc, "og:published_time") ||
    getMeta(doc, "publication_date") ||
    getMeta(doc, "date") ||
    null;

  const contentText = normalizeWhitespace(stripPromptInjection(normalizeWhitespace(rawText)));

  return {
    contentText,
    metadata: { title, publisher, authors, publishedAt },
    quotes: buildQuotes(contentText, 5),
    chunks: buildChunks(contentText, { chunkSize: 2000, overlap: 200 }),
  };
}

export function extractFromText(
  text: string,
  metadata?: Partial<ExtractedMetadata>
): ExtractedEvidence {
  const contentText = normalizeWhitespace(stripPromptInjection(normalizeWhitespace(text)));
  return {
    contentText,
    metadata: {
      title: metadata?.title ?? null,
      publisher: metadata?.publisher ?? null,
      authors: metadata?.authors ?? [],
      publishedAt: metadata?.publishedAt ?? null,
    },
    quotes: buildQuotes(contentText, 5),
    chunks: buildChunks(contentText, { chunkSize: 2000, overlap: 200 }),
  };
}
