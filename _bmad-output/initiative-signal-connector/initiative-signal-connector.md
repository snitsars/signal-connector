---
tracker_id: ""
key: ""
type: initiative
title: "Control a local coding agent from Signal"
parent: none
covers: [TC1, TC2, TC3, TC4, TC5, TC6, TC7, CC1, CC2, CC3, CC4, CC5, CC6, AC1, AC2, AC3, AC4, AC5, AC6, PN1, PN2, PN3, PN4, PN5, CS1, CS2, CS3, CS4]
after: []
assignee: ""
risk: medium
---

# Control a local coding agent from Signal

## Description

SignalConnector bridges a Signal chat to a local opencode agent so one operator can start tasks,
watch progress, approve permission prompts, and receive results from their phone. This initiative
delivers Stage 1 on Windows. The PRD owns the requirements; the architecture spine owns the
invariants its epics share.

## Outcome

The operator starts and supervises coding tasks from Signal without touching the host machine; the
signal is a completed task whose diff arrives as a Signal attachment after an approval round-trip.

## Requirements

Stable ids for the epics to cite (from the PRD, `prd-signal-connector/prd-signal-connector.md`):

- TC1–TC7: transport and channel (link, receive, send/edit, attachments, single channel, reconnect, rate limit)
- CC1–CC6: commands and conversation (slash commands, free-form routing, active project, approval UX)
- AC1–AC6: agent control (server adapter, CLI fallback, session-per-project, start/stop, permission policy, adapter interface)
- PN1–PN5: progress and notification (live status edit, milestones, final summary + diff, errors, concision)
- CS1–CS4: configuration and state (config file, secrets, SQLite, console daemon)

## Done when

1. A task started from Signal runs on the host and its progress and final diff come back to Signal.
2. A forwarded permission prompt is answered from Signal and unblocks the agent.
3. The service reconnects to the Signal daemon after a restart and keeps its state across a service restart.
4. No secret appears in the repo or in any log line.
5. The whole loop runs on Windows without Docker.

## Boundaries

The bridge between a local Signal transport and a local agent, for one operator. Not the agent
itself, not a hosted/multi-user service, not the Signal protocol implementation. Tracer path: a
`/task` message from Signal reaches opencode and a status edit comes back.

- Touch point: signal-cli daemon — spawned and configured locally; owner: epic-signal-transport
- Touch point: opencode v2 server — started/attached to locally; owner: epic-agent-adapter

## References

- brief — _bmad-output/initiative-signal-connector/brief-signal-connector/brief-signal-connector.md
- prd — _bmad-output/initiative-signal-connector/prd-signal-connector/prd-signal-connector.md
- architecture — _bmad-output/initiative-signal-connector/architecture-signal-connector/architecture-signal-connector.md

## Notes

- Decision: personal single-user tool first, behind clean interfaces (2026-10-11).
- Decision: opencode-first behind `AgentAdapter`; server API primary, CLI fallback (2026-10-11).
- Decision: link to the operator's own number, Note-to-Self channel (2026-10-11).
- Decision: Node/TypeScript, SQLite state, `%APPDATA%` config, Credential Manager secrets (2026-10-11).
- Parked: Windows Service + Tauri tray packaging; dedicated bot-number/group channel; extra agents — all deferred to a later stage.
