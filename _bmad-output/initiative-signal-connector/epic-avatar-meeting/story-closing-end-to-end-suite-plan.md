---
title: 'Closing end-to-end suite'
type: 'feature'
ticket: '8'
created: '2026-10-19'
status: 'built'
baseline_revision: '56657e1b3b1cedd052524f3045f861c0b109d750'
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

**Problem:** the meeting epic's guarantees live in scattered unit tests, so a regression can pass
every file's suite while breaking the paste-to-summary path, the deaf alarm or the one-outcome
rule. The epic needs one suite that fails if any Done-when check regresses.

**Approach:** one `meeting.e2e.test.ts` drives `CoreApp` through the whole epic with the existing
Signal, agent, meeting and voice fakes: every gate refusal, a guest join, a spoken question
answered and spoken, a spoken approval refused while a typed one is obeyed, listen-only, the
deaf alarm, the watchdog close, and `/meet stop` with one summary, a wiped link and no link in
any message or log. The real gate and face suites run in the same closing verification.

## Boundaries & Constraints

**Always:** only the transport, agent, browser, probe and voice are fakes — core and store are
real; every Done-when check is asserted on operator output, stored state or a reopened database;
the link appears in no message, refusal, log line or closed row; the temp directory and database
are removed after the suite; the closing run executes the e2e, gate and face suites.

**Never:** no production code change unless the suite exposes a real defect; no live Signal,
opencode, browser, whisper, SAPI or network call; no weakening of existing unit tests to fit the
suite; no new dependency.

**Decisions:** the e2e uses `FakeVoice` and a `probeRoom` that resolves true; the energy gate and
the three-colour face remain covered by their own suites, and a regression there fails the same
full run. The live smoke run is the plan's manual checklist — no new script.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Gate refusals | Each `RefusalCategory`, then a slot already open | Each named refusal, no claim, no join | The link is never echoed |
| Guest join | Allowed paste, then admission | Joining notice, in-room message, voice listening | — |
| Spoken question | `FakeVoice.utterance(text)` | One `heard:`, a task in the pinned session, the permission announced aloud | — |
| Spoken approval | "approve" while that task's permission waits | `heard:` only; no agent decision | Group says decisions are typed |
| Typed approval | `approve` in the project group | The agent receives the decision | — |
| Spoken stop | "/meet stop" or "stop" heard | Passed to the agent as text; the meeting stays open | Never a command |
| Second human | Telemetry `humans: 2` | Listen-only posted once, speech stopped, later answers unspoken | A dropped count does not re-enable |
| Deaf room | Telemetry silent past the budget | One alarm and a health key | Re-armed only by audio |
| Stop | `/meet stop` | One summary, row closed, link null in the reopened DB | — |
| Stale meeting | No telemetry past the window, then a late `die()` | One watchdog outcome; the late report adds none | — |

</frozen-after-approval>

## Code Map

- `src/core/notify.e2e.test.ts` — the end-to-end shape; `app.test.ts` (18-49, 95-130) — the
  `makeApp` wiring, `probeRoom`, and how a message reaches a project group.
- `src/core/app.test.ts` (861+) — the meeting/voice messages the suite asserts; (878) the probe
  injection; (1251-1266) the link-check logger; (2225-2254) the watchdog close.
- `src/adapters/fakes/fakeMeeting.ts` — `admit`, `telemetry`, `die`, `leave`; `fakeVoice.ts` —
  `started`, `utterance`, `drop`, `spoken`, `stoppedSpeaking`.
- `src/adapters/fakes/fakeSignal.ts` / `fakeAgent.ts` — sent messages, edits, `started`,
  `decisions`, `emit`.
- `src/store/store.ts` (46-56, 93-102) and `store.test.ts` (15-30) — the meetings table, the
  wiped `link`, and the `DatabaseSync` reopen that proves it.
