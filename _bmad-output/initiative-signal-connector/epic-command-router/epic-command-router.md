---
tracker_id: ""
key: ""
type: epic
title: "Command router and conversation"
parent: initiative-signal-connector
covers: [CC1, CC2, CC3, CC4, CC5, CC6]
after: []
assignee: ""
risk: medium
---

# Command router and conversation

## Description

The domain core: parse slash commands, route free-form text to the active project's session, track
the active project, and run the approval conversation (numbered prompt, reply or reaction,
`always`). Depends on `SignalPort` and `AgentPort`; contains no I/O of its own.

## Outcome

The operator can drive the agent by messaging Signal: `/use`, `/task`, `/status`, `/stop`, `/new`,
`/projects`, `/help`, free-form prompts, and `approve`/`deny`/`always` answers all behave as the
PRD describes.

## Requirements

- CC1: recognize `/use /task /status /approve /deny /stop /new /projects /help`.
- CC2: free-form text routes to the active project's session.
- CC3: `/use` sets the active project; `/projects` lists them.
- CC4: unknown commands return a help hint.
- CC5: permissions are numbered prompts answered by keyword or 👍/👎 reaction.
- CC6: `always` remembers the decision for the session.

## Done when

1. Every command in CC1 produces its described effect against fakes.
2. Free-form text reaches the active session as a prompt.
3. A permission prompt is answered by keyword and by reaction, both unblocking the agent.
4. `/help` and an unknown command both return guidance, not an error.

## Boundaries

Command interpretation and conversation state only. Not transport (epic-signal-transport), not
agent specifics (epic-agent-adapter), not how progress is rendered (epic-progress-notify).

## References

- architecture — _bmad-output/initiative-signal-connector/architecture-signal-connector/architecture-signal-connector.md, AD-1, AD-8
- prd — _bmad-output/initiative-signal-connector/prd-signal-connector/prd-signal-connector.md, section Command & Conversation

## Notes

- Decision: hybrid protocol — slash commands plus free-form routing to the active session (2026-10-11).
- Decision: answer permissions by keyword or emoji reaction; persist `always` (2026-10-11).
