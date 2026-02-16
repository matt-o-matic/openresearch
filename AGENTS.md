# Agents Guide

This repository uses a workspace with `apps/*` and `packages/*`.

## Helpful conventions

- Keep package boundaries clear: shared domain logic in `packages/core`, integrations in `packages/adapters`, persistence in `packages/storage`.
- Use existing script and build patterns; avoid ad-hoc one-off build steps.
- Prefer TypeScript strict style and existing ESLint/Prettier formatting.

## Common commands

- Install: `npm install`
- Build all: `npm run build`
- Lint: `npm run lint`
- Format: `npm run format`
- Typecheck: `npm run typecheck`
- Test: `npm run test`

## Change workflow

- Keep edits scoped to the minimum necessary files.
- Prefer small focused changes per package.
- Update docs when public behavior changes.

## Notes for future assistants

- Main docs entrypoint is `README.md`.
- App config, migrations, and runtime settings are in package-local source trees under `apps/` and `packages/`.
