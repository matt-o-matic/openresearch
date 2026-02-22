import { z } from "zod";

import type { PipelinePhase, PipelineStore, RunCheckpoint } from "./orchestrator.js";

const DbRunCheckpointSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["iteration", "finalize"]).optional(),
    iteration_completed: z.number().int().nonnegative().optional(),
    payload: z.unknown(),
  })
  .passthrough();

function isPipelinePhase(value: unknown): value is PipelinePhase {
  return (
    value === "plan" ||
    value === "retrieve" ||
    value === "report-plan" ||
    value === "fetch" ||
    value === "extract" ||
    value === "synthesize" ||
    value === "verify" ||
    value === "finalize"
  );
}

function isRunCheckpointLike(value: unknown): value is RunCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  if (o.version !== 1) return false;
  if (!isPipelinePhase(o.nextPhase)) return false;
  return true;
}

export async function restoreRunStateFromLatestCheckpoint(input: {
  runId: string;
  store: PipelineStore;
}): Promise<
  | { restored: false }
  | {
      restored: true;
      checkpointId: string;
      kind: "iteration" | "finalize" | "unknown";
      iterationCompleted: number | null;
    }
> {
  if (!input.store.getLatestValidRunCheckpoint) return { restored: false };

  const row = await input.store.getLatestValidRunCheckpoint(input.runId);
  const parsedRow = DbRunCheckpointSchema.safeParse(row);
  if (!parsedRow.success) return { restored: false };

  const payload = parsedRow.data.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { restored: false };
  const pipelineCheckpoint = (payload as { pipelineCheckpoint?: unknown }).pipelineCheckpoint;
  if (!isRunCheckpointLike(pipelineCheckpoint)) return { restored: false };

  await input.store.updateRun({
    runId: input.runId,
    state: pipelineCheckpoint,
    phase: pipelineCheckpoint.nextPhase,
  });

  return {
    restored: true,
    checkpointId: parsedRow.data.id,
    kind: parsedRow.data.kind ?? "unknown",
    iterationCompleted: parsedRow.data.iteration_completed ?? null,
  };
}
