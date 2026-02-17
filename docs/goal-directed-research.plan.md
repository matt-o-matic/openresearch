# goal-directed-research — Plan
Related Q&A: `docs/goal-directed-research.qna.md`

## Problem
- Over-iteration on simple prompts: gap analysis asks “what else could I learn?” instead of confirming core questions are answered; runs can iterate until budget exhaustion.
- Budget exhaustion can crash finalize (e.g., string ops on `undefined`), losing otherwise valid synthesis.
- No resumability: if a run fails or times out, completed iterations are lost and cannot be continued.

## Goals
- Extract explicit core questions from the prompt during planning, optionally with dependencies (DAG).
- Track per-question completion (`unanswered | partial | answered`) with evidence/confidence, and use it for stop criteria and targeted gap analysis.
- Keep synthesis context size bounded: iteration 1 builds a synthesis snapshot; later iterations carry forward a summary plus only new source abstracts/deltas.
- Implement “land the plane” behavior under time pressure: finish current iteration and produce final writing output, skipping further gap analysis when necessary.
- Make finalize defensive and never throw; always emit best-available user output.
- Add run resumability: checkpoint after each completed iteration in server-side Postgres; resume continues from the latest checkpoint without re-fetching seen sources.
- Provide resume entrypoints: CLI `openresearch resume <run-id>` and API `POST /runs/:id/resume` (owner-only, idempotent).

## Non-goals
- Local/offline checkpoint persistence for CLI runs (CLI is a thin client; persistence is server-side Postgres).
- Exposing question tracking, incomplete-section lists, or “ran out of time” metadata in user-facing outputs.
- Storing raw fetched documents (HTML/full text) in checkpoints (derived artifacts only).
- Perfect question extraction for all prompts on day 1; initial implementation must be debuggable and safe with fallbacks.

## Assumptions
- Runs and iterations already exist conceptually, with a planning step and a finalize step.
- The API layer has authentication and a notion of a run owner.
- The system can maintain `seenUrls` and `seenQueries` and honor them to avoid re-fetching on resume.
- Token budgets can be computed per run/model to derive an internal `contextBudgetTokens`.

## Decisions
- Checkpoints are persisted in server-side Postgres (API-managed); CLI is a thin client.
- Resumes continue the same `runId` (no new run id); resume/repair events are recorded in run metadata.
- Dependencies between questions are encoded as an explicit DAG; validate acyclic; fall back to a flat list if invalid.
- Question completion is tri-state with evidence/confidence; default “answered” rubric: direct answer + at least 1 credible citation/source.
- Goal-directed loop replaces generic gap analysis; stop when all unblocked questions are answered (or `maxIterations` reached).
- Budget policy favors clean termination: always finish the current iteration; if time is low at iteration end, bypass review/gap analysis and go directly to final synthesis output (“land the plane”).
- Synthesis carry-forward default: prior synthesis summary + new abstracts/deltas only.
- Full-context carry-forward is behind a feature flag; when enabled, include full prior context only if internal computed `contextBudgetTokens >= 50_000`, otherwise summarize.
- Question tracking + incomplete-section reporting is internal-only (stored/logged server-side) and not exposed in user outputs.
- `POST /runs/:id/resume` is owner-only and idempotent; if the run is already running/queued, return current status and do not enqueue duplicate work.
- Rollout is default-on (green field).

## Design
### Data model (core)
- `Question`
  - `id`: stable within a run (e.g., `q1`, `q2`, ...)
  - `text`: question text
  - `dependsOn`: `QuestionId[]`
  - `status`: `unanswered | partial | answered`
  - `evidence`: internal references to sources/notes
  - `confidence`: internal score/bucket
  - `updatedAtIteration`: number
- `QuestionGraph`
  - `questions: Question[]`
  - `validated: boolean`
- `SynthesisState`
  - `snapshot`: best current synthesis (structured + narrative)
  - `summary`: compressed representation used as carry-forward context
  - `perQuestion`: optional per-question mini-summaries for targeted updates
- `RunCheckpoint` (versioned)
  - `runId`, `checkpointVersion`, `iterationCompleted`, `seenUrls`, `seenQueries`, `questionGraph`, `synthesisState`, `sourceArtifacts`, `mode/config`, `timing/budgets`, `createdAt`

### Checkpoint payload contents (Postgres)
Each checkpoint stores derived artifacts sufficient to resume without re-fetching:
- `seenUrls` and `seenQueries`
- per-source abstracts/notes (not raw HTML/full text)
- `synthesisState.snapshot` and `synthesisState.summary` (and optionally `perQuestion`)
- question graph and per-question statuses

### Planning phase: question extraction
- Extract a set of core questions from the prompt.
- Extract dependencies when needed; build a DAG and validate acyclic.
- If DAG validation fails, persist a flat list and treat all questions as unblocked.
- Persist extraction output in the checkpoint for internal debugging.

