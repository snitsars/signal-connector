# Voice architecture: why it feels slow and synthetic, and what to change

Status: analysis for the meeting voice loop (epic 7 and its live-run follow-ups).
Date: 2026-10-24. Evidence: live logs from this machine, the current adapters, and
public documentation of the open-source and hosted options below.

## 1. Executive summary

The browser-as-transport decision is sound: every meeting bot does it, and it is
the only way to be a real participant in Jitsi/Meet without provider credentials.
The problem is **inside** the loop: it is a **batch, request/response pipeline**,
not a streaming one.

Every turn today is:

```
room audio -> energy gate (1.1 s of silence) -> one WAV -> cloud ASR (1.7 s)
           -> opencode task (one full answer) -> cloud TTS (1-2 s)
           -> one clip -> page -> room
```

Nothing overlaps. The operator waits for the sum, hears one long monologue, and the
recogniser sees short, noisy, endpointed fragments instead of a continuous stream.
That is why it is slow, why it "sits quiet" while the operator is still talking, and
why the voice sounds like a reader rather than a participant.

A conversational loop needs four continuous streams (mic, ASR partials, LLM tokens,
TTS audio) plus an end-of-turn detector and barge-in. Public benchmarks put that at
**500-800 ms per turn** (Pipecat), against our **5-15 s**.

## 2. What we measured here

| Stage | Current implementation | Measured on this machine |
|---|---|---|
| End of turn | fixed energy gate, `silenceMs = 1100` | 1.1 s dead time after every phrase |
| Room to text | one WAV per utterance, `POST /v1/audio/transcriptions` (`gpt-4o-transcribe`, `uk`) | ~1.7 s; NVIDIA Riva ~0.6 s |
| Text to task | HTTP prompt into opencode, one session per meeting | one full answer, no token stream |
| Task to audio | one full clip (`azure`/`openai`), played after the whole answer | Azure 1.1-1.6 s; OpenAI 0.5-2 s |
| Turn total | sum of the above plus the agent | typically 5-15 s, longer behind a busy session |

Two more facts from the live runs:

- The recogniser produced Spanish, Korean and Arabic on room tone, and Ukrainian
  fragments of the same phrase three times ("Розкази / Розкрив / Досказую"). The
  language filter now drops the foreign scripts; the fragmentation is a turn-taking
  problem, not a model problem.
- "I see the answer but hear nothing" had a concrete cause: OpenAI's streamed WAV
  header carries `0xFFFFFFFF` sizes, which `decodeAudioData` refuses. Fixed.

## 3. Root causes

1. **No streaming.** The mic is sampled by a deprecated `ScriptProcessorNode` in the
   page, buffered into a WAV, and posted only after the utterance ends. ASR, LLM and
   TTS run strictly one after another.
2. **Turn detection is an energy threshold, not a model.** A fixed 1.1 s of silence
   cuts mid-sentence, and room noise passes the gate, so fragments become tasks.
   There is no semantic end-of-turn and no "the operator is still speaking" signal.
3. **No partial results.** The room hears nothing until the *whole* answer exists.
   A 300-character answer means seconds of silence followed by a monologue.
4. **The agent is serial and unbounded.** One opencode session, one answer, no
   streaming tokens, no fast lane; long work blocks the conversational lane.
5. **TTS is one shot, one voice, one language.** No sentence-level streaming and no
   per-segment language switch, so English names are read by a Ukrainian voice and
   long answers have no natural pauses.
6. **No barge-in that works.** It was disabled because an aggressive energy gate cut
   every answer. The correct fix is VAD + echo cancellation + cancel-the-TTS, not a
   bigger threshold.
7. **No audio conditioning.** Jitsi already applies some processing; our capture has
   no AGC/NS and no per-frame confidence, so quiet speech is either missed or
   transcribes to noise.
8. **No per-stage metrics.** We cannot see where a turn spent its time, so tuning is
   guesswork.

## 4. What good looks like (public references)

