---
title: SignalConnector — PRD
status: draft
created: 2026-10-11
updated: 2026-10-11
---

# SignalConnector — PRD

## Overview

A personal, cross-platform (Windows-first) background service that lets one operator control a
local opencode coding agent from a Signal chat. This PRD covers Stage 1: task lifecycle,
progress notifications, results, and approve/deny. Stage 2 (free-form steering, multi-agent) is
out of scope here.

Source of truth for product intent: `brief-signal-connector/brief-signal-connector.md`.

## Users

One technical operator (solo). No personas beyond that; there is a single operator role.

## User Journey (Stage 1)

1. The operator starts the service on the host machine; it links to their Signal account and
   comes online in Note-to-Self.
2. From the phone, they send `/use myproject` then `/task add a retry to the HTTP client`.
3. The service starts an opencode task in that project. A status message appears and updates in
   place ("planning…", "editing src/http.ts…", "running tests…").
4. opencode asks permission to run a command; the service posts a numbered prompt. The operator
   replies `approve` (or 👍). The agent continues.
5. On completion the service posts a summary and attaches the diff. `/status` re-shows the
   latest state; `/stop` aborts.

## Functional Requirements

### Transport & Channel (TC)

- **TC1**: The service connects to a locally managed `signal-cli` JSON-RPC daemon and links as a
  secondary device to the operator's Signal account via QR (`startLink`/`finishLink`).
- **TC2**: The service receives incoming messages in near real time and persists them locally.
- **TC3**: The service sends text, and edits a previously sent message in place.
- **TC4**: The service sends file attachments (e.g. a diff).
- **TC5**: The service restricts itself to a single configured channel — Note-to-Self by default
  — and ignores messages outside it.
- **TC6**: The service survives daemon restarts and reconnects automatically.
- **TC7**: Send volume stays within human-scale limits; the service applies a conservative
  outbound rate limit and never broadcasts.

### Command & Conversation (CC)

- **CC1**: Slash commands are recognized: `/use`, `/task`, `/status`, `/approve`, `/deny`,
  `/stop`, `/new`, `/projects`, `/help`.
- **CC2**: Free-form text (no leading slash) is routed as a prompt to the active project's session.
- **CC3**: `/use <project>` sets the active project; `/projects` lists configured projects.
- **CC4**: Unknown commands return a help hint, not an error.
- **CC5**: A permission prompt is presented as a numbered message; the operator answers with
  `approve` / `deny` / `always`, or a 👍/👎 reaction to that message.
- **CC6**: `always` remembers the decision for that tool for the rest of the session.

### Agent Control (AC)

- **AC1**: The service drives opencode through its server API as the primary adapter (start task,
  subscribe to events, answer permissions).
- **AC2**: A fallback adapter drives `opencode run --format json` when the server API is
  unavailable, so notifications still work.
- **AC3**: Each configured project maps to one persistent opencode session; `/new` forks a fresh
  session for the active project.
- **AC4**: The service starts, aborts, and continues tasks (`/task`, `/stop`, free-form follow-up).
- **AC5**: Read-only/safe tools are auto-allowed; every `ask`-level permission is forwarded (CC5).
- **AC6**: The adapter is defined by an `AgentAdapter` interface so other agents can be added.

### Progress & Notification (PN)

- **PN1**: A single "live status" message is edited in place as the task progresses.
- **PN2**: Discrete milestone messages are sent only for meaningful events (task started, files
  changed, tests run, error, done).
- **PN3**: On completion the service posts a summary and attaches the diff.
- **PN4**: Failures and agent errors are reported with enough context to act on.
- **PN5**: Notification content is concise and safe to read on a phone.

### Configuration & State (CS)

- **CS1**: Config (projects, channel, agent settings) lives in `%APPDATA%\SignalConnector\`
  (`config.toml`), created on first run.
- **CS2**: Signal account credentials and any API keys live in Windows Credential Manager, never
  in the repo or config file.
- **CS3**: All runtime state (projects, sessions, tasks, approvals, message↔session map) is stored
  in SQLite under `%APPDATA%\SignalConnector\`.
- **CS4**: The service runs as a console daemon with start/stop scripts.

## Non-Functional Requirements

- **NFR1 Reliability**: The receive loop and agent connection recover from transient failures
  without operator intervention; unhandled errors are logged and the service stays up.
- **NFR2 Security**: No inbound network exposure; secrets never logged; the channel is restricted
  to the configured account.
- **NFR3 Cross-platform**: Code targets Windows first but avoids Windows-only APIs outside a thin
  platform layer, so macOS/Linux remain viable.
- **NFR4 Observability**: Structured logs to file + console; a `/status` reflects real agent state.
- **NFR5 Testability**: Core logic (routing, mapping, adapters) is unit-testable without Signal or
  opencode running.

## Success Metrics

- Time from `/task` to first progress message < 5 s on a warm host.
- A permission prompt and its reply round-trip completes without the operator touching the host.
- Zero secrets in the repo; zero unhandled crashes over a normal work session.

## Constraints & Dependencies

- Depends on `signal-cli` (Java) and `opencode` (v2) on the host.
- Signal has no official bot API; automation is unsupported and rate-limited.
