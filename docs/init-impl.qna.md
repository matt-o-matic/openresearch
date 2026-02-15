# init-impl — Q&A

Related plan: `docs/init-impl.plan.md`

## Round 1

Q: Which implementation stack should be primary for init-impl (core + adapters + CLI)?
- A) TypeScript + Node.js (ESM), schema validation (e.g., Zod)
- B) Python 3.12+, Pydantic for schemas
- C) Go (single-binary focus)
- D) Rust (max perf/safety, higher complexity)
Recommended: A
A (current): [A] TypeScript + Node.js (ESM), schema validation (e.g., Zod)

Q: What is the MVP entrypoint and packaging approach?
- A) CLI-first + core library module (API later)
- B) API server-first (HTTP) + optional CLI
- C) Ship both CLI and API together in MVP
- D) Library-only (no CLI yet)
Recommended: A
A (current): [C] Ship both CLI and API together in MVP

Q: Where should run artifacts and evidence be stored in MVP?
- A) Local filesystem run bundles (JSON/MD); DB later
- B) Postgres now (runs/evidence) + object store
- C) SQLite single-file DB for runs + evidence
- D) S3-compatible object store + Postgres from day one
Recommended: A
A (current): [B] Postgres now (runs/evidence) + object store

Q: Which search backend should be first-class in OSS for init-impl?
- A) Brave Search API adapter (key-based)
- B) SerpAPI adapter (key-based)
- C) SearXNG adapter (self-hosted)
- D) Offline-only (user supplies URLs; no web search)
Recommended: A
A (current): [C] SearXNG adapter (self-hosted)
  Notes:
    C and A with C being default but configurable in the final product.

Q: Should init-impl include Playwright browser rendering fallback?
- A) Yes, ship Playwright renderer in MVP
- B) Defer; design the interface now, implement later
- C) Always render every page via browser
- D) No browser rendering planned
Recommended: B
A (current): [A] Yes, ship Playwright renderer in MVP

Q: What should be the default citation policy mode for generated outputs?
- A) Strict: every factual bullet must cite
- B) Balanced: key factual bullets cite (default)
- C) Loose: cite only major claims
- D) Configurable per run/template; default Balanced
Recommended: D
A (current): [D] Configurable per run/template; default Balanced

Q: How should model routing be configured for MVP?
- A) Single model id for all phases
- B) Explicit model id per phase (no policy escalation)
- C) Fully policy-based auto-routing from day one
- D) Phase-specific config + limited verifier escalation rules
Recommended: D
A (current): [D] Phase-specific config + limited verifier escalation rules

Q: How far should caching and deterministic-ish reruns go in init-impl?
- A) No caching; rely on run bundles only
- B) Cache search+fetch responses on disk (keyed), with opt-out
- C) Cache everything including model outputs
- D) Determinism via fixed seed only; no cache
Recommended: B
A (current): [B] Cache search+fetch responses on disk (keyed), with opt-out

## Round 2

Q: For the API server, how should long-running research runs be executed/managed in the MVP?
- A) Async runs executed in-process; POST returns runId; poll for status (single-node MVP)
- B) Synchronous request: POST blocks until completion (simple but fragile)
- C) Queue-based workers with Redis (e.g., BullMQ) from day one
- D) Split API + worker processes with DB-backed leasing (no Redis)
Recommended: A
A (current): [D] Split API + worker processes with DB-backed leasing (no Redis)
  Notes:
    this should be as production grade as we can make it. so let's make sure we have the ability to recover on errors/restarts of the process and are giving meaningful status updates on each job from a status endpoint. should be able to configure how many concurrent jobs are supported (the rest are queued) and an admin interface (web or command line is fine) that lists ALL jobs and allows the admin of the system to cancel, reprioritize jobs, etc. (normal users would never see this or know it exists)

Q: Which Node HTTP framework should we standardize on for the MVP API server?
- A) Fastify (TypeScript-friendly, good perf)
- B) Express (ubiquitous, minimal)
- C) Hono (small, modern, fetch-style)
- D) NestJS (opinionated, heavier)
- E) tRPC-first (typed RPC, minimal REST)
Recommended: A
A (current): [A] Fastify (TypeScript-friendly, good perf)
  Notes:
    no preference -- given my clarifications on requirements, please recommend the best option.

