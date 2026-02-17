# research-loop-enhancement — Q&A

Related plan: `docs/research-loop-enhancement.plan.md`

## Round 1

Q: How should the iterative research loop be enabled by default?
- A) Enabled by default for all runs (behavior change)
- B) Disabled by default; enable via config (quality profile/adapter config)
- C) Disabled by default; enable via per-run CLI/API flag only
- D) Enabled only when heuristics detect a multi-step dependency prompt
Recommended: B
A (current): [A] Enabled by default for all runs (behavior change)

Q: What should be the primary stop criteria for the loop?
- A) Fixed iterations only (e.g., always 3)
- B) Stop when an iteration finds no net-new sources
- C) Composite: gap-analysis stop OR diminishing returns OR budgets OR iteration cap
- D) Stop when verifier coverage reaches a configured threshold
- E) Stop only when runtime budget is exhausted
Recommended: C
A (current): [C] Composite: gap-analysis stop OR diminishing returns OR budgets OR iteration cap

Q: How should the system decide what to research next each iteration?
- A) Use synthesis unknowns/negative space only
- B) Use verifier coverage/issues only (no additional model call)
- C) Dedicated gap-analysis model call: reads plan + synthesis + verification and outputs next steps (JSON)
- D) Heuristic broadening of original queries (no reflection step)
- E) Human-in-the-loop approval between iterations
Recommended: C
A (current): [C] Dedicated gap-analysis model call: reads plan + synthesis + verification and outputs next steps (JSON)
  Notes:
    use planner model for this.

Q: What synthesis strategy should we use across iterations?
- A) Re-synthesize from scratch each iteration using all evidence (simplest, costlier)
- B) Incrementally refine prior synthesis using only new sources (cheaper, drift risk)
- C) Hybrid: lightweight interim synthesis each iteration + one full synthesis at the end
- D) No interim synthesis; synthesize only once at the end
Recommended: C
A (current): [C] Hybrid: lightweight interim synthesis each iteration + one full synthesis at the end
  Notes:
    let's implement two modes.. B and C. Only use C when reviewer pass is finding critical issues 2x iterations. (use verifier/verifierStrong for review passes)

Q: How should per-iteration retrieval be budgeted?
- A) Fixed small batch (e.g., 3 queries, 5 sources) for every iteration
- B) Scale batch size by remaining global budget (more early, fewer later)
- C) Use global budgets in first iteration only (current behavior)
- D) Per-iteration cap + global cap (sourcesPerIteration + maxSources)
- E) Require per-run user settings; no defaults
Recommended: D
A (current): [D] Per-iteration cap + global cap (sourcesPerIteration + maxSources)
  Notes:
    keep globals the same, per iteration should be 1/5 of the global or 20 sources whichever is greater.

Q: What intermediate artifacts should be persisted and exposed?
- A) Persist all iteration artifacts and expose them by default
- B) Persist all iteration artifacts; expose only final output unless debug/advanced
- C) Persist only the latest iteration (overwrite) to save space
- D) Persist minimal artifacts (gap analysis + final memo only)
Recommended: B
A (current): [B] Persist all iteration artifacts; expose only final output unless debug/advanced

Q: How should the plan be updated over time during the loop?
- A) Overwrite a single mutable plan artifact each iteration
- B) Keep the original plan immutable and add plan versions per iteration (history)
- C) Maintain a separate live plan artifact; keep original plan unchanged
- D) Do not update the plan; only generate next queries
- E) Store plan changes only as run events (no plan artifacts)
Recommended: B
A (current): [B] Keep the original plan immutable and add plan versions per iteration (history)

Q: Where should the loop logic live to keep the codebase testable and maintainable?
- A) All in packages/core orchestrator (single file)
- B) Extract loop planner to a new module in packages/core; orchestrator wires it
- C) Put the loop in apps/worker; keep core single-pass
- D) Implement as API-driven sequencing in apps/api (core unchanged)
Recommended: B
A (current): [B] Extract loop planner to a new module in packages/core; orchestrator wires it

## Round 2

Q: For auto-switching from Mode B (incremental) to Mode C (hybrid), what should count as a critical reviewer issue and how should the ‘2x iterations’ rule be applied?
- A) Critical = reviewer verdict reject; switch after 2 rejects (not necessarily consecutive)
- B) Critical = reviewer verdict reject; switch after 2 consecutive rejects
- C) Critical = reject OR (revise with unsupportedConclusions>0); switch after 2 consecutive critical iterations
- D) Critical = any verdict other than accept; switch after 2 consecutive non-accept iterations
- E) No auto-switch; mode is fixed per run via config
Recommended: C
A (current): [A] Critical = reviewer verdict reject; switch after 2 rejects (not necessarily consecutive)

Q: How should verifier vs verifierStrong be used for synthesis review passes?
- A) Always use models.verifier for review
- B) Use models.verifier; if verdict != accept, re-run once with models.verifierStrong and treat that verdict as authoritative
- C) Always use models.verifierStrong for review
- D) Use models.verifier during iterations; use models.verifierStrong only for the final full synthesis review
- E) Disable model-based review; rely on deterministic citation validation only
Recommended: B
A (current): [D] Use models.verifier during iterations; use models.verifierStrong only for the final full synthesis review

Q: When Mode C (hybrid) is activated mid-run, should the system stay in Mode C for the rest of the run?
- A) Yes—once switched, stay hybrid until finalize
- B) Switch to hybrid for one iteration only, then try incremental again
- C) Switch to hybrid; revert back to incremental after 2 consecutive accept reviews
- D) Never switch automatically; mode is fixed per run
Recommended: A
A (current): [A] Yes—once switched, stay hybrid until finalize

## Round 3 (complete)
