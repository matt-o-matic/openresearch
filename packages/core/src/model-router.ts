import type { PhaseModelConfig } from "./config.js";

export type ModelPhase = "plan" | "synthesize" | "verify";

export class ModelRouter {
  private readonly models: PhaseModelConfig;

  constructor(models: PhaseModelConfig) {
    this.models = models;
  }

  modelForPhase(phase: ModelPhase, opts?: { escalateVerifier?: boolean }): string {
    if (phase === "plan") return this.models.planner;
    if (phase === "synthesize") return this.models.synthesizer;
    if (phase === "verify")
      return opts?.escalateVerifier ? this.models.verifierStrong : this.models.verifier;
    return this.models.synthesizer;
  }
}
