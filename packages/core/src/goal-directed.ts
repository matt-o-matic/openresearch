import { z } from "zod";

export type QuestionStatus = "unanswered" | "partial" | "answered" | "unanswerable";

export const QuestionEvidenceSchema = z
  .object({
    source: z.string().min(1).optional(), // internal: source label (e.g., "S1")
    quoteId: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
  })
  .strict();
export type QuestionEvidence = z.infer<typeof QuestionEvidenceSchema>;

export const QuestionSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    dependsOn: z.array(z.string().min(1)).default([]),
    status: z.enum(["unanswered", "partial", "answered", "unanswerable"]).default("unanswered"),
    evidence: z.array(QuestionEvidenceSchema).default([]),
    confidence: z.number().min(0).max(1).optional(),
    updatedAtIteration: z.number().int().nonnegative().optional(),
  })
  .strict();
export type Question = z.infer<typeof QuestionSchema>;

export const QuestionGraphSchema = z
  .object({
    questions: z.array(QuestionSchema).default([]),
    validated: z.boolean().default(false),
  })
  .strict();
export type QuestionGraph = z.infer<typeof QuestionGraphSchema>;

export const SynthesisStateSchema = z
  .object({
    snapshotKey: z.string().min(1).optional(),
    summary: z.string().min(1).optional(),
    perQuestion: z.record(z.string().min(1)).optional(),
  })
  .strict();
export type SynthesisState = z.infer<typeof SynthesisStateSchema>;

export function computeUnblockedQuestions(graph: QuestionGraph): Question[] {
  const byId = new Map(graph.questions.map((q) => [q.id, q]));
  const answered = new Set(
    graph.questions
      .filter((q) => q.status === "answered" || q.status === "unanswerable")
      .map((q) => q.id)
  );
  return graph.questions.filter((q) => q.dependsOn.every((dep) => answered.has(dep) || !byId.has(dep)));
}

export function normalizeQuestionAnsweredRubric(question: Question): Question {
  if (question.status !== "answered") return question;
  const hasEvidence = question.evidence.some((e) => Boolean(e.source));
  if (hasEvidence) return question;
  return { ...question, status: "partial" };
}

export function validateQuestionGraph(input: QuestionGraph): QuestionGraph {
  const normalizedQuestions: Question[] = [];
  const usedIds = new Set<string>();
  let mutated = false;

  const reserveId = (rawId: string, index: number): string => {
    const trimmed = rawId.trim();
    const base =
      trimmed.length > 0 && !usedIds.has(trimmed)
        ? trimmed
        : `q${index + 1}`;
    let candidate = base;
    let suffix = 2;
    while (usedIds.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    if (candidate !== trimmed) mutated = true;
    usedIds.add(candidate);
    return candidate;
  };

  for (let i = 0; i < input.questions.length; i += 1) {
    const q = input.questions[i]!;
    const id = reserveId(q.id, i);
    normalizedQuestions.push({
      ...q,
      id,
    });
  }

  const idSet = new Set(normalizedQuestions.map((q) => q.id));
  const sanitizedDeps = new Map<string, string[]>();

  for (const q of normalizedQuestions) {
    const deps: string[] = [];
    for (const depRaw of q.dependsOn) {
      const dep = depRaw.trim();
      if (!dep || dep === q.id) {
        if (depRaw.trim().length > 0) mutated = true;
        continue;
      }
      if (!idSet.has(dep)) {
        mutated = true;
        continue;
      }
      if (!deps.includes(dep)) deps.push(dep);
      else mutated = true;
    }
    sanitizedDeps.set(q.id, deps);
  }

  const hasPath = (
    fromId: string,
    targetId: string,
    adjacency: Map<string, string[]>,
    visited: Set<string>
  ): boolean => {
    if (fromId === targetId) return true;
    if (visited.has(fromId)) return false;
    visited.add(fromId);
    const deps = adjacency.get(fromId) ?? [];
    for (const dep of deps) {
      if (hasPath(dep, targetId, adjacency, visited)) return true;
    }
    return false;
  };

  const acyclicDeps = new Map<string, string[]>();
  for (const q of normalizedQuestions) {
    const deps = sanitizedDeps.get(q.id) ?? [];
    const kept: string[] = [];
    for (const dep of deps) {
      const adjacency = new Map(acyclicDeps);
      adjacency.set(q.id, kept);
      if (hasPath(dep, q.id, adjacency, new Set<string>())) {
        mutated = true;
        continue;
      }
      kept.push(dep);
    }
    acyclicDeps.set(q.id, kept);
  }

  const questions = normalizedQuestions.map((q) => ({
    ...q,
    dependsOn: acyclicDeps.get(q.id) ?? [],
  }));

  return {
    validated: !mutated,
    questions,
  };
}
