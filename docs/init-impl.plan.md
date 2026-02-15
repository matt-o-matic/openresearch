# init-impl — Plan

Related Q&A: `docs/init-impl.qna.md`

## Problem
Build the initial implementation of an open-source research harness that consistently produces deep, accurate, grounded research outputs. The harness must orchestrate a multi-phase pipeline (plan → retrieve → fetch → extract → synthesize → verify → finalize), support step-specific model routing via OpenRouter, and emit reproducible run artifacts (queries, URLs, timestamps, prompts, extracts, outputs).

## Goals
- Ship an MVP that exposes both:
  - a CLI for local runs, and
  - an API server for remote/programmable runs.
- Support multi-user self-hosting with per-user API keys, quotas/rate limits, and an automatic “quality downgrade” path to control cost abuse without penalizing other users.
- Provide first-class grounding:
  - evidence objects per source (metadata + extracted text + quotes),
  - a citation map linking output claims to evidence, and
  - a configurable citation policy (default: Balanced).
- Store complete, replayable traces for each run (plan, queries, fetch logs, model call logs, evidence, outputs).
- Support SearXNG-backed web search (default) with a second optional search adapter (Brave) via configuration.
- Include Playwright browser rendering fallback for JS-heavy pages.
- Enforce budgets (runtime, fetches, renders, token/spend estimate) and produce best-effort partial results with explicit failure reporting.

## Non-goals
- Training or fine-tuning models.
- Guaranteeing correctness without sources, or claiming certainty when evidence is weak.
- Circumventing paywalls/DRM or violating robots/terms.
- Full eval harness + contradiction detection suites (planned later).

## Assumptions
- Codebase will be TypeScript/Node (ESM) and can use Docker for local dependencies.
- OpenRouter API key is available in the environment for model calls.
- A SearXNG instance is available (local or remote) for search.
- Postgres is available for run/evidence metadata and logs; large artifacts (raw HTML, extracted text blobs, and optional debug snapshots/traces) go to an object store.
- Playwright (Chromium) can run in the target environments for the browser fallback path.
- The service may be multi-tenant (multiple API users); admin provisions users and API keys.

## Decisions
### Confirmed (Round 1)
- Implementation stack: TypeScript + Node.js (ESM) with runtime schema validation (Zod).
- Packaging: ship both CLI and API server in the MVP.
- Storage: Postgres now (runs/evidence/logs) + object store for large artifacts.
- Search: SearXNG is the default backend; Brave is also supported/configurable.
- Fetching: include Playwright browser rendering fallback in MVP.
- Citation policy: configurable per run/template; default is Balanced.
- Model routing: phase-specific model selection with limited verifier escalation rules.
- Caching: cache search + fetch responses on disk (keyed) with an opt-out switch.

### Confirmed (Round 2)
- API execution model: split API + worker processes with a Postgres-backed job queue and DB-backed leasing (no Redis).
  - Requirements: recover across process restarts; meaningful status updates; configurable max concurrent jobs (others queued); admin tools to list/cancel/reprioritize jobs.
- API framework: Fastify.
- Postgres data access + migrations: raw SQL only with a simple migration runner.
- Object store (local dev): filesystem-only object store for dev; S3 backend can come later.
  - Deployment note: likely runs on a VM; avoid cloud-provider lock-in.
- Search adapters: ship both SearXNG + Brave adapters in MVP; selectable by configuration.
- Playwright artifacts: default to extracted text only (do not store rendered HTML by default).
  - Troubleshooting: for JS-heavy sites or when the run struggles, capture full Playwright trace + HTML + extracted text, but keep this admin-only/hidden from normal users.
- Output templates: Research memo only (no additional templates in MVP).

### Confirmed (Round 3)
- Auth/RBAC: per-user API keys stored in Postgres with roles (`admin` / `user`).
  - Requirements: per-user rate limits and “quality thresholds” to control costs; users who exceed thresholds are automatically downgraded (models/tools/search) until month-end without impacting other users.
- Playwright debug capture policy: both admin per-run flag and automatic heuristic escalation.
- Retention: TTL for caches and debug-capture traces; runs kept indefinitely.

### Open questions
_None._

