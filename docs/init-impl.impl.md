# init-impl — Implementation Log (append-only)

Status: starting implementation (repo scaffold + core plumbing)

## TODO (mirrors `docs/init-impl.plan.md` → “Implementation Tasks”)
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

## Commands run (with results)
_None yet._

## Decisions / notes
- Started from an empty repo containing only plan/Q&A docs; implementation will create the full monorepo structure described in the plan.

## Log — 2026-02-15
Focus: repo scaffold + tooling baseline.

Notes:
- npm workspaces do not support the `workspace:*` protocol; internal deps use `0.1.0` so npm links workspaces correctly.
- Installed Playwright with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` to keep install lightweight; browsers can be added later via `npx playwright install`.

Commands:
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install` (ok)
- `npm run build` (ok)
- `npm run typecheck` (ok)
- `npm run lint` (ok)
- `npm test` (ok; 1 test)

## TODO (current)
- [x] Scaffold monorepo (TypeScript ESM, workspace tooling, lint/format, tests, build).
- [ ] Add local dev environment (Docker Compose) for Postgres; configure filesystem object-store paths.
- [ ] Implement configuration system (env + config file) for models, budgets, adapters, storage, and safety policies.
- [ ] Implement Postgres schema + migrations using raw SQL + simple migration runner (runs, jobs, sources, model_calls, citations, run_events).
- [ ] Implement users + API keys (tables + hashing + role enforcement + usage aggregation).
- [ ] Implement per-user policy engine (quotas → quality profile selection) and wire it into model routing, budgets, and adapter selection.
- [ ] Implement object-store client abstraction + filesystem backend + blob naming conventions; store/retrieve artifacts by runId/sourceId.
- [ ] Implement on-disk cache utilities for search + fetch (keying, opt-out, basic TTL metadata).
- [ ] Implement search adapters (SearXNG + Brave).
- [ ] Implement fetch adapters (HTTP + Playwright + debug capture policy).
- [ ] Implement extraction pipeline (readability, metadata, quotes with offsets, chunking).
- [ ] Implement OpenRouter provider + `ModelRouter` with full call logging.
- [ ] Implement orchestrator state machine with budgets, bounded parallelism, stopping rules, and best-effort partial results.
- [ ] Implement Research memo renderer + citation formatting + sources appendix + `CitationMap` artifact.
- [ ] Implement minimal verification (citation validator + verification report) and wire into finalize phase.
- [ ] Implement Postgres-backed job queue with DB leasing (priority, retries, cancellation, lease heartbeat, restart recovery).
- [ ] Build `apps/worker` (leases jobs, checkpoints, updates events/status).
- [ ] Build API server (Fastify) with run lifecycle endpoints, status endpoints, and artifact access.
- [ ] Build admin controls (list jobs, cancel, reprioritize).
- [ ] Build admin user/key management (users/keys/policies/usage).
- [ ] Build CLI commands (`run`, `serve`, `resume`, `explain`).
- [ ] Add tests (unit + integration + snapshots + job leasing/admin flows).
- [ ] Write contributor docs (local docker, config, adapters, artifacts, safety).

## Log — 2026-02-15 (continued)
Focus: config + Postgres schema + storage primitives.

Implemented:
- Config loader + schema (`packages/core/src/config.ts`) with env + `openresearch.config.json` support.
- Policy selection helper (`packages/core/src/policy.ts`) for per-user downgrade tier selection.
- Postgres migrations + runner (`packages/storage/migrations/0001_init.sql`, `packages/storage/src/migrate.ts`).
- `PostgresStore` with users, API keys, usage, runs/jobs/sources/events/model_calls/citations primitives.
- Filesystem object store + disk cache primitives.

Commands:
- `npm run build` (ok)
- `docker compose up -d` (ok; postgres started)
- `node apps/cli/dist/index.js migrate` (ok; applied `0001_init.sql`)
- `node apps/cli/dist/index.js admin create-user --role admin --email admin@example.com` (ok)
- `node apps/cli/dist/index.js admin create-key --user <userId> --label test` (ok; printed `orpk_...`)

