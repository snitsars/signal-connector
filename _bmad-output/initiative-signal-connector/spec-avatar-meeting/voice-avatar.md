# Voice and avatar pipeline

Companion to `spec-avatar-meeting.md`. Everything here runs on the operator's machine.

## Where the audio lives

The connector drives a browser window and joins the room *inside the page*, as an
anonymous guest with no provider profile, so it never touches the operating system's
audio devices and holds no account credentials. Two consequences shape the design: no
virtual audio cable is needed on Windows, and the camera and microphone the room receives
are streams the page constructs:

- **camera** — an in-page canvas drawing the avatar, published with `canvas.captureStream()`
- **microphone** — a `MediaStreamAudioDestinationNode` fed by the synthesised speech
- **hearing the room** — a hook on the page's peer connection copies the remote audio
  track into an `AnalyserNode` and forwards it for transcription

Chromium's static fake-capture file flags are rejected as the mechanism: they replay a
recording, while the face and the voice change every second.

## The loop

```
room audio → energy gate → local transcription → project session
           → answer → synthesis → microphone stream + avatar mouth
```

The face is driven by the same events as the Signal status line and uses the connector's
colour language: blue while working, green when fine, red when attention is needed. A
drawn face needs about fifteen frames a second.

## The room may only propose

No voice in the room is an identity, and none of it is a command. Speech is transcribed,
gated and then offered to the agent as a prompt from the operator's project — nothing
else. A permission is announced aloud and then waits for the typed decision in Signal.
The session attaches on the authorised join, not on anything heard in the room.

## Liveness: two directions, not one sensor

- **Inbound** — one `AnalyserNode` RMS on the copied room audio, polled every five
  seconds while the meeting is active. It doubles as the energy gate: a transcribed
  sentence whose audio never rose above the noise floor is dropped and counted, so a
  small model cannot invent an instruction out of room tone. Zero amplitude with a
  participant present for the silence budget is the deaf alarm, posted in the group.
- **Outbound** — after the voice loop exists, the two-second acknowledgement doubles as
  a probe: the operator speaks, and no acknowledgement inside the budget means the room
  cannot hear the connector, which is posted rather than left to silence.
- **Presence** — participant presence is advisory telemetry: someone here, nobody visible
  or cannot tell, with a named `presence unknown` state when the list is unavailable. It
  may suppress convenience and never confers identity, approval or a block.

## Turn-taking

- The avatar acknowledges in about two seconds, then works; it never leaves silence where
  a hang could be suspected.
- While a task runs it speaks at the milestones the Signal group already receives.
- Speech is published only when spoken to; when the operator starts speaking, the avatar
  stops talking. Full duplex with overlap resolution is out of scope for the first slice.
- Both a spoken stop and the Signal stop command abort the running task.

## Tools to fetch

| Need | Choice | Cost |
|---|---|---|
| Transcription | a local whisper model (tiny or base), fetched the way signal-cli is | about 75 MB; CPU-only is enough for one speaker |
| Speech synthesis | the Windows system voice | nothing to download; Piper remains an option |

## Privacy

The room audio is carried by the meeting provider, because that is what a meeting is.
Everything the connector does with it — transcription, the agent, synthesis, the face —
is local, no transcript is written anywhere except the project's own summary, and the
join link lives only in the meeting row and the browser.