- `src/core/gate.ts` (28-33) — the closed refusal set the table drives; `src/config/config.ts` —
  the budgets, set explicitly.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/meeting.e2e.test.ts` — harness: temp-file store, both fakes, real voice fake,
      `probeRoom: true`, `CapturingLogger`, manual clock — the foundation every case shares.
- [x] `src/core/meeting.e2e.test.ts` — a table over every `RefusalCategory` plus the open slot,
      asserting the refusal, no claim and no join — Done-when 4.
- [x] `src/core/meeting.e2e.test.ts` — one meeting: join, speak, permission announced, spoken
      approval refused, typed approval obeyed, answer posted and spoken — Done-when 1-3.
- [x] `src/core/meeting.e2e.test.ts` — listen-only and spoken stop — Done-when 3.
- [x] `src/core/meeting.e2e.test.ts` — deaf alarm and the watchdog with a late `die()` — Done-when
      5-6.
- [x] `src/core/meeting.e2e.test.ts` — `/meet stop`: one summary, reopened DB link null, and no
      link in any message or log line — Done-when 1, 4, 6.
- [x] Run the closing verification and fix a real defect only if the suite proves one.

**Acceptance Criteria:**
- Given each refusal category and a slot already open, when the paste arrives, then its named
  refusal is posted, no meeting is claimed and no browser joins.
- Given an allowed paste and admission, then the group shows the join and in-room notices and
  the voice port is listening.
- Given a spoken question with a permission waiting on that live task, then the permission is
  announced aloud, `heard:` is posted, the agent starts in the pinned session, a spoken
  "approve" changes nothing, and a typed `approve` reaches the agent; the answer is posted and
  spoken.
- Given "/meet stop" or "stop" spoken, then it reaches the agent as text and the meeting stays
  open.
- Given a second human, then listen-only is posted once, speech stops and no later answer is
  spoken.
- Given a silent room past the budget, then one alarm is posted and `health:meeting` is set.
- Given `/meet stop`, then the browser leaves, exactly one summary is posted, the row is closed
  with a null link, and the link appears in no sent message or log line.
- Given a stale admitted meeting, then the watchdog posts one outcome and a late adapter report
  adds none.
- Given the closing `npm test`, then this file, the gate suite and the face suite all run.

## Implementation Notes

- `src/core/meeting.e2e.test.ts` is one suite on a temp-file SQLite store: `CoreApp` and
  `openStore` are real; only `FakeSignal`, `FakeAgent`, `FakeMeeting`, `FakeVoice` and the
  injected `probeRoom` stand in for the boundaries. A manual `now()` clock makes the silence
  budget and the activity window deterministic, and `afterEach` closes the store and removes
  the temp directory.
- The refusal table covers each `RefusalCategory` (`no-identities`, `not-authorised`,
  `malformed-link`, `foreign-provider`, `unreachable-room`) plus an already-open slot. Each
  row asserts the named refusal, `availableCalls === 0`, no join, no claim (or the unchanged
  holder) and that neither the messages nor the log carry the room.
- The full-meeting case walks join → admission → listening, a typed task's permission
  announced aloud, a spoken question in the pinned session, a spoken `approve` that decides
  nothing, a typed `approve` that reaches the agent, and the answer posted and spoken. The
  remaining cases cover listen-only with a dropped count, spoken `/meet stop` and `stop` as
  prompts, one deaf alarm per spell re-armed by audio, the watchdog with a late state report,
  and `/meet stop` with one summary and a null link read back through a fresh `DatabaseSync`.
- The matrix audit added `FakeMeeting.lateState`: the fake retains the join handler after leave,
  so the suite can prove the core ignores a report from an adapter that should already be gone.
- Review added the voice-teardown assertions on both terminal paths and a probe counter per
  refusal; the no-op late telemetry step was removed rather than left as false coverage.
- No production code changed: the suite proved no defect.
- Verification after the suite: typecheck exit 0, 399 tests in 30 files pass (including the
  new e2e, gate and face suites), build exit 0.

## Plan Change Log

## Review Triage Log

## Design Notes

- **Fakes at the boundary, real core and store inside:** the voice fake hands core a gated
  transcript; the gate's maths and the face's three states stay in their unit suites.
- **Refusals are a table:** the closed set is small and each row shows the failure before
  anything joins, so a new category cannot slip in unproven.
- **Credential wipe is read back:** an in-memory store cannot distinguish a wiped link from a
  hidden row, so the close case uses a temp file and reopens it.

## Review Triage Log

Quick lens, 6 findings; each verified against the code and the suite.

- **The late telemetry step is a no-op** — `low`, patch. Verified: `FakeMeeting.leave()` clears
  the telemetry handler, so the call never reached `onTelemetry`; the step was removed and the
  late-report check now uses `lateState`, which does reach the guard.
- **Voice teardown is not asserted on a terminal path** — `medium`, patch. Verified: deleting
  `handle.stop()` from `stopListening` left the suite green. Both the watchdog and `/meet stop`
  now assert `voice.stoppedSpeaking` and `voice.stops`.
- **The probe is not instrumented** — `low`, patch. Verified: only availability and joins were
  counted, so a regression that probes before refusing an open slot would pass. The harness now
  counts probes and each refusal case states how many it may spend (only the unreachable row
  spends one).
- **The core test imports adapter fakes** — `false`. The AD-1 rule governs `src/core/` source
  that ships; `app.test.ts` and `notify.e2e.test.ts` already import the same fakes, and the test
  graph is not part of the runtime. No architecture violation occurs.
- **`npm run typecheck` excludes test files** — `low`, rejected. The project tsconfig excludes
  `src/**/*.test.ts`; the new file was separately type-checked clean, and adding a repo-wide
  test tsconfig is a broader change than this suite. The finding's only in-scope fix would edit
  the plan.
- **The frozen row names a late `die()` but the suite uses `lateState`** — `false`. `die()`
  refuses after leave by design; `lateState` delivers the same `left` event through the retained
  handler, which is exactly the input the row describes. The covered behavior is identical.

## Verification

**Commands:**
- `npm run typecheck` — expected: exits 0
- `npm test` — expected: all suites pass, including the new e2e, gate and face suites
- `npm run build` — expected: exits 0

**Manual checks:**
- Create a Jitsi room by hand with knocking on, paste its link into a project's group with
  `/meet`, admit the avatar, confirm its three-colour face changes while a task runs, ask a
  question aloud, hear the answer, then `/meet stop` and confirm one summary and no link.
- Mute the microphone while admitted and confirm one deaf alarm; have a second person join and
  confirm the group says listen-only and the avatar goes silent.
