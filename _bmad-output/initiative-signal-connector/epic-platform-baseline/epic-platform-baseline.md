---
tracker_id: ""
key: ""
type: epic
title: "Platform baseline"
parent: initiative-signal-connector
covers: [CS1, CS2, CS3, CS4]
after: []
assignee: ""
risk: low
---

# Platform baseline

## Description

Stands up the project: a TypeScript/ESM service with the ports-and-adapters skeleton, a SQLite
store, config + secrets, logging, a console daemon entry point, and a test harness. Every later
epic builds on these interfaces, so they are settled here first.

## Outcome

A runnable, tested skeleton exists: `npm run dev` starts a console daemon that loads config,
opens the store, logs, and exits cleanly, with `AgentPort` and `SignalPort` defined and faked.

## Requirements

- CS1: config in `%APPDATA%\SignalConnector\config.toml`, created on first run.
- CS2: secrets via Windows Credential Manager, never in repo/logs.
- CS3: SQLite stores all runtime state.
- CS4: runs as a console daemon with start/stop scripts.
- NFR5: core logic unit-testable without Signal or opencode running.

## Done when

1. `npm install && npm test` passes on Windows with no Signal or opencode present.
2. `npm run dev` starts the daemon, loads a generated config, opens the SQLite DB, logs, and stops.
3. `SignalPort` and `AgentPort` interfaces exist with in-memory fakes used by tests.
4. No secret is written to the repo or to any log line.

## Boundaries

The service skeleton and its shared infrastructure only. Not the Signal or agent integrations
(their epics). Not packaging as a Windows Service.

## References

- architecture — _bmad-output/initiative-signal-connector/architecture-signal-connector/architecture-signal-connector.md, AD-1..AD-4, AD-9
- prd — _bmad-output/initiative-signal-connector/prd-signal-connector/prd-signal-connector.md, sections Configuration & State, Non-Functional Requirements

## Notes

- Decision: TypeScript, ESM, Node ≥ 20, single process (2026-10-11).
