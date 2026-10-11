---
tracker_id: ""
key: ""
type: epic
title: "opencode agent adapter"
parent: initiative-signal-connector
covers: [AC1, AC2, AC3, AC4, AC5, AC6]
after: []
assignee: ""
risk: high
---

# opencode agent adapter

## Description

Implements `AgentPort` over opencode v2: start/attach to the server, map projects to persistent
sessions, send prompts, subscribe to the event stream, and round-trip permission prompts. A CLI
fallback (`opencode run --format json`) keeps notifications working if the server API is
unavailable.

## Outcome

The core can start a task in a project and receive its events and permission requests without
knowing anything about opencode; a fallback path exists for the notification-only case.

## Requirements

- AC1: primary adapter drives the opencode server API (start task, events, permissions).
- AC2: fallback adapter drives `opencode run --format json`.
- AC3: one persistent session per project; `/new` forks.
- AC4: start, abort, and continue tasks.
- AC5: auto-allow safe tools; forward ask-level permissions.
- AC6: all behind `AgentAdapter`.

## Done when

1. A prompt sent through `AgentPort` starts an opencode session in the project directory and emits events.
2. A permission request is surfaced to the core and an answer unblocks opencode.
3. The CLI fallback produces progress/result events when the server API is disabled.
4. Swapping adapters requires no change in `core/`.

## Boundaries

The agent boundary only. Not how events are rendered (epic-progress-notify), not how commands are
parsed (epic-command-router).

## References

- architecture — _bmad-output/initiative-signal-connector/architecture-signal-connector/architecture-signal-connector.md, AD-5, AD-6, AD-8
- prd — _bmad-output/initiative-signal-connector/prd-signal-connector/prd-signal-connector.md, section Agent Control

## Notes

- Unknown: the opencode v2 server auth mechanism and the exact event/permission endpoints; confirm before entry 2.
- Decision: server API primary, CLI fallback (2026-10-11).