## Log — 2026-02-15 (continued 2)
Focus: adapters + extraction + core pipeline MVP.

Implemented:
- Search adapters: SearXNG + Brave (`packages/adapters/src/search.ts`)
- Fetch adapters: HTTP + Playwright render with optional trace/html capture (`packages/adapters/src/fetch.ts`)
- OpenRouter model provider (`packages/adapters/src/openrouter.ts`)
- Extraction pipeline using Readability (`packages/core/src/extract.ts`)
- Orchestrator pipeline phases with artifacts + checkpointing (`packages/core/src/orchestrator.ts`)
- Research memo renderer + citation map + validator (`packages/core/src/memo.ts`, `packages/core/src/verify.ts`)

Tests added/updated:
- Storage integration tests now cover job leasing priority + per-user concurrency (`packages/storage/src/postgres-store.test.ts`)
- Orchestrator end-to-end integration test with mock model + adapters (`packages/core/src/orchestrator.test.ts`)

Commands:
- `npm run typecheck` (ok)
- `npm run lint` (ok)
- `npm test` (ok; includes Postgres Testcontainers integration)

## Log — 2026-02-15 (continued 3)
Focus: API server + worker + job queue leasing.

Implemented:
- Postgres-backed job leasing + heartbeat + retry primitives (`packages/storage/src/postgres-store.ts`)
- Worker process that leases jobs and runs the pipeline with heartbeats + cancel checks (`apps/worker/src/worker.ts`)
- Fastify API server with auth, per-user rate limit, run lifecycle endpoints, artifact access, and admin controls (`apps/api/src/server.ts`)
- CLI commands: `run`, `serve`, `worker`, `resume`, `explain` (`apps/cli/src/index.ts`)

Tests updated:
- Storage integration tests now cover expired-lease re-leasing (restart recovery) (`packages/storage/src/postgres-store.test.ts`)

Commands:
- `npm run build` (ok)
- `npm run format` + `npm run format:check` (ok; plan/Q&A docs excluded via `.prettierignore`)
- `npm test` (ok)

## Log — 2026-02-15 (continued 4)
Focus: contributor docs + final validation.

Docs:
- `README.md` (quickstart + repo layout)
- `docs/CONTRIBUTING.md` (local dev, config, adapters, artifacts, safety)

Commands:
- `npm run lint` (ok)
- `npm run typecheck` (ok)
- `npm test` (ok)
- `npm run build` (ok)

## Log — 2026-02-15 (continued 5)
Focus: tighten config + tests; ensure CLI is runnable; run manual validation.

Implemented:
- Config loader now resolves `env:VAR_NAME` references inside `openresearch.config.json` (missing vars omit the key; prevents accidental placeholder usage).
- CLI build emits a proper node shebang so `./node_modules/.bin/openresearch` is directly executable.
- SearXNG adapter error message includes a hint when JSON output is forbidden; docs updated with SearXNG JSON format requirement.

Tests added/updated:
- Config env-ref resolution (`packages/core/src/config.test.ts`)
- Citation validator tamper detection (`packages/core/src/verify.test.ts`)
- Job reprioritize affects leasing order (`packages/storage/src/postgres-store.test.ts`)

Manual validation (local):
- Started SearXNG via Docker and enabled JSON output by adding `json` under `search.formats` in `/etc/searxng/settings.yml` and restarting.
- CLI: `OPENRESEARCH_CONFIG=/tmp/openresearch.manual.config.json openresearch run ...` (ok; artifacts written under `/tmp/openresearch-manual/object-store/runs/<runId>`).
- API + worker: `openresearch serve`, `POST /runs`, `openresearch worker --once`, `GET /runs/:runId/output`, `GET /runs/:runId/artifacts` (ok).
- Auth/RBAC: normal user key receives `403 {"error":"admin_only"}` on `/admin/*` (ok).
- Admin controls: `POST /admin/jobs/:jobId/priority` and `POST /admin/jobs/:jobId/cancel` (ok).
- Quotas/downgrade: set `downgradeThreshold.searchCalls=0`; created run shows `quality_tier=degraded` (ok); other users unaffected.

