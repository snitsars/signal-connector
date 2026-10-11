---
tracker_id: ""
key: ""
type: epic
title: "Progress tracking and notifications"
parent: initiative-signal-connector
covers: [PN1, PN2, PN3, PN4, PN5]
after: []
assignee: ""
risk: medium
---

# Progress tracking and notifications

## Description

Turns the agent event stream into Signal messages: one live status message edited in place,
milestone messages for meaningful events, and a final summary with the diff attached. Keeps output
concise and safe to read on a phone, and reports failures with context.

## Outcome

A running task shows live progress in a single updating message, milestones arrive as they happen,
and completion delivers a summary plus the diff as an attachment.

## Requirements

- PN1: one live status message edited in place.
- PN2: milestone messages for meaningful events only.
- PN3: final summary + diff attachment on completion.
- PN4: failures reported with actionable context.
- PN5: concise, phone-readable content.

## Done when

1. A running task edits a single status message rather than posting many.
2. Files-changed, tests-run, and error milestones each post one message.
3. Completion posts a summary and attaches the diff; the diff opens on the phone.
4. A failed task reports the error with enough context to act.

## Boundaries

Rendering of task state to Signal only. Not the event source (epic-agent-adapter), not command
parsing (epic-command-router).

## References

- architecture — _bmad-output/initiative-signal-connector/architecture-signal-connector/architecture-signal-connector.md, AD-7
- prd — _bmad-output/initiative-signal-connector/prd-signal-connector/prd-signal-connector.md, section Progress & Notification

## Notes

- Decision: edit-in-place status + milestones + final summary with diff attachment (2026-10-11).