## Design
### Repo / packaging
- Monorepo with a shared core library used by both CLI and API server.
- Suggested layout:
  - `packages/core`: orchestrator, schemas, model router, citation/verification logic.
  - `packages/adapters`: search + fetch implementations (SearXNG, Brave, HTTP, Playwright).
  - `packages/storage`: Postgres client/queries, object-store client, cache helpers.
  - `apps/cli`: CLI entrypoints (invokes `packages/core` directly).
  - `apps/api`: API server (invokes `packages/core` and persists runs).
  - `apps/worker`: job runner that leases jobs from Postgres and executes the pipeline.

### Orchestration (phases)
- Phases (default):
  1) Plan: produce subquestions, queries, expected source types, stopping criteria.
  2) Retrieve: run diversified queries via search adapter(s); de-dup/cluster URLs.
  3) Fetch: HTTP fetch; fallback to Playwright render on extraction failure or JS-heavy heuristics.
  4) Extract: clean text + metadata; generate quotes with char offsets; chunk content.
  5) Synthesize: draft output using structured template(s) and citations.
  6) Verify: minimal citation validator + coverage report; escalate verifier model if needed.
  7) Finalize: produce final deliverable + appendices and persist artifacts.
- Checkpointing (required for restart recovery):
  - persist phase outputs and progress counters after each phase so workers can resume from the last completed checkpoint after crashes/restarts.
- Parallelism:
  - retrieval and fetch/extract operate with a bounded concurrency pool
  - subquestions can be processed sequentially in MVP (parallel sub-agents can be added later)
- Budgets / stopping:
  - hard limits: `maxRuntimeMs`, `maxFetch`, `maxBrowserRenders`, `maxTokens` (estimate), optional `maxCostUsd` (estimate)
  - stopping criteria: meet subquestion coverage + diminishing returns heuristic + budget exhaustion

### API server
- MVP semantics: the API server is the control plane (create runs, enqueue jobs, serve status/output/artifacts, and expose admin controls).
- Suggested endpoint set (REST):
  - `POST /runs` (create + start)
  - `GET /runs/:runId` (status + summary)
  - `GET /runs/:runId/output` (final markdown + metadata)
  - `GET /runs/:runId/artifacts` (artifact index + download URLs/keys)
  - `POST /runs/:runId/cancel` (best-effort cancel)
- Job model (confirmed):
  - runs execute asynchronously via `apps/worker`
  - API enqueues a job in Postgres; workers lease jobs and update run/job status + progress events
  - workers must be restart-safe: leases expire; a different worker can resume from the last checkpoint
  - configurable concurrency: workers enforce a max number of active jobs; remaining jobs stay queued
  - meaningful status updates: status endpoints must expose phase, timestamps, counters, and recent events/errors
- Admin interface (confirmed requirement):
  - list all jobs/runs (including queued/running/failed/completed)
  - cancel jobs and reprioritize queued jobs
  - manage users/API keys and per-user policy (quotas/tiers)
  - implementation can be HTTP endpoints and/or CLI commands; normal users should not discover admin functionality

### Auth, quotas, and “quality downgrade”
- Authentication:
  - API requests authenticate via API key (e.g., bearer token); the key maps to a `user` record.
  - Keys are stored hashed; support multiple keys per user and revocation/rotation.
- Authorization:
  - admin-only endpoints (job admin, debug artifact access, user/key management) require `admin` role.
- Per-user controls (confirmed requirement):
  - per-user request rate limits (API) and per-user job concurrency limits (queue/worker)
  - per-user monthly “quality thresholds” that trigger an automatic downgrade until month-end
- Downgrade behavior (design):
  - swap to cheaper model ids (phase-specific) and reduce budgets (max sources, max renders, etc)
  - optionally switch expensive search (e.g., Brave) to cheaper search (e.g., SearXNG) after a configurable per-user quota
  - keep the mechanism policy-driven/configurable so operators can tune thresholds and profiles

### CLI
- CLI runs the same pipeline locally (no HTTP required).
- Commands (MVP):
  - `openresearch run "<prompt>"`
  - `openresearch serve`
  - `openresearch resume <runId>`
  - `openresearch explain <runId>`

