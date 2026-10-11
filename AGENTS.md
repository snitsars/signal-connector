# AGENTS.md

Agent instructions for the **SignalConnector** repository. Keep this block small and verified.

## What this repo is

SignalConnector is a personal, Windows-first background service that bridges a Signal chat to a
local **opencode** coding agent, so one operator can start tasks, watch progress, approve
permission prompts, and receive results from their phone. TypeScript / ESM / Node ≥ 20.

BMAD planning artifacts live in `_bmad-output/initiative-signal-connector/`:
`brief-*`, `prd-*`, `architecture-*` (the spine), and the ticket tree (`epic-*` folders).

## Architecture (do not violate)

- Ports & adapters (hexagonal). `src/core/` must **not** import `src/adapters/`. Core depends only
  on the `SignalPort` / `AgentPort` interfaces and domain types.
- One SQLite DB is the single source of runtime state (via `src/store/`). No in-memory state that
  cannot be rebuilt from the DB.
- Only `src/adapters/signal` talks to signal-cli; only `src/adapters/agent` talks to opencode.
- Secrets never live in the repo or in any log line; they go through `src/config/secrets.ts`.
  See the spine AD-1..AD-9 in `_bmad-output/initiative-signal-connector/architecture-signal-connector/`.

## Running and verifying

- Install: `npm install`
- Build: `npm run build`
- Test: `npm test`
- Type-check: `npm run typecheck`
- Dev daemon: `npm run dev`

## Conventions

- TypeScript strict; no `any` in `src/core/`. Prefer small, testable units.
- Do not add a dependency without checking it is pure-JS (no native build) and cross-platform.
- Keep the `core/` unit-testable with fakes — tests must not need Signal or opencode running.
