---
title: 'Speak in the room'
type: 'feature'
ticket: '4'
created: '2026-10-17'
status: 'built'
baseline_revision: '864fa0c30fb9f76a44d4b04c8c4253cd13e793af'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: ['{project-root}/AGENTS.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** the avatar hears but cannot answer. A spoken question becomes a text task, so the
operator has to read the room's chat to get a reply. Speech has to be synthesised locally, played
through the microphone stream the room already receives, acknowledge the question inside the
two-second budget, and stop the moment the operator speaks — with nothing spoken until asked.

**Approach:** the injected script keeps the silent microphone's `AudioContext` and destination,
and exposes `speak(wavBase64)` / `stopSpeaking()` / `speech()`: a clip is decoded in the page and
played into that destination, so the room hears it through the same synthetic track. A new SAPI
adapter runs the Windows system voice through PowerShell to a 16 kHz mono WAV, using the runner
pattern whisper already has. `VoiceHandle` gains `speak` and `stopSpeaking`; the voice adapter
pre-generates the acknowledgement so it plays at once, speaks the summary of the task a spoken
question started, and stops speaking when the room's level rises above the gate.

## Boundaries & Constraints

**Always:** speech is produced locally by the Windows system voice — no hosted API and no new
dependency; the page plays through the existing synthetic microphone, so the room hears it
without any new stream or transport; the acknowledgement is ready before it is needed and plays
inside two seconds of the utterance being cut; nothing is spoken until a question is heard, and
the operator speaking stops the avatar mid-sentence; a spoken answer is capped so a long report
is not read out for minutes — the full text stays in the group; the synthesiser is injectable so
tests never spawn PowerShell.

**Never:** no speech for text-initiated tasks; no speaking over the operator; no audio written
anywhere but a temp WAV that is deleted after the page has the clip; no cloud TTS, no voice
pack download, no change to the meeting or hearing contracts beyond the handle's new methods.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Behavior | Error Handling |
|----------|--------------|-------------------|----------------|
| Question asked | Utterance cut while the avatar is listening | The acknowledgement is heard within the budget, then the answer after the task finishes | — |
| Long answer | A task summary past the cap | Only the first characters are spoken, the full text stays in the group | Truncated, never dropped silently |
| Operator interrupts | Room level above the gate while speaking | Speech stops immediately and the queued clips are dropped | No error poster |
| Silence | Nothing said | The avatar says nothing at all | — |
| No voice installed | SAPI unavailable or the run fails | The failure is posted in the project's group once; the meeting keeps working | Reason posted, not a crash |
| Page reloaded | The room navigates while queued speech waits | Speech state resets with the new document; nothing stale plays | — |
| Meeting ends | Stop, room ended, shutdown | Speaking stops with the meeting and the temp WAV is gone | — |

</frozen-after-approval>

## Code Map

- `src/adapters/meeting/avatarScript.ts` -- `silentStream` (119-131) is where the synthetic mic
  is made; keep the `AudioContext` and destination node, add a playback queue, a
  `decodeAudioData` path into that destination, `stopSpeaking`, and `speech()` on the existing
  `__signalConnectorAvatar` global (285-294); add `SPEAK_EXPRESSION`/`STOP_SPEAKING_EXPRESSION`
  beside `TAKE_PCM_EXPRESSION` (328-332).
- `src/adapters/meeting/browserMeeting.ts` -- it already polls (`474-491`) and evaluates
  expressions (`501`); add `playAudio(wavBase64)`, `stopAudio()` and `speechState()` on the
  class, driven over the same CDP session -- the page is the only thing that can make the room
  hear.
- `src/adapters/voice/sapi.ts` -- new: `synthesize(text)` running the Windows voice through
  PowerShell to a 16 kHz mono WAV, with the `ProcessRunner` shape from `whisper.ts` (11-22,
  114-126) so tests inject a fake; a temp file the caller deletes.
- `src/core/ports.ts` -- `VoiceHandle` (171-173) gains `speak(text: string): Promise<void>` and
  `stopSpeaking(): Promise<void>`; nothing else crosses the boundary.
- `src/adapters/voice/browserVoice.ts` -- pre-generate the acknowledgement in `start`, speak it
  before transcribing a cut utterance (144-163), speak a supplied answer on request, stop on a
  level above the floor (116-136), cap spoken text, keep the sink injectable.
- `src/domain/types.ts` + `src/store/store.ts` -- a `voice` flag on the task row (`CREATE
  TABLE` line 19-29 plus a guarded `ALTER TABLE ... ADD COLUMN` for existing databases) so a
  voice-initiated task is recognisable across restarts, per the one-database rule.
- `src/core/app.ts` -- `runTask` (460-485) takes an origin; `onHeard` (878-891) marks the task
  as voice; the idle/error completion branches (1042-1055, 1057-1067) speak the summary of a
  voice task only; `stopListening` (900-909) also stops speech.
- `src/config/config.ts` -- `voice` (52-78) gains `voiceName?` and `rate` (default 0) and
  `maxSpeechChars` (default 600); `scripts/config.example.toml` and the README document them.
- `src/adapters/fakes/fakeVoice.ts` -- gain `spoken`, a controllable `speak` promise,
  `stoppedSpeaking` and helpers to fire operator speech, so core tests need no audio.

## Tasks & Acceptance

**Execution:**
- [ ] `src/core/ports.ts` -- `speak` and `stopSpeaking` on `VoiceHandle` -- the only new surface.
- [ ] `src/adapters/voice/sapi.ts` -- the PowerShell synthesiser to a temp WAV, with an
  injectable runner and a bounded run -- local speech without a dependency.
- [ ] `src/adapters/meeting/avatarScript.ts` -- playback through the existing synthetic
  microphone: queue, decode, play, stop, and a `speech()` state -- the room can hear it.
- [ ] `src/adapters/meeting/browserMeeting.ts` -- `playAudio`, `stopAudio`, `speechState` over
  CDP; reset speech state when the page navigates -- one transport, already open.
- [ ] `src/adapters/voice/browserVoice.ts` -- the pre-generated acknowledgement, speaking an
  answer, barge-in on the level gate, the character cap, and a deletable temp WAV.
- [ ] `src/domain/types.ts`, `src/store/store.ts` -- the voice flag on a task row, with a guarded
  column addition for existing databases.
- [ ] `src/core/app.ts` -- mark a voice task, speak its summary (or its failure) when it
  finishes, and stop speech with the meeting.
- [ ] `src/config/config.ts`, `scripts/config.example.toml`, `README.md` -- the voice, rate and
  cap settings, and a "Talking back" note beside "Hearing the room".
- [ ] Tests: `sapi.test.ts` (the command, the temp file, a failed run), `avatarScript.test.ts`
  (queue, decode, stop, state) against the listening stub extended with `decodeAudioData`,
  `createBufferSource` and `resume`, `browserVoice.test.ts` (ack before transcription, barge-in,
  the cap), `src/core/app.test.ts` with `FakeVoice` (a voice task's completion is spoken, a text
  task's is not, a failure is spoken).

**Acceptance Criteria:**
- Given a spoken question, when the utterance is cut, then the acknowledgement is heard inside
  the two-second budget and the answer is heard once the task finishes.
- Given a task started by typing in the group, when it finishes, then nothing is spoken.
- Given the operator speaking while the avatar talks, then the speech stops and the queued clips
  do not play.
- Given an answer longer than the cap, then the spoken part is truncated and the full text
  remains in the group message.
- Given a synthesiser that fails, then the reason is posted once in the project's group and the
  meeting keeps running.
- Given the meeting ends, then speech stops and no temp WAV remains.

## Implementation Notes

## Plan Change Log

## Review Triage Log

Quick lens, 6 findings; each verified against the code. All real, all patches — no intent gap,
no plan fault, nothing deferred.

- **Barge-in misses the synthesis window** — `medium`, patch. Verified: `playClip` sets
  `speaking` only after `makeClip`, and `bargeIn` reads the page's state, which is idle while SAPI
  runs, so an interruption during synthesis is ignored and the answer then plays over the
  operator. Fix: mark the clip as pending before synthesising, honour that in the barge-in check,
  and drop the clip if the operator spoke.
- **Synthesis blocks the serial handler chain** — `high`, patch. Verified: `speakOutcome` is
  awaited inside `handleAgentEvent`, which runs on the one queue used by every Signal message,
  approval and agent event, with SAPI bounded at 45 s; `/meet stop` and approvals wait behind it
  and the diff attachment is delayed. Fix: do not await the speech — the summary is already
  posted.
- **The acknowledgement's synthesis outlives shutdown** — `medium`, patch. Verified: `whenIdle`
  awaits the ack's work but the handle's `stop()` and `BrowserVoice.stop()` do not, so a shutdown
  can exit while PowerShell still writes `speech-<uuid>.wav`, which nothing then deletes and no
  startup sweep exists. Fix: await that work on stop and sweep stale speech files when listening
  starts.
- **A reloaded page can receive a clip queued before it** — `medium`, patch. Verified:
  navigation stops the page's speech but the adapter's queue keeps its generation and `inRoom`
  stays true, so a clip synthesised before a reload plays into the new document. Fix: refuse
  playback while the fresh document has no avatar script and drop clips queued before a
  navigation.
- **The stop path can hang on a wedged page** — `high`, patch. Verified: `shutdown` awaits
  `sendStop` before `Browser.close` and `killTree`, and `CdpClient.send` has no per-call
  deadline, so a renderer that does not answer blocks leave, stop and service shutdown — against
  "the browser must not outlive the meeting"; the same unbounded call sits behind barge-in.
  Fix: bound that call so the close and the kill always happen.
- **An answer can be spoken into the wrong room** — `low`, patch. Verified: `speakOutcome` matches
  the live meeting by project id only and a voice task carries no meeting identity, so a task
  from an earlier meeting in the same project speaks into a later one. Fix: carry the meeting's
  start time with the voice origin and compare it.

## Design Notes

- **Why SAPI and not a fetched engine:** Windows already ships a local voice, so speaking costs
  no download and no dependency; the whisper pattern (an injectable runner, a bounded run, a
  temp file) is reused so tests stay offline.
- **Why the page must play it:** the room only hears what the synthetic microphone publishes.
  Decoding the WAV in the page and playing it into that destination is the smallest path and
  adds no stream, socket or protocol.
- **Why the acknowledgement is pre-generated:** a two-second budget does not survive a cold
  PowerShell start; one short clip made at `start` plays immediately for the rest of the meeting.
- **Why barge-in lives in the adapter:** the level gate and the speaking state are both in the
  voice adapter, so the operator's voice stops the avatar without a round trip through core.
- **Why a task carries a voice flag:** the completion path has to know whether to speak, and the
  one-database rule forbids an in-memory set that a restart would lose.

## Verification

**Commands:**
- `npm run typecheck` -- expected: exits 0
- `npm test` -- expected: all suites pass, including the new sapi, playback and app voice tests
- `npm run build` -- expected: exits 0

**Manual checks:**
- In a real room, ask a question out loud: the acknowledgement comes within a couple of seconds
  and the answer is spoken after the task finishes.
- Interrupt while it speaks: it stops at once and does not resume the interrupted clip.
- Type a task in the group: nothing is spoken when it completes.
