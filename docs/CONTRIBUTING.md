# Contributing

## Development setup

### Requirements

- Node.js 22+
- Docker (recommended; required for integration tests)

### Install

```bash
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
```

If you want browser rendering:

```bash
npx playwright install chromium
```

### Start Postgres

```bash
docker compose up -d
```

### Migrate

```bash
npm run build
./node_modules/.bin/openresearch migrate
```

## Running

### CLI (local synchronous)

```bash
./node_modules/.bin/openresearch run "Your prompt"
```

### API + worker (async)

```bash
./node_modules/.bin/openresearch serve
```

```bash
./node_modules/.bin/openresearch worker
```

Create an admin user/key:

```bash
ADMIN_ID=$(./node_modules/.bin/openresearch admin create-user --role admin --email admin@example.com)
ADMIN_KEY=$(./node_modules/.bin/openresearch admin create-key --user "$ADMIN_ID")
```

## Configuration

Config sources:

- `openresearch.config.json` (optional; see `openresearch.config.example.json`)
- env overrides (see `packages/core/src/config.ts`)

Config file env references: any string value of the form `env:VAR_NAME` is replaced with `process.env.VAR_NAME` (and omitted if unset).

Common env vars:

- `DATABASE_URL` / `POSTGRES_URL`
- `SEARXNG_URL`
- `OPENROUTER_API_KEY`
- `BRAVE_API_KEY`

SearXNG note: the search adapter uses `/search?format=json`. Ensure your instance allows JSON output. For `searxng/searxng`, add `json` under `search.formats` in `/etc/searxng/settings.yml` and restart.

Search backend selection:

- default: SearXNG (`search.backend = "searxng"`)
- optional: Brave (`search.backend = "brave"` + `BRAVE_API_KEY`)

## Adding an adapter

Adapters live in `packages/adapters` and implement core interfaces from `packages/core/src/adapters.ts`:

- `SearchAdapter` (web search)
- `HttpFetchAdapter` (HTTP fetch)
- `BrowserRenderAdapter` (Playwright render)

Steps:

1. Implement the interface in `packages/adapters/src/`.
2. Export it from `packages/adapters/src/index.ts`.
3. Wire it into `apps/worker/src/worker.ts` (and optionally `apps/cli/src/index.ts`) via config selection.
4. Add deterministic tests (mock network; no real web calls).

## Artifacts (object store) overview

Runs store replayable artifacts under:

- `runs/<runId>/plan.json`
- `runs/<runId>/retrieval.json`
- `runs/<runId>/sources/<sourceId>/raw-body.bin`
- `runs/<runId>/sources/<sourceId>/rendered.txt` (if Playwright used)
- `runs/<runId>/evidence/<sourceId>.json` (extracted text + quotes + chunks)
- `runs/<runId>/synthesis.json`
- `runs/<runId>/citation-map.json`
- `runs/<runId>/verification-report.json`
- `runs/<runId>/verification-report.md`
- `runs/<runId>/output.md`
- `runs/<runId>/model-calls/<phase>/<uuid>.request.json`
- `runs/<runId>/model-calls/<phase>/<uuid>.response.json`

Debug-only artifacts (admin-only in API):

- `runs/<runId>/debug/sources/<sourceId>/rendered.html`
- `runs/<runId>/debug/sources/<sourceId>/trace.zip`

## Safety / source policy

This MVP treats retrieved content as untrusted:

- Extracted content is treated as data and passed to models in structured fields.
- The extractor strips common prompt-injection lines heuristically (see `packages/core/src/extract.ts`).

Project constraints:

- Do not attempt to bypass paywalls/DRM or violate site terms.
- Prefer official/primary sources when possible.
- Use allow/deny domain policies (`safety.allowedDomains`, `safety.deniedDomains`) when operating in restrictive environments.

## Validation commands

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```