| Project / product | What it does | Numbers / notes |
|---|---|---|
| **Pipecat** (open source, Python, BSD-2) | Pipeline of processors: transport, VAD, ASR, LLM, TTS; WebRTC transports (Daily, LiveKit, SmallWebRTC); Silero VAD, Krisp/RNNoise | Published 500-800 ms per turn; 150+ integrations |
| **LiveKit Agents** (open source) | WebRTC transport + agent framework with turn detection, interruption handling, multi-agent | Built for real-time voice; self-host or cloud |
| **Recall.ai** (managed bot API) | A bot joins Zoom/Meet/Teams/Webex; real-time transcripts and audio over webhook/WebSocket | ~$0.50/h; 99.9% SLA; closest to our join problem, but a paid dependency |
| **Attendee / Vexa** (self-hosted bots) | Browser-based meeting bots, source-available/Apache-2.0 | Same browser-automation class as ours, packaged and maintained |
| **Deepgram Flux / Nova-3** | Streaming ASR with integrated end-of-turn detection; multilingual | EOT median <300 ms; Nova-3 ~450 ms median, <300 ms p95 |
| **ElevenLabs Scribe v2 Realtime** | Streaming ASR, 90+ languages | sub-150 ms, predictive streaming |
| **AssemblyAI Universal-3 Pro Streaming** | Streaming ASR | 150-307 ms P50, but 6 streaming languages (no Ukrainian) |
| **ElevenLabs Flash v2.5** | Streaming TTS, 32 languages incl. Ukrainian, code-switching | ~75 ms model latency, ~350 ms measured end-to-end |
| **Azure Speech** (current TTS) | Native uk-UA voices, SSML, streaming SDK | good pronunciation, no per-sentence language switch by default |
| **OpenAI Realtime / Gemini Live** | Speech-to-speech over one WebSocket, no separate ASR/TTS | lowest conceptual latency, but replaces our ASR/TTS control and raises cost/lock-in |

## 5. Options compared

Criteria: end-to-end latency, Ukrainian + code-switching, meeting join, engineering
effort, cost, and risk to the current architecture.

| Option | Latency (target) | Ukrainian / code-switch | Meeting join | Effort | Cost | Verdict |
|---|---|---|---|---|---|---|
| **A. Current** (browser + batch OpenAI/Azure) | 5-15 s | good ASR, TTS uk-only, names read uk | browser (works) | none | low | baseline |
| **B. Streaming in place** (browser transport + streaming ASR + streaming TTS + VAD + token streaming) | 1-2 s | ASR auto/streaming; TTS per-sentence `lang` (uk/en) | browser (unchanged) | medium (2-4 tickets) | low-medium | **recommended first** |
| **C. Pipecat/LiveKit agent** (Python service + WebRTC transport, browser as the meeting endpoint) | 0.6-1.2 s | provider-dependent, excellent turn-taking | browser or managed bot | high (new service, new language) | medium | best quality, bigger step |
| **D. Speech-to-speech** (OpenAI Realtime / Gemini Live) | 0.5-1 s | strong code-switch, but less control over text/voice | browser bridge | medium-high | high | attractive, lock-in |
| **E. Managed meeting bot + our agent** (Recall.ai / Vexa) | 1-2 s | we choose ASR/TTS | vendor joins Meet/Teams | medium | $$ per hour | breaks "no provider credentials", good for Meet |

Recommendation: **B now, C if B is not enough.** The join problem is orthogonal and
already solved for Jitsi; Meet needs a signed-in profile or a managed bot (E).

## 6. Target architecture (option B)

```
room audio --(WebAudio worklet, 20 ms frames)--> VAD + AGC/NS
                   |                                   |
                   | partial frames                     | speech start
                   v                                   v
        streaming ASR (WebSocket)  <----  barge-in: cancel TTS
                   | partial + final
                   v
        end-of-turn detector (VAD + semantic)
                   |
                   v
        LLM stream (tokens) --> sentence chunker --> streaming TTS
                   |                                   |
                   | short/fast lane                    | audio frames
                   v                                   v
        (background tasks in a worker session)   page mic -> room
```

Latency budget per turn: VAD 100-200 ms + EOT 200-300 ms + ASR final 150-300 ms +
LLM first token 300-700 ms + TTS first audio 200-350 ms = **1.0-1.8 s**.

## 7. Real steps

**Step 0 — measure (1 ticket).** Per-stage timings from audio frame to first
response audio, logged as `{ vadMs, asrMs, llmFirstTokenMs, ttsFirstAudioMs,
totalMs }`; a small replay corpus of the operator's recordings with reference
transcripts and WER. Without this, every later change is a guess.

**Step 1 — turn-taking and barge-in (1-2 tickets).** Replace the fixed gate with
Silero VAD (ONNX in a WebAudio worklet or the existing page hook), end-of-turn
after 300-500 ms of silence plus a semantic check, and real barge-in: VAD speech
start cancels the TTS queue and keeps the ASR open. Keep a "still working" cue for
long tasks. Acceptance: the operator can interrupt mid-answer; a pause mid-sentence
does not split it; room tone does not open a turn.

**Step 2 — streaming ASR (1-2 tickets).** WebSocket to Deepgram Flux Multilingual
or ElevenLabs Scribe v2 Realtime (both handle language switching; verify Ukrainian
on our corpus). Send 20 ms frames, receive partials for the UI/state, and a final at
end-of-turn. Keep OpenAI batch as a fallback. Acceptance: WER on the replay corpus
and first-partial latency <300 ms.

