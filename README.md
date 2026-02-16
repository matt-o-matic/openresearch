# OpenResearch (MVP)

OpenResearch is an open-source research harness that runs a multi-phase pipeline (plan → retrieve → fetch → extract → synthesize → verify → finalize), produces grounded outputs with citations, and persists replayable run artifacts (queries, URLs, timestamps, prompts, extracts, outputs).

This repo ships:

- a CLI (`openresearch`) for local runs, and
- an API server + worker for asynchronous runs (Postgres-backed job queue with leasing).

## Quick Start (5 minutes)

1) Install dependencies

```bash
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
```

2) Make sure Postgres is running and create a database

```bash
# example
createdb openresearch
```

3) Create runtime config

```bash
cp openresearch.config.example.json openresearch.config.json
```

Edit `openresearch.config.json`:
- set `postgres.url` to your running database
- set API credentials (`openRouter.apiKey`, `search.searxng.baseUrl`, etc.)

4) Build and initialize the schema

```bash
npm run build
./node_modules/.bin/openresearch migrate
```

5) Run a quick CLI smoke test

```bash
./node_modules/.bin/openresearch run "Summarize the latest public guidance on solar panel efficiency."
```

6) Optional API smoke test

Terminal 1:

```bash
./node_modules/.bin/openresearch serve
```

Terminal 2:

```bash
./node_modules/.bin/openresearch worker
```

From Terminal 1 or another shell:

```bash
./node_modules/.bin/openresearch admin create-user --role admin --email admin@example.com
./node_modules/.bin/openresearch admin create-key --label local-admin
```

Then post a run with the key from above and poll the result as shown in the detailed run section below.

## Quickstart (local dev)

### 0) Requirements

- Node.js 22+
- PostgreSQL running locally (or in your environment)

### 1) Install deps

Playwright can be heavy; you can skip browser download initially:

```bash
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
```

If you want Playwright rendering, install a browser later:

```bash
npx playwright install chromium
```

### 2) Configure

Copy and edit the JSON configuration:

```bash
cp openresearch.config.example.json openresearch.config.json
sed -i 's#postgres://openresearch:openresearch@localhost:5432/openresearch#postgres://<user>:<password>@<host>:<port>/<db>#' openresearch.config.json
```

Key env vars:

- `DATABASE_URL` (or `POSTGRES_URL`)
- `SEARXNG_URL` (for web search)
- `OPENROUTER_API_KEY` (for model calls)
- `BRAVE_API_KEY` (optional alternative search backend)

If you prefer, you can pass those values directly as shell environment variables at runtime instead of hard-coding secrets in JSON.

Note: your SearXNG instance must allow JSON output (`/search?format=json`). In `searxng/searxng`, enable it by adding `json` under `search.formats` in `/etc/searxng/settings.yml` and restarting.

### 4) Build + migrate

```bash
npm run build
./node_modules/.bin/openresearch migrate
```

### 5) Create an admin user + API key

```bash
ADMIN_ID=$(./node_modules/.bin/openresearch admin create-user --role admin --email admin@example.com)
ADMIN_KEY=$(./node_modules/.bin/openresearch admin create-key --user "$ADMIN_ID" --label local-admin)
echo "$ADMIN_KEY"
```

### 6) Run API + worker

In separate terminals:

```bash
./node_modules/.bin/openresearch serve
```

```bash
./node_modules/.bin/openresearch worker
```

### 7) Create a run via API

```bash
curl -sS -X POST http://localhost:8787/runs \\
  -H "Authorization: Bearer $ADMIN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{\"prompt\":\"Summarize the latest guidance on X and cite sources.\"}' | jq
```

Poll:

```bash
curl -sS http://localhost:8787/runs/<runId> -H "Authorization: Bearer $ADMIN_KEY" | jq
curl -sS http://localhost:8787/runs/<runId>/output -H "Authorization: Bearer $ADMIN_KEY"
```

### CLI (synchronous local run)

```bash
./node_modules/.bin/openresearch run "What is X? Provide citations."
```

Local CLI runs are verbose by default. As the run executes you will see phase transitions, lookup/extract activity, and a live `mm:ss` elapsed timer in the console.

## Repo layout

- `packages/core`: pipeline orchestrator, schemas, memo renderer, citation map, validator
- `packages/adapters`: search + fetch + model provider adapters (SearXNG, Brave, HTTP, Playwright, OpenRouter)
- `packages/storage`: Postgres store, migrations, filesystem object store, disk cache
- `apps/cli`: `openresearch` CLI
- `apps/api`: Fastify API server
- `apps/worker`: Postgres-backed job runner

## Docs

- `docs/CONTRIBUTING.md`
