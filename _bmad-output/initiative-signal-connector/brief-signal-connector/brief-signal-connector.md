---
title: SignalConnector — Product Brief
status: draft
created: 2026-10-11
updated: 2026-10-11
---

# SignalConnector — Product Brief

## Problem

Running an AI coding agent (opencode, Claude Code, …) means sitting at the machine that
hosts it. When a task is long — a refactor, a test-fix loop, a multi-file change — the operator
must stay near the terminal to answer permission prompts, watch progress, and read results.
There is no way to hand the agent a task from a phone and walk away, or to be told when it is
done, or to approve a risky step from outside the room.

Signal is where the operator already is: it is end-to-end encrypted, already installed, and
already open on the phone. It is the natural remote-control surface for a personal coding agent.

## Solution

SignalConnector is a small cross-platform background service that bridges a Signal chat to a
local coding agent. The operator messages the chat (a Note-to-Self on their own Signal account,
or a dedicated bot in a group) to:

- start a task against a named local project,
- receive live progress (a status message that updates in place, plus milestone messages),
- approve or deny the agent's permission prompts,
- get a final summary with the diff attached when the task finishes,
- and, in a later stage, steer the agent conversationally.

The first agent integration is **opencode** (v2), driven through its server/event API with a
CLI fallback. The agent boundary is a thin adapter so other agents can be added later.

## Target User

A single technical operator (the author) running a coding agent on a Windows machine, who
wants to supervise and trigger work from their phone without exposing the agent to the public
internet. Personal tool first; a distributable product is a possible later outcome, not a v1 goal.

## Success Signals

- A task started from Signal runs on the host and reports back without the operator touching the machine.
- A permission prompt reaches Signal and the operator's reply unblocks the agent.
- Completion notification and the resulting diff arrive as a Signal message + attachment.
- The whole loop runs on Windows with no Docker requirement.

## Scope (Stage 1)

- Platform baseline: Node/TypeScript service, config in `%APPDATA%`, secrets in Windows
  Credential Manager, SQLite state, logging, test harness, run scripts.
- Signal transport over a locally managed signal-cli JSON-RPC daemon; linked-device mode to
  the operator's own number; Note-to-Self channel.
- opencode adapter: named projects, one persistent session per project, prompt, event stream,
  permission round-trip; `opencode run --format json` fallback.
- Command router: slash commands + free-form routing, approval UX.
- Progress & notification: live status edits, milestones, final summary + diff attachment.

## Non-Goals (Stage 1)

- Multi-user / multi-tenant hosting; distributing to other people.
- Agents other than opencode (adapter interface only).
- Dedicated bot-number/group channel (the channel layer allows it; not built in v1).
- Windows Service + Tauri tray packaging (deferred to a later stage).
- Mobile apps, web UI, or any inbound network exposure.

## Key Decisions (from the design interview)

- Personal, single-user tool first, behind clean interfaces.
- opencode-first behind an `AgentAdapter`; server API primary, CLI fallback.
- Stage 1 = task lifecycle + notifications + approve/deny; Stage 2 = full remote control.
- Link as a secondary device to the operator's own number; Note-to-Self channel.
- Self-contained signal-cli JSON-RPC bridge; signal-mcp only for throwaway prototyping.
- Node/TypeScript.

## Risks

- **Signal ToS / rate limits**: no official bot API; automation is tolerated at human scale but
  unsupported. Keep volume low; never broadcast.
- **Unofficial transport fragility**: signal-cli must stay current (< ~3 months) against Signal-Server.
- **opencode v2 API auth-gated, SDK is v1**: the server API is powerful but evolving; the CLI
  fallback de-risks it.
- **Linked-device privacy**: the bot host sees new messages on the operator's account.

## Open Questions

- Does `opencode run --format json` surface permission events suitable for the fallback path?
- Exact v2 API auth mechanism and event/permission endpoint shapes (to be confirmed in E3).
