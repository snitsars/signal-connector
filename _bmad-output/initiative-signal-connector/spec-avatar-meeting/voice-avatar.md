# Voice and avatar pipeline

Companion to `spec-avatar-meeting.md`. Everything here runs on the operator's machine.

## Where the audio lives

The connector drives a browser window and joins the meeting *inside the page*, so it
never touches the operating system's audio devices. Two consequences shape the design:
no virtual audio cable is needed on Windows, and the camera and microphone the meeting
receives are streams the page constructs:

- **camera** — an in-page canvas drawing the avatar, published with `canvas.captureStream()`
- **microphone** — a `MediaStreamAudioDestinationNode` fed by the synthesised speech
- **hearing the room** — a hook on the page's peer connection copies the remote audio
  track and forwards it for transcription

Chromium's static fake-capture file flags are rejected as the mechanism: they replay a
recording, while the face and the voice change every second.

## The loop

```
meeting audio → voice-activity gate → local transcription → project session
            → answer → synthesis → microphone stream + avatar mouth
```

The face is driven by the same events as the Signal status line and uses the connector's
colour language: blue while working, green when fine, red when attention is needed.
A drawn face needs about fifteen frames a second.

## Turn-taking and the reply budget

- The avatar acknowledges in about two seconds, then works — it never leaves silence
  where a hang could be suspected.
- While a task runs it says what it is doing at the milestones the Signal group already
  receives.
- When the operator starts speaking, the avatar stops talking. Full duplex with overlap
  resolution is out of scope for the first slice.
- Both a spoken stop and the Signal stop command abort the running task.

## Tools to fetch

| Need | Choice | Cost |
|---|---|---|
| Transcription | a local whisper model (tiny or base), fetched the way signal-cli is | about 75 MB; CPU-only is enough for one speaker |
| Speech synthesis | the Windows system voice | nothing to download; Piper remains an option |

## Privacy

The room audio is carried by the meeting provider, because that is what a meeting is.
Everything the connector does with it — transcription, the agent, synthesis, the face —
is local, and no transcript is written anywhere except the project's own Signal summary.
