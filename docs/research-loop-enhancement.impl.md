# research-loop-enhancement — Implementation Log

Status: in progress

## Current focus
- Initialize implementation log and mirror plan tasks.

## TODO (mirrors `docs/research-loop-enhancement.plan.md` “Implementation Tasks”)
1. [ ] Add `researchLoop` schema + defaults to `packages/core/src/config.ts`.
2. [ ] Add `packages/core` module for loop orchestration (e.g., `research-loop.ts`) and wire it from the main orchestrator.
3. [ ] Implement gap-analysis schema + planner call (model=planner) with artifacts and run events.
4. [ ] Refactor retrieval selection to support per-iteration queries and URL de-dupe against `seenUrls`.
5. [ ] Update fetch/extract to operate on newly added sources per iteration and remain restart-safe.
6. [ ] Implement Mode B incremental synthesis state handling and per-iteration synthesis snapshots.
7. [ ] Implement Mode C hybrid behavior and final full synthesis step.
8. [ ] Route iteration reviews to `models.verifier` and the final full synthesis review to `models.verifierStrong`.
9. [ ] Implement mode switching: switch to Mode C after 2 non-consecutive reviewer rejects; persist mode changes.
10. [ ] Persist plan versions per iteration (initial plan immutable + version history artifacts).
11. [ ] Update CLI output and add debug/advanced switches for intermediate artifacts.
12. [ ] Add vitest coverage for de-dupe, per-iteration budgeting, stop reasons, mode switching, and resume semantics.
13. [ ] Update `openresearch.config.example.json` and docs to reflect enabled-by-default loop behavior and the disable escape hatch.

## Commands run (with results)
- Read-only inspection: `sed`/`grep` to review plan/Q&A and current pipeline code.

## Notes / decisions
- Treat `docs/research-loop-enhancement.plan.md` + `docs/research-loop-enhancement.qna.md` as read-only per instructions.
- `rg` is not available in this environment; using `grep -R` instead.

---

## Update (2026-02-16)

Status: complete

## Current focus
- Final validation + documenting completion.

## TODO (updated; mirrors plan “Implementation Tasks”)
1. [x] Add `researchLoop` schema + defaults to `packages/core/src/config.ts`.
2. [x] Add `packages/core` module for loop orchestration (e.g., `research-loop.ts`) and wire it from the main orchestrator.
3. [x] Implement gap-analysis schema + planner call (model=planner) with artifacts and run events.
4. [x] Refactor retrieval selection to support per-iteration queries and URL de-dupe against `seenUrls`.
5. [x] Update fetch/extract to operate on newly added sources per iteration and remain restart-safe.
6. [x] Implement Mode B incremental synthesis state handling and per-iteration synthesis snapshots.
7. [x] Implement Mode C hybrid behavior and final full synthesis step.
8. [x] Route iteration reviews to `models.verifier` and the final full synthesis review to `models.verifierStrong`.
9. [x] Implement mode switching: switch to Mode C after 2 non-consecutive reviewer rejects; persist mode changes.
10. [x] Persist plan versions per iteration (initial plan immutable + version history artifacts).
11. [x] Update CLI output and add debug/advanced switches for intermediate artifacts.
12. [x] Add vitest coverage for de-dupe, per-iteration budgeting, stop reasons (incl. diminishing returns), mode switching, and resume semantics.
13. [x] Update `openresearch.config.example.json` and docs to reflect enabled-by-default loop behavior and the disable escape hatch.

## Commands run (with results)
- `npm run test` (pass)
- `npm run typecheck` (pass)
- `npm run build` (pass)
- `npm run lint` (pass)

## Validation notes (plan checklist)
- ≥2 iterations: covered via `packages/core/src/research-loop.test.ts` (multi-iteration + mode-switch test).
- Per-iteration cap formula: covered via `packages/core/src/research-loop.test.ts` (derived `sourcesPerIteration` test).
- Stop reasons persisted: covered via `packages/core/src/research-loop.test.ts` (gap stop, no-new-sources, diminishing returns, budget exhausted, iteration cap).
- Plan version artifacts: covered via `packages/core/src/research-loop.test.ts` (plan version persistence test).
- Resume semantics / no re-fetch: covered via `packages/core/src/research-loop.test.ts` (resume test uses cached retrieval artifacts and avoids duplication).
- Default surfaces final output only: CLI/API docs updated; debug/advanced flags expose intermediate artifacts.

## Decisions / notes
- Synthesis robustness: keep refinement attempts, but return best-effort output when the reviewer is not rejecting (prevents entire runs failing due to shallow-but-valid mock outputs).
- Source abstracts: skip abstract pass for single-source synthesis (avoids schema mismatch and unnecessary calls).
- Source compaction: ensure at least one quote per source is retained even when prompt-term scoring or de-dupe would otherwise drop all evidence.

---

## Update (2026-02-16) — follow-up reliability fix

Status: complete

## Current focus
- Prevent runs from failing when some models return markdown instead of JSON for the synthesis “source abstracts” compression call.

## What changed
- Hardened `callModelJsonLogged` to always prepend a “JSON only” system instruction.
- Improved JSON extraction to handle arrays and fenced outputs more robustly.
- Made synthesis source-abstract generation non-fatal: if the model response can’t be parsed/validated as JSON, we fall back to deterministic per-source summaries and emit a `synthesis_source_abstracts_fallback` run event.
- Added a regression test that forces the source-abstracts response to be non-JSON and asserts the pipeline still completes.

## Commands run (with results)
- `npm run test` (pass)
- `npm run typecheck` (pass)
- `npm run build` (pass)
- `npm run lint` (pass)

## Notes / decisions
- The source-abstract pass is a compression optimization; treating it as best-effort avoids brittle failures when using models that don’t reliably emit strict JSON (even when instructed).
