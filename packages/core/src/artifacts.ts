function ensureRel(key: string): string {
  if (key.startsWith("/")) throw new Error("artifact key must be relative");
  if (key.includes("..")) throw new Error("artifact key must not contain '..'");
  return key.replaceAll("\\", "/");
}

export function runPrefix(runId: string): string {
  return `runs/${runId}`;
}

export function runArtifactKey(runId: string, relative: string): string {
  return `${runPrefix(runId)}/${ensureRel(relative)}`;
}

export function sourcePrefix(runId: string, sourceId: string): string {
  return `${runPrefix(runId)}/sources/${sourceId}`;
}

export function sourceRawBodyKey(runId: string, sourceId: string): string {
  return `${sourcePrefix(runId, sourceId)}/raw-body.bin`;
}

export function sourceRenderedTextKey(runId: string, sourceId: string): string {
  return `${sourcePrefix(runId, sourceId)}/rendered.txt`;
}

export function sourceEvidenceKey(runId: string, sourceId: string): string {
  return `${runPrefix(runId)}/evidence/${sourceId}.json`;
}

export function runOutputKey(runId: string): string {
  return runArtifactKey(runId, "output.md");
}

export function runCitationMapKey(runId: string): string {
  return runArtifactKey(runId, "citation-map.json");
}

export function runVerificationJsonKey(runId: string): string {
  return runArtifactKey(runId, "verification-report.json");
}

export function runVerificationMarkdownKey(runId: string): string {
  return runArtifactKey(runId, "verification-report.md");
}

export function runRetrievalKey(runId: string): string {
  return runArtifactKey(runId, "retrieval.json");
}

export function runPlanKey(runId: string): string {
  return runArtifactKey(runId, "plan.json");
}

export function runSynthesisKey(runId: string): string {
  return runArtifactKey(runId, "synthesis.json");
}

export function runFinalSynthesisReviewKey(runId: string): string {
  return runArtifactKey(runId, "final/full-synthesis-review.json");
}

export function iterationPrefix(runId: string, iteration: number): string {
  const i = Math.max(0, Math.floor(iteration));
  return `${runPrefix(runId)}/iterations/${i}`;
}

export function iterationArtifactKey(runId: string, iteration: number, relative: string): string {
  const i = Math.max(0, Math.floor(iteration));
  return runArtifactKey(runId, `iterations/${i}/${relative}`);
}

export function iterationPlanKey(runId: string, iteration: number): string {
  return iterationArtifactKey(runId, iteration, "plan.json");
}

export function iterationRetrievalKey(runId: string, iteration: number): string {
  return iterationArtifactKey(runId, iteration, "retrieval.json");
}

export function iterationSynthesisKey(runId: string, iteration: number): string {
  return iterationArtifactKey(runId, iteration, "synthesis.json");
}

export function iterationCitationMapKey(runId: string, iteration: number): string {
  return iterationArtifactKey(runId, iteration, "citation-map.json");
}

export function iterationVerificationJsonKey(runId: string, iteration: number): string {
  return iterationArtifactKey(runId, iteration, "verification-report.json");
}

export function iterationVerificationMarkdownKey(runId: string, iteration: number): string {
  return iterationArtifactKey(runId, iteration, "verification-report.md");
}

export function iterationReviewKey(runId: string, iteration: number): string {
  return iterationArtifactKey(runId, iteration, "review.json");
}

export function iterationGapAnalysisKey(runId: string, iteration: number): string {
  return iterationArtifactKey(runId, iteration, "gap-analysis.json");
}

export function debugSourceRenderedHtmlKey(runId: string, sourceId: string): string {
  return runArtifactKey(runId, `debug/sources/${sourceId}/rendered.html`);
}

export function debugSourceTraceZipKey(runId: string, sourceId: string): string {
  return runArtifactKey(runId, `debug/sources/${sourceId}/trace.zip`);
}
