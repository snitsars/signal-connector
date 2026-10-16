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
  - **intent:** The operator can ask, in a project's Signal group, for a live meeting about that project, and receive a join link as a reply.
  - **success:** One command in the project group produces one message carrying a working meeting link whose room belongs to that project; an unknown project, or a second request while a meeting runs, is refused with the reason instead.
- **CAP-2** the face is present and readable
  - **intent:** The operator can see the connector in the meeting as a participant whose face shows what it is doing, in the connector's existing colour language.
  - **success:** The avatar appears in the participant list under the project's name within the join budget, and its face changes state (working, fine, needs attention) as the task progresses.
- **CAP-3** spoken conversation in project context
  - **intent:** The operator can talk to the avatar and hear answers about the project's current work, drawn from the same session the text loop uses.
  - **success:** A spoken question is answered aloud, with project context, within the reply budget, and the answer agrees with what the same question asked in Signal would produce.
- **CAP-4** text stays authoritative
  - **intent:** The operator keeps using Signal for commands, menus and approvals while the meeting runs, and the meeting's outcome lands in the project's group.
  - **success:** An approval typed in Signal during a meeting is honoured by the agent in the meeting, and each meeting ends with exactly one summary message in that group.
- **CAP-5** local by construction
  - **intent:** The operator can run a meeting with no hosted bot service and no third-party voice service: face, voice and browser are on their own machine.
  - **success:** With network access to Google only, a full meeting works with no third-party account besides the operator's Google one, and no credential, meeting link or transcript appears in the repository or in a log line.
- **CAP-6** a meeting ends cleanly
  - **intent:** The operator can end a meeting, and the connector leaves the room, releases the microphone and reports the outcome.
  - **success:** After the stop command, or after the operator leaves, the avatar leaves within the stop budget and the project is free for the next meeting; a join that failed (not admitted, Google UI change, no credentials) is reported in the group with the reason.

## Constraints

- Signal stays the only text channel, and no calls are added to any messenger. signal-cli's call audio needs a Unix-only tunnel binary, Telegram's Bot API cannot make or receive calls, and WhatsApp calling is a hosted Business API — this rules the in-chat call out and forces the meeting-platform route.
- Voice and face are produced locally: transcription, synthesis and avatar rendering run on the operator's machine or as fetched external tools, never through a hosted API.
- Google is authorised once through OAuth and the refresh token lives in the secrets store (spine AD-9); tokens, meeting links and transcripts never reach the repository or a log line.
- Core stays transport-agnostic (spine AD-1): the meeting and the voice arrive as new ports, so `src/core/` gains no browser, audio or Google dependency.
- One meeting per project at a time, because the project has one agent session; a second request is refused rather than shared.
- Speech is acknowledged within about two seconds even when the task needs minutes, which forces an immediate spoken filler plus an asynchronous result.
- Windows first and no native build on the install path: browser automation plus fetched tools (a transcription model, a system voice), the same way signal-cli is fetched today.

## Non-goals

- No calls in Signal, Telegram or WhatsApp, and no Zoom or Teams support in this spec.
- No video of the operator, no recording, and no transcript artifact kept anywhere but the project's own summary.
- No hosted meeting-bot or voice service, no multi-tenant, no scheduling or recurring rooms, no calendar entries.
- Admitting other humans is the operator's action in Meet; the connector does not run an invitation flow.

## Success signal

- In a project's group the operator sends the meeting command, gets the link, joins from the phone, and within a minute is talking out loud with the avatar about that project; mid-conversation an approval typed in Signal is honoured, and the group then holds one summary of what was said.

## Assumptions

- The operator has a Google account that may create meeting rooms and will authorise it once.
- A Chromium-based browser is available, and a visible window during a meeting is acceptable.
- The phone can open a meeting link from Signal (Meet app or mobile browser).
- Phone and machine both reach Google directly, so — unlike a locally served page — no LAN exposure of the connector is needed.

## Open Questions

- How is the room created: the Meet API with OAuth (recommended), a Calendar event carrying a conference link, the driven browser opening a new-room page, or one fixed personal room from config?
- Which local voice pair: the Windows system voice for synthesis plus a fetched transcription model (recommended), or Piper plus whisper.cpp?
- May a spoken yes or no approve a permission during a meeting, or do approvals stay text-only in Signal?
- Does the avatar need a distinct per-project name and picture in the participant list, and are live captions wanted inside the meeting?
- Must a meeting survive a connector restart by rejoining, or is best-effort acceptable?
