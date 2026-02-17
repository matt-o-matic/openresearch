# goal-directed-research — Q&A

Related plan: `docs/goal-directed-research.plan.md`

## Round 1

Q: Where should run checkpoints be persisted by default for local/CLI usage?
- A) Filesystem under a per-user runs directory (e.g., ~/.openresearch/runs/<run-id>)
- B) SQLite database file managed by packages/storage
- C) Server-side Postgres only (API-managed), CLI becomes thin client
- D) In-memory only (no persistence)
- E) Pluggable backend required; no default
Recommended: A
A (current): [C] Server-side Postgres only (API-managed), CLI becomes thin client

Q: When resuming a run, should we continue under the same run id or create a new run attempt?
- A) Same run id; append iterations; record resumeCount/repair events in metadata
- B) New run id with parentRunId pointing to the original
- C) New run id and archive/lock the original run
- D) No true resume; only rerun from scratch with copied config
- E) Same run id but overwrite prior iterations (destructive)
Recommended: A
A (current): [A] Same run id; append iterations; record resumeCount/repair events in metadata

Q: How should question completion be represented and used for stop criteria?
- A) Tri-state (unanswered/partial/answered) plus evidence/confidence thresholds
- B) Binary answered/unanswered only
- C) Single numeric score (0–1) only
- D) Freeform notes only; no explicit status
- E) Only a global run-level done signal; no per-question tracking
Recommended: A
A (current): [A] Tri-state (unanswered/partial/answered) plus evidence/confidence thresholds

Q: How should dependencies between questions be encoded and validated?
- A) Extract an explicit DAG of question ids; validate acyclic; block until deps answered
- B) No dependencies; always a flat list of questions
- C) Infer dependencies implicitly each iteration (no stored graph)
- D) User must provide dependencies manually
- E) Dependencies as prose only (not machine-validated)
Recommended: A
A (current): [A] Extract an explicit DAG of question ids; validate acyclic; block until deps answered

Q: What budgeting policy should be the default to avoid mid-finalize failures?
- A) Per-iteration soft cap with a reserved finalize budget; stop between iterations when low
- B) Single global maxRuntimeMs that may stop mid-iteration or mid-finalize
- C) Hard per-iteration wall-clock kill (may interrupt synthesis)
- D) Always finish the current iteration even if it exceeds budget
- E) No runtime budget; only maxIterations
Recommended: A
A (rev 1): [D] Always finish the current iteration even if it exceeds budget
A (current): [D] Always finish the current iteration even if it exceeds budget
  Notes:
    To be clear what I mean by choosing D is that at the end of the current iteration it should then bypass the review and the gap analysis and just synthesize the final writing output into the result. By the time we get there we should already have a very refined result and if we're just out of time, that's fine. Try to do everything we can to land the plane cleanly. I don't want 'Hey we ran out of time, failure modes' but I also don't want this to go on forever, especially on a simple prompt.

Q: How should synthesis context be managed for iteration N>1 to keep costs flat?
- A) Carry forward a structured synthesis summary + include only new abstracts/deltas
- B) Carry forward all prior abstracts and the full prior synthesis
- C) Naive truncation: drop oldest tokens until within limits
- D) Only per-question summaries; no global synthesis summary
- E) No compression; rely on model context window
Recommended: A
A (rev 1): [A] Carry forward a structured synthesis summary + include only new abstracts/deltas
A (current): [A] Carry forward a structured synthesis summary + include only new abstracts/deltas
  Notes:
    allow full context, but summarize if output budget is < 50,000 tokens. -- make this a feature flag. default A.

Q: Where should question tracking and incomplete-section reporting appear in the final outputs?
- A) Structured run output JSON metadata (questions, statuses, incompleteSections, lastCompletedIteration)
- B) CLI logs only (not persisted in outputs)
- C) Narrative report text only (no structured fields)
- D) Internal only; not exposed to users
- E) Separate debug artifact file only
Recommended: A
A (current): [D] Internal only; not exposed to users

Q: What should the API resume authorization model be?
- A) Only the run owner (same auth context) can resume; others receive 404/403
- B) Anyone with run id can resume
- C) Admin-only resume
- D) Disable API resume; support CLI-only resume
- E) Public share tokens can resume (link-based access)
Recommended: A
A (current): [A] Only the run owner (same auth context) can resume; others receive 404/403

Q: How should this change be rolled out to protect existing behavior?
- A) Feature flag or explicit mode switch (e.g., --mode goal-directed); default off initially
- B) Replace existing behavior immediately for all runs
- C) Enable automatically only when maxIterations > 1
- D) Enable for API runs only; keep CLI unchanged
- E) Enable only when prompt complexity exceeds a threshold
Recommended: A
A (current): [B] Replace existing behavior immediately for all runs
  Notes:
    nothing is released -- consider this green field.

## Round 2

Q: For the “allow full context, but summarize if … < 50,000 tokens” rule, what token budget should the 50,000 threshold apply to?
- A) Model context window (input+output max tokens)
- B) Input prompt/context budget only (tokens we can send as context)
- C) Max output tokens only (completion budget)
- D) An internal computed `contextBudgetTokens` (derived from model limits and requested output)
- E) Ignore the threshold; always summarize after iteration 1
Recommended: D
A (current): [D] An internal computed `contextBudgetTokens` (derived from model limits and requested output)

Q: What default rubric should mark a core question as `answered` (vs `partial`) to drive stop criteria?
- A) Direct answer + at least 1 credible citation/source
- B) Direct answer + at least 2 independent credible citations/sources
- C) Model confidence >= 0.8 + at least 1 citation/source
- D) If gap analysis proposes no more follow-ups for it (citations optional)
- E) Only mark answered when all sub-questions are explicitly enumerated and addressed
Recommended: A
A (current): [A] Direct answer + at least 1 credible citation/source

Q: What should be included in each Postgres checkpoint payload to support resume without re-fetching?
- A) Derived artifacts: seenUrls/queries, per-source abstracts/notes, synthesis snapshot+summary, question graph/statuses
- B) Minimal state only: seenUrls/queries + synthesis summary + question statuses (no source-level artifacts)
- C) Only synthesis snapshot/summary + question statuses (no seenUrls/queries)
- D) Everything including raw fetched documents (HTML/text) for fully offline resume
- E) Only the latest checkpoint (overwrite previous) to minimize DB growth
Recommended: A
A (current): [A] Derived artifacts: seenUrls/queries, per-source abstracts/notes, synthesis snapshot+summary, question graph/statuses

Q: What should `POST /runs/:id/resume` do if the run is already running/queued?
- A) Idempotent: return current status and do not enqueue duplicate work
- B) Enqueue another resume job and rely on workers to dedupe later
- C) Cancel current work and restart from the latest checkpoint
- D) Return 409 Conflict and require the client to wait
Recommended: A
A (current): [A] Idempotent: return current status and do not enqueue duplicate work

## Round 3 (complete)
