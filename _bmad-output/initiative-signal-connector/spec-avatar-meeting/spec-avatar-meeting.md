---
id: SPEC-avatar-meeting
companions: [meeting-flow.md, voice-avatar.md]
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Sources listed in frontmatter are for traceability — consult them only if you need narrative rationale this contract intentionally omits.

# On-demand avatar meeting

## Why

Text in Signal is precise but slow for a conversation: every thought has to be typed and every answer read, and a task that needs back-and-forth becomes a wall of text. The pieces to do better now exist locally — a language model that can hold a conversation, a drawn face, a synthesised voice, and a browser that can join a meeting room — so the operator wants to *summon* a live room from the project's chat and simply talk. This is an opportunity to capture: it makes the agent already reachable from the phone reachable by voice too, without moving the text workflow out of Signal.

## Capabilities

- **CAP-1** summon a meeting from the project's chat
  - **intent:** The operator can ask, in a project's Signal group, for a live meeting about that project, and receive the link to join.
  - **success:** One command in the group produces one message carrying the room link and who is joining; a second request while a meeting runs is refused with the reason, whichever project asks; with no room configured the refusal says what to configure.
- **CAP-2** the face is present and readable
  - **intent:** The operator can see the connector in the meeting as a participant whose face shows what it is doing, in the connector's existing colour language.
  - **success:** The avatar appears in the participant list under the project's name within the join budget, and its face changes state (working, fine, needs attention) as the task progresses.
- **CAP-3** spoken conversation in project context
  - **intent:** The operator can talk to the avatar and hear answers about the project's current work, drawn from the same session the text loop uses.
  - **success:** A spoken question is answered aloud, with project context, within the reply budget, and the answer agrees with what the same question asked in Signal would produce.
- **CAP-4** text stays authoritative
  - **intent:** The operator keeps using Signal for commands, menus and approvals while the meeting runs, and the meeting's outcome lands in the project's group.
  - **success:** A permission announced aloud during a meeting is granted by typing in Signal, and the agent in the meeting obeys that decision; each meeting ends with exactly one summary message in the group.
- **CAP-5** local by construction
  - **intent:** The operator can run a meeting with no hosted bot service, no third-party voice service and no Google credentials: face, voice and browser are their own.
  - **success:** A full meeting runs with an empty credential store, and no room link or transcript appears in the repository or in a log line.
- **CAP-6** a meeting ends cleanly
  - **intent:** The operator can end a meeting, and the connector leaves the room, releases the microphone and reports the outcome.
  - **success:** After the stop command, or after the operator leaves, the avatar leaves within the stop budget and the project is free for the next meeting; a join that failed (not admitted, room no longer valid, provider UI change) is reported in the group with the reason.
- **CAP-7** survive an interruption
  - **intent:** The operator can keep talking after the connector stumbles: a restart, a crashed browser window or a machine wake brings the avatar back into the same room.
  - **success:** After a restart or a killed browser window during an active meeting, the avatar is back in the room within the rejoin budget, has said so in the group, and the operator continues with no new link; a meeting older than the activity window is left closed instead.

## Constraints

- Signal stays the only text channel, and no calls are added to any messenger. signal-cli's call audio needs a Unix-only tunnel binary, Telegram's Bot API cannot make or receive calls, and WhatsApp calling is a hosted Business API — this rules the in-chat call out and forces the meeting-platform route.
- The room is configured, never created: no Google credentials, no Cloud project and no API scope are needed, and rejoin works with no authentication at all.
- Voice and face are produced locally: transcription, synthesis and avatar rendering run on the operator's machine or as fetched external tools, never through a hosted API.
- Approvals are text-only: a spoken approval is refused, because anybody in the room can speak, while Signal text comes from the operator's own account.
- The active meeting is persisted in the store so it can be rebuilt after a restart — the same rule the rest of the runtime follows (the database is the single source of runtime state).
- Core stays transport-agnostic (spine AD-1): the meeting and the voice arrive as new ports, so `src/core/` gains no browser, audio or provider dependency.
- One meeting at a time, because there is one room; a second request while a meeting runs is refused rather than shared.
- Speech is acknowledged within about two seconds even when the task needs minutes, which forces an immediate spoken filler plus an asynchronous result.
- The room link is the only new secret: it stays in configuration outside the repository and never reaches a log line (spine AD-9).
- Windows first and no native build on the install path: browser automation plus fetched tools (a transcription model, a system voice), the same way signal-cli is fetched today.

## Non-goals

- No calls in Signal, Telegram or WhatsApp, and no Zoom or Teams support in this spec.
- No room creation, no Google API or OAuth work: the operator supplies a room link (or creates one by hand once); a fresh room per request is a possible later update.
- No resumption of the conversation mid-sentence after an interruption, and no retry storms: one rejoin attempt inside the activity window.
- No live captions built by the connector — the meeting platform already offers them as a viewer setting.
- No video of the operator, no recording, and no transcript artifact kept anywhere but the project's own summary.
- No hosted meeting-bot or voice service, no multi-tenant, no scheduling or recurring rooms, no calendar entries.
- Admitting other humans is the operator's action in the meeting; the connector runs no invitation flow.

## Success signal

- In a project's group the operator sends the meeting command, gets the room link, joins from the phone, and within a minute is talking out loud with the avatar about that project; a permission is announced aloud and granted by text in Signal; if the connector restarts or the browser dies, the avatar is back in the same room with no new link; and the group then holds one summary of what was said.

## Assumptions

- The operator has a room link, and can admit the avatar (or has set the room to admit participants without asking).
- A Chromium-based browser is available, and a visible window during a meeting is acceptable.
- The phone can open the room link from Signal (meeting app or mobile browser).
- Phone and machine both reach the meeting provider directly, so — unlike a locally served page — no LAN exposure of the connector is needed.