Q: Which Postgres data access + migrations approach should we use for init-impl?
- A) Drizzle ORM + drizzle-kit migrations
- B) Prisma + Prisma Migrate
- C) Kysely (typed SQL) + node-postgres + SQL migrations
- D) Knex.js queries + migrations
- E) Raw SQL only + simple migration runner
Recommended: A
A (current): [E] Raw SQL only + simple migration runner

Q: What object-store setup should init-impl target for local development (given we also run Postgres)?
- A) S3-compatible with MinIO via docker-compose (exercise S3 semantics locally)
- B) Filesystem-only object store for dev; S3 backend later
- C) Dual backends: filesystem (dev) and S3 (prod); no MinIO
- D) AWS S3 only (contributors must configure AWS)
Recommended: A
A (rev 1): [A] S3-compatible with MinIO via docker-compose (exercise S3 semantics locally)
  Notes:
    this is likely to run on a VM. Let's not attach ourselves to any specific cloud provider.
A (current): [B] Filesystem-only object store for dev; S3 backend later
  Notes:
    this is likely to run on a VM. Let's not attach ourselves to any specific cloud provider.

Q: Search adapters: given SearXNG is default and Brave is supported/configurable, what should init-impl actually ship?
- A) Ship SearXNG only; keep Brave as a documented interface/stub
- B) Ship both SearXNG + Brave adapters in MVP; selectable by config
- C) Ship SearXNG + Brave + manual URL list mode
- D) Ship Brave only; add SearXNG later
Recommended: B
A (current): [B] Ship both SearXNG + Brave adapters in MVP; selectable by config

Q: For Playwright-rendered fetches, what artifacts should be stored by default?
- A) Rendered HTML + extracted text (no screenshot/trace by default)
- B) Rendered HTML + extracted text + screenshot (png)
- C) Full Playwright trace + HTML + extracted text (largest)
- D) Extracted text only (do not store rendered HTML)
Recommended: A
A (current): [D] Extracted text only (do not store rendered HTML)
  Notes:
    default to D.. but for JS heavy sites (or runs where the agent has struggled to get to the info it is searching for) do option C for troubleshooting purposes... but the user should only ever see option D.

Q: Which output templates are required in the MVP beyond the “Research memo” template?
- A) None (Research memo only in MVP)
- B) Add Timeline template
- C) Add Comparison matrix template
- D) Add Timeline + Comparison matrix
- E) Add Timeline + Matrix + Q&A template
Recommended: A
A (current): [A] None (Research memo only in MVP)

## Round 3

Q: How should the MVP authenticate/authorize normal user endpoints vs admin-only job controls and debug artifacts?
- A) No built-in auth; rely on network boundary/reverse proxy
- B) Single shared bearer token for all endpoints (user + admin)
- C) Separate USER and ADMIN bearer tokens; admin endpoints gated
- D) Per-user API keys stored in Postgres + roles (admin/user)
- E) External auth integration (trust proxy headers for identity/role)
- F) OAuth/JWT (OIDC) built-in
Recommended: C
A (rev 1): [D] Per-user API keys stored in Postgres + roles (admin/user)
A (current): [D] Per-user API keys stored in Postgres + roles (admin/user)
  Notes:
    actually YES.. this is perfect.. then we can set rate limits and quality thresholds per user. first X searches are high quality, but if that user goes beyond downgrade them to cheaper models/search harness until month end to help control costs. but do it on a per user basis so those who aren't abusing are still getting full benefit.

Q: When should the system enable Playwright debug capture (trace + rendered HTML) beyond the default extracted-text-only behavior?
- A) Never in MVP (always text-only)
- B) Admin-controlled per-run flag only
- C) Automatic heuristic only (e.g., repeated extraction failures)
- D) Both: admin per-run flag + automatic heuristic escalation
- E) Always for any Playwright-rendered fetch
Recommended: D
A (current): [D] Both: admin per-run flag + automatic heuristic escalation

Q: What should be the default retention policy for run artifacts, on-disk caches, and debug-capture traces?
- A) Keep everything indefinitely; manual cleanup only
- B) TTL for caches only; runs + debug traces kept indefinitely
- C) TTL for caches + debug traces; runs kept indefinitely
- D) TTL for runs too (e.g., 30 days) with keep-forever option
- E) Minimal persistence: keep only final output + citations
Recommended: C
A (current): [C] TTL for caches + debug traces; runs kept indefinitely

## Round 4 (complete)