### Iteration phase: goal-directed gap analysis
- Compute `unblocked = questions where all dependsOn are answered`.
- For each unblocked question:
  - classify status (`answered`/`partial`/`unanswered`) using the rubric
  - identify missing evidence and propose targeted next queries
- Use the question map to decide whether another iteration is needed and what to fetch next.

### Stop criteria
- Stop normally when all unblocked questions are `answered` and no blocked questions remain.
- Stop on `maxIterations` as a hard cap.
- Under time pressure, “land the plane”:
  - do not start a new iteration if remaining runtime is below a finalize reserve
  - if an iteration completes and remaining runtime is low, skip further review/gap analysis and finalize immediately

### Synthesis context management
- Iteration 1: include full new source abstracts and produce initial `snapshot` + `summary`.
- Iteration N>1 (default): include prior `summary` plus new abstracts/deltas only.
- Feature flag (full-context mode):
  - compute `contextBudgetTokens = modelMaxContextTokens - reservedOutputTokens - safetyMargin`
  - if `contextBudgetTokens >= 50_000`, include full prior context; otherwise fall back to summary+delta

### Defensive finalize (“never throw”)
- Guard all finalize operations (string ops, nested reads, missing arrays).
- If synthesis state is missing/incomplete, fall back to the best available snapshot/summary/notes from the last completed iteration.
- Do not add user-facing “ran out of time” sections; record internal diagnostics to logs/DB.
- Support finalize-repair: if iterations completed but finalize crashed, resume triggers finalize using the latest checkpoint without re-running research.

### Resumability: API + CLI
- After each completed iteration, write a checkpoint.
- After a successful finalize, write a final checkpoint/marker.
- API:
  - `POST /runs/:id/resume`:
    - owner-only
    - idempotent if run is already running/queued (return current status)
    - if run is resumable, continue from `iterationCompleted + 1`, or finalize-repair if iterations are done
- CLI:
  - `openresearch resume <run-id>` calls the API resume endpoint.
  - Runner/CLI output includes a deterministic resume hint when a run pauses/fails.

### Package boundaries / integration points
- `packages/core`: question extraction + tracking, stop criteria, context assembly, resume orchestration.
- `packages/adapters`: LLM prompt templates for question extraction/gap analysis/summarization; search adapters must honor `seenUrls/seenQueries`.
- `packages/storage`: Postgres checkpoint persistence, schema versioning, integrity checks.
- `apps/*`: API route + CLI command wiring.

## Implementation Tasks
1. [ ] Audit current runner phases, stop conditions, and known finalize crash points
2. [ ] Define `Question`, `QuestionGraph`, `SynthesisState`, and `RunCheckpoint` types in `packages/core`
3. [ ] Add Postgres checkpoint persistence in `packages/storage` (schema + migrations + versioning)
4. [ ] Implement question extraction + DAG validation + fallback behavior
5. [ ] Implement question tracking updates and unblocked/blocked computation
6. [ ] Implement goal-directed gap analysis that targets unanswered unblocked questions
7. [ ] Implement synthesis snapshot + summary generation and bounded context assembly (default summary+delta)
8. [ ] Add full-context feature flag using `contextBudgetTokens` threshold (`>= 50_000`) with safe fallback to summarization
9. [ ] Implement runtime “land the plane” checks (don’t start new iteration under reserve; finalize immediately after iteration when low)
10. [ ] Harden finalize end-to-end with null guards and best-available fallbacks; add finalize-repair path
11. [ ] Ensure checkpoints include derived artifacts (seenUrls/queries, per-source abstracts/notes, synthesis snapshot+summary, question graph/statuses)
12. [ ] Implement resume orchestration: load latest valid checkpoint, validate, continue iteration vs finalize-only repair
13. [ ] Implement API `POST /runs/:id/resume` with ownership checks and idempotent “already running/queued” behavior
14. [ ] Implement CLI `openresearch resume <run-id>` and add resume hint to progress output
15. [ ] Add tests for: DAG validation, stop criteria, answered rubric, land-the-plane behavior, defensive finalize, resume idempotency
16. [ ] Update docs/examples for resume usage and new iteration/stop behavior

## Validation
- [ ] Simple prompt stops early (e.g., solar efficiency completes in 1 iteration once questions are answered)
- [ ] Complex prompt respects dependencies and unlocks questions across iterations (TechR2/Meta example)
- [ ] Budget pressure triggers “land the plane”: current iteration completes and final synthesis is produced (no extra gap analysis)
- [ ] Finalize never crashes even with missing/partial state; produces best-available output
- [ ] Kill/restart worker mid-run; resume continues from last completed iteration
- [ ] Resume after finalize crash reruns finalize and emits output
- [ ] Resume does not re-fetch previously seen URLs/queries
- [ ] `POST /runs/:id/resume` is idempotent when run is running/queued
- [ ] CLI resume command works and prints clear progress/resume hints
- [ ] API resume enforces ownership and rejects cross-user resumes
