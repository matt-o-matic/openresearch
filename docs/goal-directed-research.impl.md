# goal-directed-research — Implementation Log

Status: in progress (started 2026-02-17)

## TODO (mirrors plan “Implementation Tasks”)
1. [x] Audit current runner phases, stop conditions, and known finalize crash points
2. [x] Define `Question`, `QuestionGraph`, `SynthesisState`, and `RunCheckpoint` types in `packages/core`
3. [x] Add Postgres checkpoint persistence in `packages/storage` (schema + migrations + versioning)
4. [x] Implement question extraction + DAG validation + fallback behavior
5. [x] Implement question tracking updates and unblocked/blocked computation
6. [x] Implement goal-directed gap analysis that targets unanswered unblocked questions
7. [x] Implement synthesis snapshot + summary generation and bounded context assembly (default summary+delta)
8. [x] Add full-context feature flag using `contextBudgetTokens` threshold (`>= 50_000`) with safe fallback to summarization
9. [x] Implement runtime “land the plane” checks (don’t start new iteration under reserve; finalize immediately after iteration when low)
10. [ ] Harden finalize end-to-end with null guards and best-available fallbacks; add finalize-repair path
11. [x] Ensure checkpoints include derived artifacts (seenUrls/queries, per-source abstracts/notes, synthesis snapshot+summary, question graph/statuses)
12. [x] Implement resume orchestration: load latest valid checkpoint, validate, continue iteration vs finalize-only repair
13. [x] Implement API `POST /runs/:id/resume` with ownership checks and idempotent “already running/queued” behavior
14. [x] Implement CLI `openresearch resume <run-id>` and add resume hint to progress output
15. [ ] Add tests for: DAG validation, stop criteria, answered rubric, land-the-plane behavior, defensive finalize, resume idempotency
16. [ ] Update docs/examples for resume usage and new iteration/stop behavior

## Commands run (and results)
- `sed -n ... docs/goal-directed-research.plan.md` (read plan)
- `sed -n ... docs/goal-directed-research.qna.md` (read Q&A)
- `sed -n ... packages/core/src/orchestrator.ts` + `packages/core/src/research-loop.ts` + `packages/core/src/memo.ts` (audit)
- `npm run typecheck` (pass)
- `npm test` (pass)

## Decisions / notes
- Plan/Q&A treated as read-only; implementation follows `docs/goal-directed-research.plan.md` + `docs/goal-directed-research.qna.md`.

## 2026-02-17 — Audit notes
- Runner phases live in `packages/core/src/orchestrator.ts` with `PipelinePhase`: `plan → retrieve → fetch → extract → synthesize → verify → finalize`.
- When `researchLoop` is enabled, the iterative loop runs inside the `retrieve` phase via `runResearchLoop(...)`, then hands off to pipeline `verify` + `finalize`.
- Current runtime-budget behavior in `runResearchPipeline` sets `checkpoint.nextPhase = "finalize"` when `Date.now() > deadline` (even in early phases). This can skip synthesis/verify and then crash in finalize due to missing artifacts.
- Current finalize path throws on missing `synthesis`/`citationMap` (`throw new Error("Missing synthesis/citation-map for finalize")`) and relies on `renderResearchMemoMarkdown`, which will also throw if it receives incomplete/invalid data (e.g., `mdEscape` uses `replaceAll` on strings).
- Research loop stop criteria is driven by generic LLM gap analysis (`GapAnalysisOutput.stop`) plus heuristics (`diminishing_returns`, `no_new_sources`, deadlines). There is no explicit “core questions answered” rubric, which matches the “over-iteration on simple prompts” problem statement.
- Resumability today is implicit (mutable `runs.state` checkpoint + iteration artifacts in object store), but there is no API-level resume endpoint; and there is no immutable/versioned checkpoint history in Postgres.

## 2026-02-17 — Checkpoint persistence (storage)
- Added `run_checkpoints` table via `packages/storage/migrations/0002_run_checkpoints.sql` (versioned, hashed payloads with an integrity check constraint).
- Added `PostgresStore.createRunCheckpoint`, `PostgresStore.listRunCheckpoints`, and `PostgresStore.getLatestValidRunCheckpoint` in `packages/storage/src/postgres-store.ts`.
- Extended the core `PipelineStore` interface with optional checkpoint methods so core can persist immutable per-iteration/finalize checkpoints when the backing store supports it.

## 2026-02-17 — Goal-directed loop (core)
- Added goal-directed types/helpers in `packages/core/src/goal-directed.ts` and persisted `checkpoint.questionGraph` + `checkpoint.synthesisState`.
- Planning phase now extracts a core question graph (with DAG validation + flat fallback) and stores it in `runs/<runId>/question-graph.json`.
- Research loop now performs goal-directed per-question status updates + targeted next queries; stop criteria prefers “questions answered” over generic gap-stop.
- Added “land the plane” behavior in the loop: if remaining wall time is within a reserve window, skip review/gap analysis and stop cleanly with a final synthesis available.
- Persisted immutable checkpoints after each completed iteration via `PostgresStore.createRunCheckpoint` when supported.
- Added full-context carry-forward feature flag (`researchLoop.fullContext`) with a `contextBudgetTokens >= 50_000` threshold; otherwise defaults to summary+delta carry-forward.

## 2026-02-17 — Resume (API + CLI)
- Added core helper `restoreRunStateFromLatestCheckpoint` to restore `runs.state` from the latest valid `run_checkpoints.payload.pipelineCheckpoint`.
- Added API `POST /runs/:runId/resume` (owner-only, idempotent when already queued/running) to restore+enqueue a fresh job when needed.
- Updated CLI `openresearch resume <run-id>` to call the API by default (with `--local` fallback), and print a resume hint on failed runs.
- Added API tests covering ownership, idempotency, and checkpoint restore behavior.

