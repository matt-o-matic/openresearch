# research-loop-enhancement — Plan

Related Q&A: `docs/research-loop-enhancement.qna.md`

## Problem
The pipeline currently behaves like a mostly single-pass flow (plan → retrieve → fetch/extract → synthesize → verify → finalize). Even though the plan phase can do multiple passes, the run does not repeatedly synthesize what it has learned, identify gaps/unknowns, and then pursue the next logical research step that depends on newly learned facts (you can’t know X until you learn Y). This makes the system brittle on dependency-chain prompts (e.g., compare two companies → find overlaps → identify capability gaps → identify responsible people/roles → validate).

## Goals
- Add an iterative research loop that, in small evidence batches:
  - synthesizes the current state,
  - detects gaps/unknowns and weakly-supported areas,
  - updates the plan/todo list with version history, and
  - schedules the next best research step (queries/tasks).
- Enable by default while preserving an explicit escape hatch to disable.
- Enforce global budgets and produce explicit stop reasons (gap-analysis stop, diminishing returns, no new sources, budget exhaustion, iteration cap).
- Persist per-iteration artifacts and events so runs are debuggable and resumable (no re-fetching already-seen URLs after restart).
- Keep default user-facing output unchanged (final memo + citations); keep intermediate artifacts available for debug/advanced inspection.

## Non-goals
- Human-in-the-loop UI for approving each iteration.
- Perfect completeness guarantees; this remains best-effort under budgets and source availability.
- Adding new search providers or storage backends as part of this change.

## Assumptions
- Global budgets remain authoritative and unchanged (e.g., `maxRuntimeMs`, `maxSources`, `maxFetches`, `maxBrowserRenders`). The loop subdivides work but must not exceed global caps.
- Gap analysis is a JSON-only model call and is logged/persisted like other model calls.
- Intermediate artifacts are persisted, but default CLI/API surfaces expose final output only unless debug/advanced is enabled.

## Decisions
### Confirmed (Round 1)
- Enablement: research loop is **enabled by default** for all runs (behavior change).
- Stop criteria: **composite** (gap-analysis stop OR diminishing returns OR budgets OR iteration cap) with an explicit `stopReason`.
- Next-step selection: add a **dedicated gap-analysis model call** (JSON) that reads plan + synthesis + verification signals; use the **planner model** for this step.
- Synthesis modes: implement **Mode B** (incremental refinement) and **Mode C** (hybrid). Mode C is only used when the reviewer detects critical issues per the switching rule.
- Review passes: use `models.verifier` / `models.verifierStrong` for review (not the synthesizer model).
- Per-iteration retrieval: keep global caps the same; per-iteration source cap is derived as `max(ceil(maxSources/5), 20)`, then clamped to remaining global source headroom.
- Artifacts: persist per-iteration artifacts; expose only final output by default; intermediate artifacts visible in debug/advanced flows only.
- Plan updates: keep the initial plan immutable; write plan versions per iteration (history).
- Code structure: extract loop logic into a dedicated module in `packages/core`; orchestrator wires it.

### Confirmed (Round 2)
- Auto-switch trigger: “critical issue” = reviewer verdict **reject**; switch to Mode C after **2 rejects (not necessarily consecutive)**.
- Review model routing:
  - During iterations: use `models.verifier`.
  - Use `models.verifierStrong` **only** for the final **full synthesis** review.
- Mode C stickiness: once switched to Mode C, **stay hybrid until finalize**.

### Open questions
- None.

## Design
### Configuration
- Add a `researchLoop` config in `packages/core` (usable via quality profiles and per-run overrides) with defaults aligned to the decisions:
  - `enabled: true`
  - `maxIterations: 5` (hard cap; run often stops earlier)
  - `sourcesPerIteration`: default-derived `max(ceil(maxSources/5), 20)`
  - `mode: auto | incremental | hybrid` (default `auto`; starts incremental)
  - `switchToHybridAfterRejects: 2` (count is not required to be consecutive)

