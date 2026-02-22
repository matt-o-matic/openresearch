import { z } from "zod";

import type { QuestionGraph } from "./goal-directed.js";

export const OutlineSectionPlanSchema = z
  .object({
    id: z.string().min(1),
    heading: z.string().min(1),
    intent: z.string().min(1),
    dependsOnQuestionIds: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type OutlineSectionPlan = z.infer<typeof OutlineSectionPlanSchema>;

export const OutlinePlanSchema = z
  .object({
    version: z.literal(1).default(1),
    rationale: z.string().min(1).optional(),
    sections: z.array(OutlineSectionPlanSchema).min(1).max(12),
    notes: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type OutlinePlan = z.infer<typeof OutlinePlanSchema>;

function normalizeHeading(raw: string): string {
  const trimmed = raw.replace(/\s+/g, " ").trim();
  return trimmed.length <= 96 ? trimmed : `${trimmed.slice(0, 93).trimEnd()}...`;
}

function normalizeSectionId(raw: string, index: number): string {
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) return `section-${index + 1}`;
  return base.slice(0, 48);
}

function titleFromQuestion(text: string, index: number): string {
  const t = text.replace(/\?+$/, "").trim();
  if (!t) return `Question ${index + 1}`;
  const normalized = normalizeHeading(t);
  return `Question ${index + 1}: ${normalized}`;
}

export function buildFallbackOutlinePlan(input: {
  prompt: string;
  subquestions: string[];
  questionGraph?: QuestionGraph | null;
}): OutlinePlan {
  const graphQuestions =
    input.questionGraph?.questions
      .map((q) => ({
        id: q.id,
        text: q.text.trim(),
        dependsOnQuestionIds: q.dependsOn.slice(),
      }))
      .filter((q) => q.text.length > 0) ?? [];

  const questionSections =
    graphQuestions.length > 0
      ? graphQuestions
      : input.subquestions
          .map((text, index) => ({
            id: `q${index + 1}`,
            text: text.trim(),
            dependsOnQuestionIds: [] as string[],
          }))
          .filter((q) => q.text.length > 0);

  const sections: OutlineSectionPlan[] = [];

  sections.push({
    id: "summary",
    heading: "Summary",
    intent: `High-level answer to: ${input.prompt.trim() || "the research prompt"}`,
    dependsOnQuestionIds: [],
  });

  for (let i = 0; i < Math.min(questionSections.length, 8); i += 1) {
    const question = questionSections[i]!;
    sections.push({
      id: normalizeSectionId(question.id, i + 1),
      heading: titleFromQuestion(question.text, i),
      intent: question.text,
      dependsOnQuestionIds: question.dependsOnQuestionIds,
    });
  }

  sections.push({
    id: "unknowns",
    heading: "Unknowns and Open Questions",
    intent: "Capture unresolved questions, missing evidence, and uncertainty.",
    dependsOnQuestionIds: [],
  });

  sections.push({
    id: "sources",
    heading: "Sources",
    intent: "Provide the source list used in this report.",
    dependsOnQuestionIds: [],
  });

  return OutlinePlanSchema.parse({
    version: 1,
    rationale: "Fallback outline generated from prompt and extracted questions.",
    sections,
    notes: [],
  });
}

export function coerceOutlinePlan(
  raw: unknown,
  opts?: { fallback?: OutlinePlan | null }
): OutlinePlan | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return opts?.fallback ?? null;
  const parsed = OutlinePlanSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const asRecord = raw as Record<string, unknown>;
  const rawSections = Array.isArray(asRecord.sections) ? asRecord.sections : [];
  const sections: OutlineSectionPlan[] = [];
  for (let i = 0; i < rawSections.length; i += 1) {
    const item = rawSections[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const section = item as Record<string, unknown>;
    const heading = typeof section.heading === "string" ? normalizeHeading(section.heading) : "";
    const intent = typeof section.intent === "string" ? section.intent.trim() : heading;
    if (!heading || !intent) continue;
    const rawId = typeof section.id === "string" ? section.id : heading;
    const deps = Array.isArray(section.dependsOnQuestionIds)
      ? section.dependsOnQuestionIds
          .map((dep) => {
            if (typeof dep === "string") return dep.trim();
            if (typeof dep === "number" && Number.isFinite(dep)) return String(dep);
            return "";
          })
          .filter(Boolean)
      : [];
    sections.push({
      id: normalizeSectionId(rawId, i),
      heading,
      intent,
      dependsOnQuestionIds: Array.from(new Set(deps)),
    });
  }

  if (sections.length === 0) return opts?.fallback ?? null;

  const notes = Array.isArray(asRecord.notes)
    ? asRecord.notes
        .map((note) => (typeof note === "string" ? note.trim() : ""))
        .filter(Boolean)
    : [];

  const normalized = OutlinePlanSchema.safeParse({
    version: 1,
    rationale: typeof asRecord.rationale === "string" ? asRecord.rationale.trim() : undefined,
    sections: sections.slice(0, 12),
    notes,
  });
  return normalized.success ? normalized.data : opts?.fallback ?? null;
}