Commands:
- `npm run format:check` (ok)
- `npm run lint` (ok)
- `npm run typecheck` (ok)
- `npm test` (ok; 15 tests)
- `npm run build` (ok)

## TODO (current)
- [x] Scaffold monorepo (TypeScript ESM, workspace tooling, lint/format, tests, build).
- [x] Add local dev environment (Docker Compose) for Postgres; configure filesystem object-store paths.
- [x] Implement configuration system (env + config file) for models, budgets, adapters, storage, and safety policies.
- [x] Implement Postgres schema + migrations using raw SQL + simple migration runner (runs, jobs, sources, model_calls, citations, run_events).
- [x] Implement users + API keys (tables + hashing + role enforcement + usage aggregation).
- [x] Implement per-user policy engine (quotas → quality profile selection) and wire it into model routing, budgets, and adapter selection.
- [x] Implement object-store client abstraction + filesystem backend + blob naming conventions; store/retrieve artifacts by runId/sourceId.
- [x] Implement on-disk cache utilities for search + fetch (keying, opt-out, basic TTL metadata).
- [x] Implement search adapters (SearXNG + Brave).
- [x] Implement fetch adapters (HTTP + Playwright + debug capture policy).
- [x] Implement extraction pipeline (readability, metadata, quotes with offsets, chunking).
- [x] Implement OpenRouter provider + `ModelRouter` with full call logging.
- [x] Implement orchestrator state machine with budgets, bounded parallelism, stopping rules, and best-effort partial results.
- [x] Implement Research memo renderer + citation formatting + sources appendix + `CitationMap` artifact.
- [x] Implement minimal verification (citation validator + verification report) and wire into finalize phase.
- [x] Implement Postgres-backed job queue with DB leasing (priority, retries, cancellation, lease heartbeat, restart recovery).
- [x] Build `apps/worker` (leases jobs, checkpoints, updates events/status).
- [x] Build API server (Fastify) with run lifecycle endpoints, status endpoints, and artifact access.
- [x] Build admin controls (list jobs, cancel, reprioritize).
- [x] Build admin user/key management (users/keys/policies/usage).
- [x] Build CLI commands (`run`, `serve`, `resume`, `explain`).
- [x] Add tests (unit + integration + snapshots + job leasing/admin flows).
- [x] Write contributor docs (local docker, config, adapters, artifacts, safety).

## Validation (manual checklist from plan)
- [x] `openresearch run` completes and produces memo markdown with citations, verification report, and run artifacts.
- [x] API `POST /runs` enqueues a run and `GET /runs/:runId` shows progress and final status (when worker is running).
- [ ] Worker restart recovery (lease-expiry re-leasing covered by integration tests; manual kill/restart not performed).
- [x] Admin interface: list jobs, cancel a queued job, reprioritize queued jobs.
- [x] Auth: admin endpoints are inaccessible to normal users.
- [x] Quotas/downgrade: forced downgrade via policy threshold and observed `quality_tier=degraded`; other users unaffected.
- [x] Postgres contains run + source + citation records matching artifacts (model call logs covered by orchestrator integration test).
- [x] Object store contains expected blobs; debug traces/HTML are admin-only (not exercised end-to-end).
- [ ] Playwright fallback triggers on JS-heavy fixture/site (not exercised; requires `npx playwright install chromium`).
- [ ] Playwright debug capture stores trace/HTML and remains admin-only (not exercised; requires Playwright browser install).
- [ ] Cache reduces repeated network calls (not exercised end-to-end; adapter cache covered by unit tests).
- [x] Citation validator flags a tampered citation/quote fixture (unit test).
- [x] Retrieval content cannot override system/tool instructions (extractor strips injection-like lines; unit test).