### Loop overview
- Keep the existing plan phase (including its internal multi-pass planner). After plan is produced, run an iteration loop:
  1) Choose next queries/tasks.
  2) Retrieve net-new URLs (respect per-iteration cap + global caps; de-dupe against `seenUrls`).
  3) Fetch + extract newly selected sources only.
  4) Synthesize an interim snapshot (Mode B or Mode C behavior).
  5) Build a citation map and run deterministic citation validation to compute coverage/issues (for gap analysis context).
  6) Run model-based review of the interim snapshot (iterations: `verifier`).
  7) Run gap analysis (planner) to propose next queries/tasks and optionally stop; write a new plan version.
  8) Stop if any stop condition fires; otherwise continue.

### Gap analysis (next-step engine)
- Implement a JSON-only planner call that consumes:
  - current plan version (and a short history summary),
  - interim synthesis snapshot (key findings, unknowns/negative space, recommendations),
  - citation coverage + top issues,
  - reviewer verdict + key objections,
  - remaining budgets and remaining source headroom.
- Output schema should include:
  - `nextQueries[]`
  - `nextTasks[]` (may encode dependency steps, e.g., “identify the people/roles responsible for X at Company B”)
  - `stop` + `stopReason`
  - optional `planNotes[]` explaining the dependency logic.
- Always de-dupe queries/tasks against prior iterations to avoid loops.

### Synthesis modes
- Mode B (incremental): maintain an evolving synthesis state and refine it using prior synthesis + net-new evidence since the last iteration.
- Mode C (hybrid): produce a lightweight interim snapshot each iteration, and also run **one final full synthesis** at the end from the full evidence set.
- Auto mode:
  - Start in Mode B.
  - Track reviewer rejects; after the second reject, switch to Mode C and remain there.

### Review passes
- Iteration reviews: run the reviewer schema against the interim snapshot using `models.verifier`; record verdict and issues as artifacts/events.
- Final full synthesis review: when a final full synthesis is executed (Mode C), run review using `models.verifierStrong` and persist the result.

### Stop criteria (composite)
Stop when any applies (and persist a concrete `stopReason`):
- Gap analysis says stop.
- Iteration cap reached (`maxIterations`).
- Budget exhaustion (runtime deadline; global source/fetch/render caps exhausted).
- No net-new sources were added in an iteration.
- Diminishing returns heuristic (e.g., consecutive iterations add very few net-new sources and gap analysis does not identify high-value next steps).

### Data, artifacts, and resumability
- Extend run checkpoint state to track:
  - `iteration`, `mode`, `seenQueries`, `seenUrls`, `rejectCount`, `stopReason`
  - per-iteration source IDs and per-iteration artifact keys.
- Persist per-iteration artifacts under a stable prefix such as `iterations/{i}/...`:
  - retrieval output, selected URLs, fetch/extract summaries,
  - interim synthesis snapshot,
  - citation map + deterministic verification summary,
  - reviewer output,
  - gap analysis output,
  - plan version for that iteration.
- Exposure policy: intermediate artifacts exist for debugging/advanced usage; default output remains the final memo.

### Integration surfaces
- CLI: print iteration progress (iteration number, net-new sources, current mode, stop reason). Gate printing intermediate memo/plan versions behind debug/advanced flags.
- API/worker: keep endpoints stable; include iteration and stop reason in run status derived from checkpoint/events.

## Implementation Tasks
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

## Validation
- [ ] Run a dependency-chain prompt (e.g., compare two companies → overlaps → identify gaps → identify responsible people/roles) and confirm ≥2 iterations occur when budgets allow.
- [ ] Confirm per-iteration source cap follows `max(ceil(maxSources/5), 20)` and never exceeds global `maxSources`.
- [ ] Confirm explicit stop reasons are logged/persisted for: gap-analysis stop, no-new-sources, diminishing returns, budget exhaustion, and iteration cap.
- [ ] Confirm plan version artifacts exist per iteration and the initial plan remains unchanged.
- [ ] Kill and resume a worker mid-run; confirm no re-fetching already-seen URLs and iteration state resumes correctly.
- [ ] Confirm default surfaces show final output only; debug/advanced can inspect iteration artifacts.
