import { describe, expect, it } from "vitest";

import {
  QuestionGraphSchema,
  computeUnblockedQuestions,
  normalizeQuestionAnsweredRubric,
  validateQuestionGraph,
} from "./goal-directed.js";

describe("goal-directed", () => {
  it("validates an acyclic question DAG", () => {
    const graph = QuestionGraphSchema.parse({
      validated: false,
      questions: [
        { id: "q1", text: "One", dependsOn: [], status: "answered", evidence: [{ source: "S1" }] },
        { id: "q2", text: "Two", dependsOn: ["q1"], status: "unanswered", evidence: [] },
      ],
    });

    const out = validateQuestionGraph(graph);
    expect(out.validated).toBe(true);
    expect(out.questions.map((q) => q.id)).toEqual(["q1", "q2"]);
    expect(out.questions[1]?.dependsOn).toEqual(["q1"]);
  });

  it("drops dependencies that reference missing ids", () => {
    const graph = QuestionGraphSchema.parse({
      validated: false,
      questions: [{ id: "q1", text: "One", dependsOn: ["q999"], status: "unanswered", evidence: [] }],
    });

    const out = validateQuestionGraph(graph);
    expect(out.validated).toBe(false);
    expect(out.questions[0]?.dependsOn).toEqual([]);
  });

  it("renames duplicated ids and preserves valid dependencies", () => {
    const graph = QuestionGraphSchema.parse({
      validated: false,
      questions: [
        { id: "q1", text: "One", dependsOn: [], status: "unanswered", evidence: [] },
        { id: "q1", text: "Duplicate", dependsOn: ["q1"], status: "unanswered", evidence: [] },
      ],
    });

    const out = validateQuestionGraph(graph);
    expect(out.validated).toBe(false);
    expect(out.questions.map((q) => q.id)).toEqual(["q1", "q2"]);
    expect(out.questions[1]?.dependsOn).toEqual(["q1"]);
  });

  it("breaks cycles by dropping minimal edges", () => {
    const graph = QuestionGraphSchema.parse({
      validated: false,
      questions: [
        { id: "q1", text: "One", dependsOn: ["q2"], status: "unanswered", evidence: [] },
        { id: "q2", text: "Two", dependsOn: ["q1"], status: "unanswered", evidence: [] },
      ],
    });

    const out = validateQuestionGraph(graph);
    expect(out.validated).toBe(false);
    expect(out.questions[0]?.dependsOn).toEqual(["q2"]);
    expect(out.questions[1]?.dependsOn).toEqual([]);
  });

  it("computes unblocked questions based on answered dependencies", () => {
    const graph = QuestionGraphSchema.parse({
      validated: true,
      questions: [
        { id: "q1", text: "One", dependsOn: [], status: "answered", evidence: [{ source: "S1" }] },
        { id: "q2", text: "Two", dependsOn: ["q1"], status: "unanswered", evidence: [] },
        { id: "q3", text: "Three", dependsOn: ["q2"], status: "unanswered", evidence: [] },
      ],
    });

    const unblocked = computeUnblockedQuestions(graph).map((q) => q.id);
    expect(unblocked).toEqual(["q1", "q2"]);
  });

  it("downgrades answered questions without evidence sources to partial", () => {
    const normalized = normalizeQuestionAnsweredRubric({
      id: "q1",
      text: "One",
      dependsOn: [],
      status: "answered",
      evidence: [{ note: "no source label" }],
    });
    expect(normalized.status).toBe("partial");

    const keepsAnswered = normalizeQuestionAnsweredRubric({
      id: "q2",
      text: "Two",
      dependsOn: [],
      status: "answered",
      evidence: [{ source: "S1", note: "has label" }],
    });
    expect(keepsAnswered.status).toBe("answered");
  });
});