### Storage
#### Postgres (authoritative metadata/logs)
Store normalized run metadata and indexes for auditability and querying. Proposed tables (v1; adjust as needed):
- `users`: role (admin|user), status, createdAt, quotas/policy JSON
- `api_keys`: userId, keyHash, label, createdAt, lastUsedAt, revokedAt
- `user_usage_monthly`: userId, month, counters (search calls, fetches, renders, token/cost estimates), lastUpdatedAt
- `runs`: userId, prompt, createdAt, status, budgets, model config, citation policy, template, plan JSON, error JSON
- `jobs`: runId, status (queued|leased|running|failed|complete|canceled), priority, attempts, leaseOwner, leaseExpiresAt, startedAt, finishedAt
- `run_events`: structured timeline (phase start/stop, warnings, errors)
- `sources`: per-run source rows with URL(s), fetch status, timestamps, content hash, publisher/authors/publishedAt, and pointers to object-store blobs
- `model_calls`: per-call logs (phase, model id, params, template version, input/output hashes, token usage if available)
- `citations`: claim id → source id(s) + optional quote offsets (or JSONB if simpler for MVP)

#### Object store (large blobs)
- Backends:
  - filesystem backend in MVP (dev and VM-friendly)
  - S3-compatible backend (later milestone; keep interface stable)
- Blob types (suggested):
  - raw fetch body (html/text)
  - browser extracted text (Playwright)
  - rendered HTML snapshot + trace (debug capture only; admin-only)
  - extracted text + quote index JSON
  - final output markdown
  - optional screenshots (debug capture only; if ever enabled)

### Retrieval
- `SearchAdapter` interface:
  - input: query + options (recency, locale, safe search, domain hints)
  - output: ranked URL candidates with snippet/title and optional publishedAt
- Default adapter: SearXNG.
- Also ship: Brave Search API adapter (config-selectable).
- URL selection:
  - de-dup via normalized URL + content hash
  - cluster near-duplicates (canonical preference)
  - prefer primary/official sources when possible

### Fetching
- HTTP fetch:
  - retries with exponential backoff, timeouts, rate limiting, redirect tracking
  - capture final URL, status, headers subset, fetchedAt
  - robots/ToS compliance hooks and allow/deny domain policies
- Browser fetch (Playwright):
  - render page, capture final URL, rendered HTML, extracted visible text
  - store render metadata (user agent, viewport) for reproducibility
  - default artifacts: extracted visible text only
  - debug capture artifacts (admin-only): Playwright trace + rendered HTML + extracted text

### Extraction
- Convert HTML to readable text (readability + fallback).
- Extract best-effort metadata: title, publisher, authors, publishedAt.
- Quotes:
  - store short, quote-backed spans with stable char offsets into `contentText`
  - keep quotes small and directly supportive (used by citation validator)

### Model routing (OpenRouter)
- `ModelRouter` selects a model per phase from config: planner, extractor (optional), synthesizer, verifier.
- Verifier escalation rules (limited):
  - escalate to stronger verifier when citation coverage low or validator flags mismatches
- All calls log model id, parameters, prompt template version, input/output hashes, and token usage.

### Synthesis + output templates
- Required template (MVP): Research memo:
  - Summary
  - Key findings (bullets + citations)
  - Contradictions/Disagreements (optional if found)
  - Recommendations (optional)
  - Unknowns
  - Sources appendix (URLs + fetchedAt + publisher)
- No additional templates in MVP.

### Verification (MVP)
- Citation validator:
  - each cited source must exist and have non-empty extract
  - if a quote offset is provided, the quote must match the stored `contentText` span
  - flag broken fetches, empty extracts, and citation/quote mismatches
- Output a verification report artifact (JSON + short markdown summary) with actionable flags.

### Caching / deterministic-ish reruns
- On-disk cache for:
  - search results (by backend + query + options hash)
  - fetch responses (by final URL + headers/options hash)
- Cache opt-out via config.
- TTLs (confirmed):
  - caches expire via TTL (configurable)
  - debug-capture traces/snapshots expire via TTL (configurable)
  - run records/artifacts are retained indefinitely by default
- Rerun strategy:
  - pin OpenRouter model ids per phase
  - pin prompt template versions
  - reuse cached search/fetch when enabled
  - record all artifacts for audit/replay

### Safety / governance (MVP)
- Treat retrieved content as untrusted; extraction does not execute instructions from pages.
- Prompt-injection hygiene:
  - keep system/tool prompts authoritative
  - isolate retrieved text as data fields
  - strip obvious “instruction to the model” blocks during extraction (heuristic) while preserving factual content
- Source policy hooks:
  - domain allow/deny lists
  - user-agent and rate limiting configuration
  - explicit logging of accessed sources for auditability

