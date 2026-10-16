---
tracker_id: ""
key: ""
type: epic
title: "Talk to the agent in a meeting room, with a face"
parent: initiative-signal-connector
covers: ["CAP-1", "CAP-2", "CAP-3", "CAP-4", "CAP-5", "CAP-6", "CAP-8"]
after: [{ epic = 4, needs = "the command router, the project channel mapping and the session binding" }]
assignee: ""
risk: high
---

# Talk to the agent in a meeting room, with a face

## Description

Text in Signal stays exactly as it is; this epic adds a second, spoken console for the same
project session. The operator creates a meeting room by hand, pastes its link into the
project's Signal group with `/meet`, and the connector joins that room as an anonymously
admitted avatar with a drawn face and a locally synthesised voice. It hears the operator
through local transcription, answers from the same opencode session the text loop uses, and
ends with one summary in the group. The full contract is the spec in this folder.

## Outcome

The operator asks a question out loud about the project they are working on and hears the
answer from the agent that already holds the context — the spec's success signal, including
the two promises that keep it honest: the room may only propose, and the group is told when
the room goes deaf instead of the operator talking into silence.

## Requirements

The spec in this folder is the numbered source and it owns the ids; each entry lists the
capabilities it delivers in `covers`.

- CAP-1 summon a meeting by pasting a link — the paste is the summon and the authorisation
- CAP-2 the face is present and readable, as an anonymous guest with no provider account
- CAP-3 spoken conversation in project context, from the same session the text loop uses
- CAP-4 text stays authoritative, and text is the only authenticated identity in the system
- CAP-5 local and credential-free: no hosted service, no provider credentials, no logged profile
- CAP-6 a meeting ends cleanly and out loud, with the credential wiped and every failure named
- CAP-8 no silent deafness: the group learns when the room cannot be heard
- CAP-7 (surviving an interruption) is a named deferral in the spec's non-goals, not work here

## Done when

1. From a project's group, a pasted link puts the avatar in the room with a working
   three-colour face, and `/meet stop` leaves, frees the slot and posts exactly one summary.
2. A spoken question is answered aloud from the same session a typed question would reach.
3. No voice in the room ever becomes a command, an approval or a stop; a permission is
   announced aloud and decided by typing in Signal; a second human in the room makes the
   meeting listen-only.
4. Every refusal in the spec's gate table is produced by its own case with nothing joining,
   and the join link appears in no log line, no refusal and no group message.
5. With the avatar admitted and the room silent for the silence budget, the group is told by
   the next poll.
6. Every stored active meeting reaches exactly one terminal outcome, surfaced in the group.

## Boundaries

The meeting channel and the voice, inside the existing service. Not the Signal transport, not
the agent adapter, not the command router, not the store, not the launcher — those are touch
points owned by epics already in production. The spec's non-goals bound it: no messenger
calls, no other meeting platform, no provider API or OAuth work, no rejoin after an
interruption in this slice, no multi-human meetings (a second human makes it listen-only),
no captions, no recording, no hosted bot or voice service.

## References

- parent — _bmad-output/initiative-signal-connector/initiative-signal-connector.md
- spec — spec-avatar-meeting/spec-avatar-meeting.md, capabilities CAP-1..CAP-8 and the constraints
- spec — spec-avatar-meeting/meeting-flow.md, the commands, the gate table, the budgets
- spec — spec-avatar-meeting/voice-avatar.md, the in-page camera and microphone, the two liveness directions
- constraint — AGENTS.md, Conventions: ports and adapters (core imports no adapter), one SQLite database as the single source of runtime state, no native build dependency
- constraint — architecture-signal-connector/architecture-signal-connector.md, AD-1 (core imports no adapter) and AD-9 (secrets never in the repo or a log line)

## Notes

- Decision: the first slice order is the room the operator can see, then the gate, then the
  voice (2026-10-17). The tracer bullet is entry 1, and it threads every layer the epic
  touches — the command, the meeting row, the browser, the face, the attached session and the
  closing summary — because browser automation, canvas-as-camera and anonymous admission are
  the three unknowns that can kill the feature, and the gate is pure enough to be tested
  under fakes with no browser, no Signal and no opencode.
- Source namespace: this epic's `CAP-n` ids are local to `spec-avatar-meeting/` and do not
  resolve to a PRD capability — the spoken meeting is new work that the PRD never carried.
  Epic 6 cites `CAP-n` from a different local spec, so the two namespaces must not be mixed;
  when this epic's ids are cited from elsewhere they are `7.<entry>` for entries and
  `spec-avatar-meeting/CAP-n` for capabilities.
- Decision: entry 1 is deliberately the largest entry and carries four capabilities, so it
  gets `plan_checkpoint = true`; a person reads the plan before it starts. If it proves too
  big in the building, the join splits into the room adapter and the command wiring without
  moving an id.
- Decision: the room is created by hand by the operator and the connector never creates rooms
  or holds provider credentials; the browser joins as an anonymous guest (2026-10-17).
- Decision: no voice in the room ever becomes a command, an approval or a stop; the Signal
  text channel is the only authenticated identity, and a second human in the room makes the
  meeting listen-only (2026-10-17).
- Decision: the retired capability for surviving an interruption is a named deferral, not an
  entry here; in its place the epic promises there is no silent deafness (2026-10-17).
- Decision: the spoken hearing challenge shrinks to a one-time setup step, and the two-second
  acknowledgement as an outbound liveness probe ships after the voice loop (2026-10-17).
- Decision: this epic is built before epic 6 (distribution) finishes, at the operator's
  request; nothing in it waits on epic 6 (2026-10-17).
- Waits on epic 4 because: the `/meet` command, the project-to-channel mapping and the
  session binding are the command router's, already in production; epics 2 and 3 are reached
  through it, so one gate covers the chain.
- Assumption: the operator's machine can run a visible Chromium window and fetch a small
  transcription model, the way signal-cli is fetched.
- Unknown: whether the operator's account settings admit an anonymous guest who knocks;
  entry 1 settles it, and a refusal there reshapes the join rather than the contract.
- Unknown: how cheaply the room's audio can be tapped inside the page for the energy gate and
  the transcription without any operating-system audio device; entry 3 settles it.
- Parked: the outbound liveness probe and the one-time hearing setup step, both named in the
  spec's non-goals.