**Step 3 — streaming TTS (1-2 tickets).** ElevenLabs Flash v2.5 WebSocket (or Azure
streaming) fed sentence by sentence as the LLM streams; start audio on the first
sentence. Language per sentence: Ukrainian sentences to the uk voice, English
sentences/names to an English voice (or a multilingual model with `lang` tags).
Acceptance: first audio <500 ms after the first sentence; no audible clip seams.

**Step 4 — fast lane and background work (1-2 tickets).** Short answers in the
meeting lane, long work in a worker session, filler ("дивлюся…") while the worker
runs, and a single voice session per meeting with streamed tokens. Acceptance: the
room hears a response within 2 s for a short question even while a long task runs.

**Step 5 — pronunciation and code-switching (ongoing).** A lexicon for names with
stressed forms, per-segment `lang` for Azure SSML, and a small evaluation set of the
operator's phrases (names, numbers, mixed English). Acceptance: the operator's top
20 terms are pronounced correctly.

**Step 6 — observability and fallbacks.** Dashboard for the latency budget and WER,
provider fallback (streaming primary, batch fallback), and an alert when the turn
budget is exceeded.

## 8. Cost sketch (30-minute meeting, ~15 minutes of speech)

| Item | Option B | Option C |
|---|---|---|
| ASR | Flux/Nova-3 streaming ~$0.3-0.7 | same |
| TTS | Flash v2.5 ~$0.3-0.6 (15 min ≈ 12k chars) | same |
| Infrastructure | existing PC + browser | + a Python service (same PC) |
| Meeting join | browser (free) | browser or managed bot ($0.25) |

## 9. What not to change

- The **browser as the meeting transport** is right for Jitsi and remains the only
  anonymous path for Meet. The streaming upgrade lives inside that page.
- **Text stays in Signal**; the meeting is a spoken console, and permissions stay
  typed. Streaming must not turn voice into a command channel.
- **The link stays a credential**; no provider account in the connector.

## 10. Sources

- Pipecat docs and benchmarks: https://docs.pipecat.ai/ , https://www.pipecat.ai/benchmarks
- LiveKit Agents: https://github.com/livekit/agents
- Deepgram Flux/Nova-3 and ElevenLabs Scribe v2 Realtime latency figures: Coval's
  2026 STT comparison and vendor docs.
- ElevenLabs Flash v2.5 (~75 ms model, ~350 ms measured, 32 languages incl. uk):
  https://elevenlabs.io/docs/overview/models
- Recall.ai meeting bot: https://github.com/recallai/meeting-bot ,
  https://www.recall.ai/
- Attendee / Vexa self-hosted bots: Forasoft's 2026 meeting-bot API comparison.
- Google Meet Media API status (closed preview) and Zoom RTMS: same comparison.

## 11. Implementation status (updated 2026-10-24)

Shipped from this plan, with tests, without changing the meeting transport:

- **Step 0, metrics.** Every recognised utterance logs `voice: transcribed` with
  `asrMs`, `speechMs` and `chars`; every clip logs `voice: spoke a clip` with
  `chars`, `synthMs` and `playMs`. A turn's cost can now be attributed instead of
  guessed.
- **Step 3, partial.** An answer is planned into sentences, and inside a
  sentence into Ukrainian and Latin runs (`planSpeech`). With Azure, Ukrainian
  runs go to `azureVoice` and English runs to `azureVoiceEnglish`
  (`en-US-JennyNeural` by default), so a product name is read by an English
  voice rather than transliterated; the first sentence is spoken while the rest
  is still being made. With one voice, `voice.pronunciations` still applies.
- **Step 4, partial.** A voice task with no answer within `workingCueMs`
  (default 8 s) says `workingCue` ("Ще працюю.") once; the answer, a failure or
  the end of the meeting clears it.
- **Recognition vocabulary.** `transcriptionPrompt` sends a name list to the
  OpenAI-compatible recogniser, so "SignalConnector"/"opencode" are spelled as
  typed instead of as heard.

Still open, in the order of value:

1. **Streaming ASR with end-of-turn and partials** — replace the per-utterance
   WAV POST with a WebSocket (Deepgram Flux / ElevenLabs Scribe v2 Realtime),
   keeping the batch call as fallback. This is the largest remaining latency
   term (about 1.5 s) and the fix for fragments.
2. **True token streaming into TTS** — the agent's answer arrives as one
   summary today, so the first sentence waits for the whole answer. Streaming
   the agent's text events into the sentence planner removes that wait.
3. **Barge-in with echo cancellation** — re-enable it only with a proper VAD and
   AEC, not an energy threshold; today it is off in the live config because it
   cut answers.
4. **Adaptive noise floor** — a quiet microphone can sit below `rmsFloor`; an
   EMA-based floor would hear it without raising false turns in a noisy room.