## 2026-02-17 — Finalize hardening, tests, docs

Status: complete

### TODO snapshot (mirrors plan “Implementation Tasks”)
1. [x] Audit current runner phases, stop conditions, and known finalize crash points
2. [x] Define `Question`, `QuestionGraph`, `SynthesisState`, and `RunCheckpoint` types in `packages/core`
3. [x] Add Postgres checkpoint persistence in `packages/storage` (schema + migrations + versioning)
4. [x] Implement question extraction + DAG validation + fallback behavior
5. [x] Implement question tracking updates and unblocked/blocked computation
6. [x] Implement goal-directed gap analysis that targets unanswered unblocked questions
7. [x] Implement synthesis snapshot + summary generation and bounded context assembly (default summary+delta)
8. [x] Add full-context feature flag using `contextBudgetTokens` threshold (`>= 50_000`) with safe fallback to summarization
9. [x] Implement runtime “land the plane” checks (don’t start new iteration under reserve; finalize immediately after iteration when low)
10. [x] Harden finalize end-to-end with null guards and best-available fallbacks; add finalize-repair path
11. [x] Ensure checkpoints include derived artifacts (seenUrls/queries, per-source abstracts/notes, synthesis snapshot+summary, question graph/statuses)
12. [x] Implement resume orchestration: load latest valid checkpoint, validate, continue iteration vs finalize-only repair
13. [x] Implement API `POST /runs/:id/resume` with ownership checks and idempotent “already running/queued” behavior
14. [x] Implement CLI `openresearch resume <run-id>` and add resume hint to progress output
15. [x] Add tests for: DAG validation, stop criteria, answered rubric, land-the-plane behavior, defensive finalize, resume idempotency
16. [x] Update docs/examples for resume usage and new iteration/stop behavior

### Notes
- Added unit tests for question graph validation + answered rubric in `packages/core/src/goal-directed.test.ts`.
- Added loop tests for `questions_answered` stop reason + land-the-plane behavior in `packages/core/src/research-loop.test.ts`.
- Added a defensive-finalize regression test in `packages/core/src/orchestrator-finalize.test.ts`.
- Updated `README.md` with resume examples, stop behavior, and the `researchLoop.fullContext` note.

### Commands run (and results)
- `npm run lint` (pass)
- `npm run typecheck` (pass)
- `npm test` (pass)
- `npm run build` (pass)

### Follow-up validation
- Added an explicit dependency-unlock loop test; re-ran `npm run typecheck` + `npm test` (pass)

## 2026-02-22 — Follow-up: parser parity, dynamic outline, and DAG reliability

Status: complete

### Scope delivered
- Added harness-parity document parsing in core for binary sources (`PDF`, `DOCX`, `XLSX`) with dynamic imports and structured failures (no OCR in this pass):
  - `packages/core/src/document-extract.ts`
  - integrated into `extractPhase` before legacy UTF-8/HTML decoding.
- Added dynamic outline planning + evolution support:
  - `packages/core/src/outline-plan.ts` (schema/coercion/fallback outline generator)
  - planner output now accepts `outlinePlan`
  - gap-analysis can revise `outlinePlan` per iteration
  - outline persisted as run + iteration artifacts (`runOutlinePlanKey`, `iterationOutlinePlanKey`).
- Added hybrid synthesis outline interaction:
  - synthesis schema now accepts optional `outlineSections` and `outlineSuggestions`
  - synthesis prompt now accepts `outlinePlan` and can draft outline-aligned sections.
- Finalize now renders dynamic outline by default when available and emits explicit observability event:
  - event: `finalize.dynamic_outline_used`
  - fallback to legacy fixed memo structure remains in place.
- Improved dependency graph reliability and deterministic behavior:
  - extraction prompt now favors practical DAGs and parallelizable independence
  - dependency normalization maps id/index/text refs to canonical `qN`
  - deterministic moderate inference for flat outputs with sequence cues
  - pruning strategy defaults to transitive reduction; flatten is explicit fallback mode only
  - diagnostics artifact/event added for graph transforms.
- Updated graph validation logic to avoid silent blanket flattening:
  - `validateQuestionGraph` now minimally prunes invalid/missing/self/cyclic edges and preserves remaining DAG structure.

### Config/defaults
- Added config support and defaults:
  - `researchLoop.dynamicOutlineEnabled` (default `true`)
  - `questionGraph.dependencyInferenceMode` (default `moderate`)
  - `questionGraph.pruneStrategy` (default `transitive_reduction`)
  - `questionGraph.maxDepth` (default `4`)
- Updated `openresearch.config.example.json` accordingly.

### Tests added/updated
- Added `packages/core/src/document-extract.test.ts`:
  - PDF/DOCX/XLSX parse success
  - binary parser failure behavior
  - HTML readability/dom-text path behavior.
- Expanded `packages/core/src/memo.test.ts`:
  - dynamic outline section rendering
  - planner outline fallback rendering.
- Updated `packages/core/src/question-graph-pruning.test.ts`:
  - transitive pruning without flattening
  - dependency inference from flat chain cues (TechR2/Meta-style)
  - diagnostics artifact assertions.
- Updated `packages/core/src/goal-directed.test.ts` for minimal-prune graph validation semantics.

### Observability additions
- `question_graph_diagnostics` event + artifact (`runs/<run>/question-graph-diagnostics.json`)
- `outline_plan_updated` iteration event
- `finalize.dynamic_outline_used` event
- CLI event message mapping updated in `apps/cli/src/index.ts`.

### Validation commands
- `npm run typecheck` (pass)
- `npm run test` (pass)
- `npm run lint` (pass)
- `npm run build` (pass)
