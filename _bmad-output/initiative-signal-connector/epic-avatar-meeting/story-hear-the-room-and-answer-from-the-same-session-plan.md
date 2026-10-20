---
title: 'Hear the room and answer from the same session'
type: 'feature'
ticket: '3'
created: '2026-10-17'
status: done
baseline_revision: '7111135c3827966035fc237e35b91d6c040ab4f3'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: ['{project-root}/AGENTS.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** the avatar has a face but no ears. A room's audio has to be copied inside the page,
gated by energy so a transcription invented over silence never reaches the agent, transcribed
locally, and handed to the project's session as a prompt — with no transport, port or protocol
added, and with nothing heard ever becoming a command, an approval or a stop.

**Approach:** the injected script hooks `RTCPeerConnection`, copies the remote audio into a
`ScriptProcessorNode`, downsamples to 16 kHz mono PCM and exposes a `takePcm()` pump. The
browser meeting adapter polls that pump over the CDP channel it already owns, applies an RMS
gate and a silence rule to cut utterances, writes each utterance as a 16 kHz WAV, and runs the
fetched local transcriber on it. A new `VoicePort` carries only text and levels to core, which
posts what it heard in the project's group and runs it through `runTask`, so the question lands
in exactly the session the text loop uses.

## Boundaries & Constraints

**Always:** core sees text and levels only — no PCM, no browser, no model (a new `VoicePort`);
a transcript is a *prompt*, never parsed as a command, so a spoken "approve" is inert; an
utterance whose audio never rose above the floor is dropped and **counted**; the transcriber is
**whisper.cpp fetched by a script** (its release plus a **multilingual base** model) and never a
bundled or npm-installed one; **every transcript is posted as `heard: <text>`** in the project's
group before its task runs; every failure (no tool, no model, a failed run) is posted in the
project's group with its reason; the meeting's project is explicit, because a voice task has no
incoming Signal message to derive it from.

**Never:** no new port, protocol or npm dependency; no speech model as an npm package and no
hosted transcription API; no host relaxation and no rejoin; no audio written anywhere but a
per-utterance temp file which is deleted; no speaking (that is the next entry); no retention of
audio beyond the run.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Behavior | Error Handling |
|----------|--------------|-------------------|----------------|
| Spoken question | Speech above the floor, then silence | One transcript posted in the project's group and run through `runTask` into the stored session | — |
| Room tone only | RMS under the floor | Nothing is transcribed; the drop counter rises | Counted, not logged only |
| Transcriber missing | `voice.whisperPath`/model absent | The utterance is dropped with a posted reason; the meeting keeps running | Detail posted in the project's group |
| Transcriber fails | Non-zero exit or a timeout | The utterance is dropped and counted, with the reason posted | One bounded run per utterance |
| Blank output | `[BLANK_AUDIO]`, empty or bracketed text | Dropped and counted | Never offered to the agent |
| Spoken command wording | "approve", "/stop", a shell line | Treated as a prompt like any other words | Never a command, approval or stop |
| Meeting ends | `/meet stop`, the room ending, a shutdown | Listening stops with the meeting and the pump is closed | No orphan polling |

</frozen-after-approval>

## Code Map

- `src/core/ports.ts` -- add `VoicePort` (`available()`, `start({ projectId, projectName,
  onUtterance, onLevel })` → a handle with `stop()`), beside `MeetingPort` (141-147) -- text and
  levels only.
- `src/core/app.ts` -- `CoreDeps` gains `voice?: VoicePort`; start listening on the meeting's
  `in-room` state and stop it on every terminal path (the `ActiveMeeting` holds the handle);
  on an utterance post `${MARK.info} heard: <text>` in the project's channel and call `runTask`
  with the project set explicitly (`conversation`/`currentProjectId`), since `runTask` (451-476)
  reads the session and posts through `channelFor`.
- `src/adapters/meeting/avatarScript.ts` -- extend the injected script: patch
  `RTCPeerConnection` before the room builds one, copy the remote track into a
  `MediaStreamAudioSourceNode` → `ScriptProcessorNode`, downsample to 16 kHz mono, and expose
  `takePcm()` (base64) plus the current RMS on the existing `__signalConnectorAvatar` global.
- `src/adapters/meeting/browserMeeting.ts` -- a poll that drains `takePcm()` over the CDP client
  it already has and hands the bytes to the voice pipeline -- no new transport.
- `src/adapters/voice/` -- new: `pcm.ts` (base64 → Int16, RMS, downsample helpers, pure),
  `wav.ts` (a 16 kHz mono WAV writer, pure), `whisper.ts` (spawn the fetched tool with a
  timeout and parse its text), `browserVoice.ts` (the `VoicePort`: pump, energy gate, utterance
  cutting, WAV, transcribe, count).
- `src/adapters/fakes/fakeVoice.ts` -- new, beside `fakeMeeting.ts`: records starts/stops and
  can emit utterances, levels or failure.
- `src/config/config.ts` -- a top-level `voice` object (`whisperPath`, `modelPath`, `language?`,
  `rmsFloor`, `silenceMs`, `maxUtteranceMs`) with defaults, beside `bridge` (46-51);
  `scripts/config.example.toml` and the README document it.
- `scripts/install-whisper.ps1` -- new, following `install-signal-cli.ps1`: fetch a whisper.cpp
  Windows release and a multilingual model into `%LOCALAPPDATA%\SignalConnector\whisper`, verify
  the binary runs, and print the two config paths -- the story's hitl step.
- `src/index.ts` -- construct the voice adapter and pass it in, stop it on shutdown (113-126).

## Tasks & Acceptance

**Execution:**
- [ ] `src/core/ports.ts` -- declare `VoicePort`, its handle and its event shapes -- keeps core
  free of PCM and of the browser.
- [ ] `src/adapters/voice/pcm.ts` and `wav.ts` -- pure: base64 → Int16, RMS over a window, a
  decimating downsample, and a WAV header writer -- the maths every later test leans on.
- [ ] `src/adapters/meeting/avatarScript.ts` -- the audio hook and the pump in the injected
  script, next to the existing override and liveness flag -- the page is the only thing that can
  reach the room's audio.
- [ ] `src/adapters/meeting/browserMeeting.ts` -- drain the pump on a short interval and hand
  the bytes to the voice pipeline -- reuses the CDP channel, adds no transport.
- [ ] `src/adapters/voice/whisper.ts` -- run the configured tool with a bounded timeout, parse
  its text, and report a missing tool or a failed run as a reason -- the only subprocess here.
- [ ] `src/adapters/voice/browserVoice.ts` -- the gate (RMS floor, silence rule, maximum
  utterance length), the utterance → WAV → transcript path, the drop counter, and the level
  callback -- one pipeline, no policy in core.
- [ ] `src/core/app.ts` -- start the port when the avatar is in the room, stop it on every
  terminal path, post each transcript in the project's group, and run it with the project set
  explicitly -- so the session is the one the text loop uses.
- [ ] `src/config/config.ts`, `scripts/config.example.toml`, `README.md` -- the `voice` settings
  and what to run to fetch the tool.
- [ ] `scripts/install-whisper.ps1` -- the fetch and verify step, printing the paths to paste
  into config -- the hitl part of the ticket.
- [ ] Tests: `src/adapters/voice/*.test.ts` (pcm, wav, the gate's boundaries, whisper's
  argument/timeout parsing with a fake run), `avatarScript.test.ts` (the audio hook against a
  stub `RTCPeerConnection`), `src/core/app.test.ts` with `FakeVoice` (a transcript becomes a task
  in the stored session, "approve" spoken stays a prompt, a drop is counted, the port starts and
  stops with the meeting).

**Acceptance Criteria:**
- Given a meeting in the room, when speech is heard and then silence, then one transcript is
  posted in the project's group and a task starts with `store.getSession(project)` as its
  session — the same session a typed task would use.
- Given audio that never rises above the floor, when the utterance is cut, then nothing is
  transcribed, no task starts, and the drop counter has risen.
- Given a transcriber that is missing or exits non-zero, then the reason is posted in the
  project's group, the utterance is counted as dropped, and the meeting keeps running.
- Given a transcript that reads like a command ("approve", "/stop"), then it is passed to the
  agent as text and no permission is decided and no task is stopped.
- Given a transcript of only `[BLANK_AUDIO]` or empty text, then it is dropped and counted.
- Given the meeting ends for any reason, then listening stops and no pump polling continues.

## Implementation Notes

## Plan Change Log

## Review Triage Log

Quick lens, 8 findings; each verified against the code. All real, all patches — no intent gap,
no plan fault, nothing deferred.

- **The installer's printed block would break the daemon** — `high`, patch. Verified: the
  generated default config already contains a `[voice]` table, smol-toml rejects a second one
  ("trying to redefine an already defined table"), and `loadConfig` has no try/catch, so pasting
  what the script prints makes `main()` exit 1. The README repeats the same block. Fix: print the
  two key lines only, with a note to put them inside the existing `[voice]` table.
- **Only the first remote audio track is ever captured** — `medium`, patch. Verified: the guard
  `hearing.processor` is global and there is no `ended`/re-attach path, so a room whose first
  track is another participant, or a track that ends, leaves the rest unheard. Fix: connect every
  audio track's source to the same processor, and re-attach after a track ends; adjust the test
  name that claims the second track is ignored.
- **Pure-silence windows are counted as dropped utterances** — `medium`, patch. Verified: after a
  transcript the next window accumulates silence, cuts on `silenceMs` with `maxLevel` 0 and
  increments `dropped`, so a quiet room climbs about once a second and the number stops meaning
  "dropped utterances". Fix: cut and count only windows that contained audio above the floor.
- **The drop count has no surface the operator can see** — `low`, patch. Verified: every
  increment logs at debug, which the default `info` level drops, and `drops` is read only by
  tests, so the plan's manual check cannot be performed. Fix: state the first drop and the
  session total at info level.
- **`missingReported` is process-wide** — `medium`, patch. Verified: set once and never reset, so
  a second meeting stays silent about the missing tool, against "every failure is posted". Fix:
  reset it when listening starts, and cover it.
- **A throw from the deletion loses the utterance and keeps the WAV** — `medium`, patch.
  Verified: `fs.rmSync` sits in a `finally`, so a Windows lock (a killed transcriber still holds
  the file) replaces the result, is swallowed by the queue's catch, and leaves the file —
  against "no retention of audio". Fix: guard the deletion so it can never replace the result.
- **`downsample` is dead code and the page does not do what it documents** — `low`, patch.
  Verified: the helper is used only by its own test; the page decimates by plain sampling, so the
  maths under test is not the maths in production. Fix: average in the page as documented, and
  delete the unused helper and its test.
- **`available()` sits outside the try in `startListening`** — `low`, patch. Verified: a
  rejecting availability propagates out of `onMeetingState` before the in-room message is painted,
  leaving only a queued `handler error` log. Fix: move the call inside the try.

## Design Notes

- **Why the pump rides CDP and not a socket:** the page is already driven by the meeting
  adapter, and the bridge port is the single-instance lock and speaks the plugin protocol. A
  `takePcm()` call on the existing session costs no new port, protocol or trust boundary; if a
  real room shows the 250 ms pump too coarse, a dedicated audio socket is the fallback, noted
  here so the choice is deliberate.
- **Why 16 kHz mono PCM early:** whisper wants exactly that, so downsampling in the page keeps
  every later step trivial and file-based, with no transcoding tool (no ffmpeg).
- **Why a WAV per utterance:** the fetched transcriber takes a file, and one short file per
  utterance is the simplest bounded contract; it is deleted immediately after the run.
- **Why the energy gate is the hallucination guard:** a small model invents fluent sentences
  over room tone; requiring audio above the floor before a transcription is used is the cheapest
  rule that removes the class, and the counter makes its duty visible.
- **Why voice tasks go through `runTask`:** the session binding, the status message, the summary
  and the store row already exist there; the voice path only has to set the project explicitly,
  because there is no incoming message to take it from.
- **Why core sees only text:** `VoicePort` keeps the browser, PCM and the model on the adapter
  side (spine AD-1), so the gate, the session rule and the counting are testable with a fake.

## Verification

**Commands:**
- `npm run typecheck` -- expected: exits 0
- `npm test` -- expected: all suites pass, including the new voice suites and the meeting
  command cases with `FakeVoice`
- `npm run build` -- expected: exits 0

**Manual checks:**
- Run `scripts/install-whisper.ps1`, put the two paths into `config.toml`, start a meeting, say
  a sentence: one "heard: …" message appears in the project's group and the agent answers in the
  same session as a typed task.
- Say nothing for a minute, then check the drop counter: room tone produced no transcript.
- Say "approve" out loud while a permission waits: nothing is approved; the words reach the
  agent as text only.
