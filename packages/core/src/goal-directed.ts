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
  const questions = input.questions;
  const byId = new Map<string, Question>();
  for (const q of questions) {
    if (!q.id || byId.has(q.id)) {
      return {
        validated: false,
        questions: questions.map((qq) => ({
          ...qq,
          dependsOn: [],
        })),
      };
    }
    byId.set(q.id, q);
  }

  for (const q of questions) {
    for (const dep of q.dependsOn) {
      if (!byId.has(dep)) {
        return {
          validated: false,
          questions: questions.map((qq) => ({
            ...qq,
            dependsOn: [],
          })),
        };
      }
    }
  }

  // Acyclic check (DFS)
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycleFrom = (id: string): boolean => {
    if (visited.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    const q = byId.get(id);
    if (q) {
      for (const dep of q.dependsOn) {
        if (hasCycleFrom(dep)) return true;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  for (const q of questions) {
    if (hasCycleFrom(q.id)) {
      return {
        validated: false,
        questions: questions.map((qq) => ({
          ...qq,
          dependsOn: [],
        })),
      };
    }
  }

  return { validated: true, questions };
}