## Implementation Tasks (ordered)
- [ ] Scaffold monorepo (TypeScript ESM, workspace tooling, lint/format, tests, build).
- [ ] Add local dev environment (Docker Compose) for Postgres; configure filesystem object-store paths.
- [ ] Implement configuration system (env + config file) for models, budgets, adapters, storage, and safety policies.
- [ ] Implement Postgres schema + migrations using raw SQL + simple migration runner (runs, jobs, sources, model_calls, citations, run_events).
- [ ] Implement users + API keys:
  - `users`, `api_keys`, `user_usage_monthly` tables
  - key hashing, rotation/revocation, role enforcement
  - usage aggregation hooks (from model/search/fetch logs) for monthly counters
- [ ] Implement per-user policy engine (quotas → quality profile selection) and wire it into model routing, budgets, and adapter selection.
- [ ] Implement object-store client abstraction + filesystem backend + blob naming conventions; store/retrieve artifacts by runId/sourceId.
- [ ] Implement on-disk cache utilities for search + fetch (keying, opt-out, basic TTL metadata).
- [ ] Implement search adapters:
  - SearXNG (default)
  - Brave (config-selectable)
- [ ] Implement fetch adapters:
  - HTTP fetch with retries/backoff/timeouts and fetch logging
  - Playwright render fetch with extraction; implement debug capture policy and admin-only debug artifacts
- [ ] Implement extraction pipeline (readability, metadata, quotes with offsets, chunking).
- [ ] Implement OpenRouter provider + `ModelRouter` (phase config + verifier escalation) with full call logging.
- [ ] Implement orchestrator state machine with budgets, bounded parallelism, stopping rules, and best-effort partial results.
- [ ] Implement Research memo renderer + citation formatting + sources appendix + `CitationMap` artifact.
- [ ] Implement minimal verification (citation validator + verification report) and wire into finalize phase.
- [ ] Implement Postgres-backed job queue with DB leasing (priority, retries, cancellation, lease heartbeat, restart recovery).
- [ ] Build `apps/worker` that leases jobs, checkpoints phase outputs, and updates `run_events` + status counters.
- [ ] Build API server (Fastify) with run lifecycle endpoints, status endpoints, and artifact access.
- [ ] Build admin controls (HTTP endpoints and/or CLI commands): list all jobs, cancel, reprioritize.
- [ ] Build admin user/key management (HTTP endpoints and/or CLI commands): create/disable users, create/revoke keys, set quotas/policies, inspect user usage and current quality tier.
- [ ] Build CLI commands (`run`, `serve`, `resume`, `explain`) backed by the same core pipeline.
- [ ] Add tests:
  - unit tests for adapters (mocked), extraction, citation map, validator
  - integration tests for orchestrator using fixtures
  - snapshot tests for memo rendering
  - integration tests for job leasing + restart recovery (worker crash/restart) and admin reprioritize/cancel
- [ ] Write contributor docs: how to run locally (docker), configure adapters, add a new adapter, artifact format overview, safety/source policy.

## Validation (manual checklist)
- [ ] `openresearch run` completes on a small prompt and produces memo markdown with citations, a verification report, and a run artifact bundle (queries, fetch logs, evidence, model call logs).
- [ ] API `POST /runs` starts a run and `GET /runs/:runId` shows phase progress and final status.
- [ ] Worker restart recovery: start a run, terminate the worker process mid-run, restart worker, and confirm the job resumes from the last checkpoint.
- [ ] Admin interface: list all jobs, cancel a queued job, reprioritize queued jobs, and verify ordering/behavior.
- [ ] Auth: create a normal user API key and an admin API key; confirm admin endpoints are inaccessible to normal users.
- [ ] Quotas/downgrade: drive a user over configured thresholds and verify routing downgrades (models/search/budgets) until month-end; confirm other users are unaffected.
- [ ] Postgres contains run + source + model_call records matching the run artifacts.
- [ ] Object store contains expected blobs (raw fetch body, extracted text/evidence JSON, output markdown); debug traces/HTML only appear when debug capture is enabled.
- [ ] Playwright fallback triggers on a JS-heavy fixture/site and stores the configured artifacts.
- [ ] Playwright debug capture (if triggered) stores trace/HTML artifacts but they remain admin-only and are not exposed to normal users.
- [ ] Cache reduces repeated network calls for identical queries/URLs (with opt-out working).
- [ ] Citation validator flags a tampered citation/quote fixture and surfaces a clear error in the verification report.
- [ ] Retrieval content cannot override system/tool instructions (run an injection-like fixture and confirm behavior).
