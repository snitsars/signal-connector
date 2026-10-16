---
id: SPEC-avatar-meeting
companions: [meeting-flow.md, voice-avatar.md]
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Sources listed in frontmatter are for traceability — consult them only if you need narrative rationale this contract intentionally omits.

# On-demand avatar meeting

## Why

Text in Signal is precise but slow for a conversation: every thought has to be typed and every answer read, and a task that needs back-and-forth becomes a wall of text. The pieces to do better now exist locally — a language model that can hold a conversation, a drawn face, a synthesised voice, and a browser that can join a room — so the operator wants to be talked to about their project. A room costs the operator one tap in the meeting app and one pasted link, so this is an opportunity to capture: the agent already reachable from the phone becomes reachable by voice, and the text workflow stays where it is.

## Capabilities

- **CAP-1** summon a meeting by pasting a link
  - **intent:** The operator can hand the connector a room link in a project's group and have the connector join that room for that project.
  - **success:** A link pasted with the command from the configured operator account in the project's own group produces one notice naming the project; a paste from any other sender, an empty, malformed or foreign link, a link for an ended room, and a paste while another meeting is open each get their own named refusal, decided before anything joins.
- **CAP-2** the face is present and readable
  - **intent:** The operator can see the connector in the room as a participant whose face shows what it is doing, in the connector's existing colour language, without any provider account.
  - **success:** The avatar is admitted within the join budget as an anonymous guest, and its face changes state (working, fine, needs attention) as the task progresses; nothing about the project is published before admission.
- **CAP-3** spoken conversation in project context
  - **intent:** The operator can talk to the avatar and hear answers about the project's current work, drawn from the same session the text loop uses, while the room stays a channel that may only propose.
  - **success:** A spoken question is answered aloud within the reply budget from the same session; no spoken input ever becomes a command, an approval or a stop; a transcription that fails the audio energy gate is dropped and counted instead of executed.
- **CAP-4** text stays authoritative
  - **intent:** The operator keeps using Signal for commands, menus and approvals, and the text channel is the only authenticated identity in the system.
  - **success:** A permission announced aloud in the room is granted by typing in Signal and the agent obeys that decision; no room event can command, approve or stop anything; admitting a second human degrades the meeting to listen-only.
- **CAP-5** local and credential-free
  - **intent:** The operator can run a meeting with no hosted bot service, no third-party voice service and no provider credentials at all.
  - **success:** A full meeting runs against an empty credential store and with no logged-in provider profile; the join link never appears in the repository, a log line, a refusal or a group message, and is wiped the moment the meeting stops being open.
- **CAP-6** a meeting ends cleanly and out loud
  - **intent:** The operator can end a meeting, and the connector leaves, releases the audio, frees the project and reports the outcome — including when something it promised has failed.
  - **success:** After the stop command, or after the operator leaves, the avatar leaves within the stop budget, the credential is wiped and the slot is free; a failed join or a failed guard is posted in the group with its reason and, where one exists, raised in the health check.
- **CAP-8** no silent deafness
  - **intent:** The operator can tell whether the connector is actually hearing the room, instead of talking into silence.
  - **success:** With the avatar admitted, no remote audio and no track-state change for the silence budget is reported in the group by the next poll; participant presence is reported as one of someone here, nobody visible or cannot tell, and never as an identity or as a block.

## Constraints

- Signal stays the only text channel, and no calls are added to any messenger: signal-cli's call audio needs a Unix-only tunnel binary, Telegram's Bot API cannot make or receive calls, and WhatsApp calling is a hosted Business API — which is what forces the meeting-platform route.
- The room may only propose. No voice, display name, participant entry, nonce or room event attaches the session or carries a command, an approval or a stop; the session attaches on the authorised join and speech is published only when spoken to.
- Who is in the room is unverifiable, and the contract says so: every occupant, the operator included, is an untrusted voice; the only authenticated identity is the project group's text channel; a second human makes the meeting listen-only.
- The pasted link is the authorisation and the join notice is not. Accepted identities are configured, one entry per project (ACI or uuid, the number as a label, a revocation date), and an empty list is fail-closed — the entry exists so that "not authorised" is a different answer from "unknown".
- The join URL and the room id are a credential: they live only in the meeting row and the browser, never in a log line, a refusal or a group message, and are wiped the instant the meeting stops being open (including on restart, because rejoin is deferred).
- Validation (https, canonical parse, provider host allow-list, liveness probe) and the single-meeting claim are one store write committed before the browser opens; everything refusable is refused before entry; a refusal names a category and at most the holding project with its start time.
- Voice and face are produced locally: the browser joins as an anonymous guest with no provider profile, and transcription and synthesis run on the operator's machine or as fetched external tools, never through a hosted API.
- Every declared guard must post in the project group or raise a health signal when it fails, and every stored active meeting must reach exactly one terminal outcome — a confirmed announced rejoin or a posted failure with the row cleared. An active row that outlives the activity window with no posted outcome is a hard failure, surfaced in the group and in the health check, never only in a log line.
- Core stays transport-agnostic (spine AD-1): the meeting and the voice arrive as new ports, so `src/core/` gains no browser, audio or provider dependency.
- One meeting at a time; speech is acknowledged within about two seconds; Windows first with no native build on the install path (browser automation plus fetched tools, the way signal-cli is fetched).

## Non-goals

- No rejoin after an interruption in this slice: the retired capability is a named deferral — a restart leaves the room, wipes the credential and tells the group.
- No calls in Signal, Telegram or WhatsApp; no Zoom, Teams or other meeting platform in this spec.
- No provider API or OAuth work: the operator creates the room by hand, with knocking on, and locks it after admission.
- No per-join hearing challenge: the spoken nonce readback was rejected as unbuildable, and the hearing test shrinks to a one-time setup step.
- The two-second acknowledgement as a liveness probe ships after the voice loop, not with it.
- No multi-human meetings: a second human degrades the meeting to listen-only.
- No live captions, no recording, no transcript artifact anywhere but the project's summary, and no video of the operator.
- No hosted meeting-bot or voice service, no multi-tenant, no scheduling or calendar entries, no machine-wake recovery.

## Success signal

- In a project's group the operator pastes a link with the command, is told the connector is joining, is admitted in the room, and within a minute is talking out loud with the avatar about that project; a permission is announced aloud and granted by text in Signal; when the room goes silent the group is told instead of being left talking to nothing; and the group then holds one summary of what was said, with the link no longer anywhere in the system.

## Assumptions

- The operator creates rooms by hand in the meeting app with knocking on and locked after admission, and holds the link until they paste it.
- A Chromium-based browser is available, and a visible window during a meeting is acceptable.
- The provider admits an anonymous guest who knocks.
- The phone can open a room link from Signal.
- Phone and machine both reach the provider directly, so no LAN exposure of the connector is needed.
