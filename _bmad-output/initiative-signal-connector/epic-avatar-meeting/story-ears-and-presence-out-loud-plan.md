---
title: 'Ears and presence, out loud'
type: 'feature'
ticket: '6'
created: '2026-10-19'
status: done
baseline_revision: '96106ad68798a5baa5be00ddf43c5bfbe8fa53d3'
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

**Problem:** the avatar can hear and speak, but nothing tells the operator when the room has
gone deaf or who is present. A second human is not noticed, and a stored active meeting can
linger with no terminal outcome.

**Approach:** the page reports remote-audio state and participant presence as plain telemetry
on the join callback the adapter already owns. Core posts the deaf alarm and presence in the
group, degrades to listen-only on a second human, and a watchdog closes an admitted meeting
that outlives the activity window with one posted failure and a health signal.

## Boundaries & Constraints

**Always:** presence is advisory — someone here, nobody visible, or the named presence unknown —
never an identity, a block, an approval or a gate input; the deaf alarm fires once per silence
spell and re-arms when audible audio returns; a second human makes the avatar listen-only and
the group is told once; every terminal path closes the row, wipes the link and posts exactly one
outcome; the link never appears in telemetry output; core keeps no browser, audio or provider
import (spine AD-1).

**Never:** no provider server API or OAuth; no new port, transport or protocol — telemetry rides
the existing `JoinMeetingInput` callback; no machine microphone or camera; no speech while
listen-only; no rejoin; no listening after the meeting ends.

**Decisions:** presence comes from Jitsi's in-page `APP.conference.listMembers()` and is
`unknown` everywhere else; the health signal is `health:meeting` in the store kv plus an error
log, with the group post as the operator surface; listen-only keeps hearing and posting
`heard:` but permanently stops speech for that meeting; the deaf alarm fires on silence
regardless of the presence outcome.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Muted room | Admitted, no audible audio and no track change for the silence budget | One deaf-alarm post by the next poll, plus a health signal | Repeated silence does not repost; audio re-arms |
| Audio returns | Audible RMS after an alarm | Alarm clears; a later silence alarms again | — |
| Second human | Presence count reaches two other humans | Avatar stops speaking and the group is told once it is listen-only | A count that drops does not re-enable speech |
| Presence unknown | The page cannot enumerate participants | The named `presence unknown` state is reported; no listen-only decision | Never guessed from audio |
| Admitted row is stale | No telemetry past the activity window | One failed terminal outcome, row closed, health signal | Exactly one outcome even if the adapter reports later |

</frozen-after-approval>

## Code Map

- `src/adapters/meeting/avatarScript.ts` — `hearing` (279) holds `active` and `level`;
  `attachRoomAudio` (328) is the only attach/detach point. Bump an epoch there and on `mute`
  changes; add `presence()` beside `hearing()` (433) using Jitsi's in-page
  `APP.conference.listMembers()` when present, else unknown. Export `PRESENCE_EXPRESSION` and
  `AUDIO_STATE_EXPRESSION` beside `LIVENESS_EXPRESSION` (457); neither drains PCM.
- `src/core/ports.ts` — `JoinMeetingInput` (114) gains `onTelemetry?`; add `MeetingPresence`
  and `MeetingTelemetry` beside `MeetingStateEvent` (103). No new port.
- `src/adapters/meeting/browserMeeting.ts` — `poll()` (326) runs every second; add a telemetry
  read gated to `telemetryMs` and only while `inRoom`. Emit
  `{ presence, humans?, audioLive, level, audioEpoch, at }`. It never ends the meeting.
- `src/core/app.ts` — `ActiveMeeting` (106) gains `lastTelemetryAt`, `lastEpochAt`, `deaf`,
  `presence`, `listenOnly`; add `onTelemetry`, a presence line in `inRoomText` (849), and
  early returns in `speakInMeeting` (973) / `speakOutcome` (992) when listen-only. Core compares
  `level` against `config.voice.rmsFloor`; an epoch change also resets the silence clock. A
  watchdog interval starts in `start()` (187), is cleared in `stop()` (212) and checked only for
  admitted meetings, so the 90 s admission budget is untouched. `raiseHealth(reason)` writes
  `health:meeting` to the store kv and logs at error. `finishMeeting` (1023) remains the only
  terminal path.
- `src/config/config.ts` — top-level `meeting` beside `voice` (57): `silenceBudgetMs` (5000),
  `activityWindowMs` (30_000), `telemetryMs` (5000).
- `src/index.ts` — pass the telemetry cadence to `BrowserMeeting` (123).
- `src/adapters/fakes/fakeMeeting.ts` — a `telemetry()` helper beside `admit()` (80).
- Tests: `src/core/app.test.ts` meeting/voice suites (861+), `avatarScript.test.ts` with a stub
  `window.APP`, and `src/config/config.test.ts`.

## Tasks & Acceptance

**Execution:**
- [ ] `src/core/ports.ts` — presence and telemetry shapes, join callback — plain data only.
- [ ] `src/adapters/meeting/avatarScript.ts` — audio epoch, presence reader, expressions — the
      page alone sees participants and track state.
- [ ] `src/adapters/meeting/browserMeeting.ts` — five-second telemetry read while in the room.
- [ ] `src/core/app.ts` — alarm, presence, listen-only, watchdog, health write.
- [ ] `src/config/config.ts`, `src/index.ts` — the three settings and their wiring.
- [ ] Fakes and tests — alarm and re-arm, presence outcomes, second human, watchdog, health.

**Acceptance Criteria:**
- Given an admitted meeting with no audible audio and no track change for the silence budget,
  when the next telemetry report arrives, then one deaf-alarm message is posted and
  `health:meeting` holds the reason.
- Given audio resumes and then stops again, when the budget passes, then the alarm is posted
  a second time.
- Given the page reports someone, nobody or unknown, then the meeting message says exactly
  that and names no identity.
- Given a second human is present, then the avatar stops speaking, no later answer is spoken,
  and the group is told once.
- Given an admitted meeting whose last telemetry is older than the activity window, then the
  row closes with one posted failure and a health signal.

## Implementation Notes

- Telemetry rides `JoinMeetingInput.onTelemetry`; no new port. The page's audio read is
  peak-since-last-read, and the first reading only establishes the epoch baseline.
- The silence clock restarts on a track change, but the alarm is re-armed only by audible
  audio; `health:meeting` is cleared on recovery and on a clean terminal outcome.
- The watchdog is injectable (`CoreDeps.watchdogMs`) purely so tests need no fake timers;
  production follows the telemetry cadence.
- Live Jitsi checks (muted microphone, second human) are still manual; this environment has
  no room, browser session or room audio.

## Plan Change Log

## Review Triage Log

Quick lens, 11 findings; each verified against the code.

| # | Finding | Verdict | Route | Evidence |
|---|---------|---------|-------|----------|
| 1 | An audio-epoch change clears the deaf alarm, so mute/unmute or a failed read re-posts the same silence | medium | patch | `app.ts` sets `deaf = false` in the same branch that resets `lastEpochAt`; the frozen boundary re-arms on audible audio only. A failed `evaluate` also reports epoch 0, which reads as a change. |
| 2 | The first telemetry reading always looks like a change, delaying the first alarm one cadence | medium | patch | `audioEpoch` starts at `-1` and the page's first epoch is `0` or more, so `lastEpochAt` is reset at the first report; with 5 s defaults the alarm lands at ~10 s, not the spec's 5 s. |
| 3 | The silence budget is judged from one ~85 ms RMS sample per cadence, so speech between polls is invisible | medium | patch | `avatarScript.ts` overwrites `hearing.level` on every audio block; `readTelemetry` samples it once per 5 s. The spec asks for zero amplitude across the budget. |
| 4 | `health:meeting` is write-only and never clears | medium | patch | `raiseHealth` is the only writer; audible recovery clears only the in-memory flag and `finishMeeting` never touches the key, so a recovered or cleanly ended meeting still reads as unhealthy. |
| 5 | The `onTelemetry` doc calls the callback optional, but the watchdog closes a meeting that omits it | low | patch | The port comment promises "no deaf alarm"; `checkMeetingActivity` only checks `inRoom`, so an adapter taking the doc at its word is terminated after the activity window. |
| 6 | Listen-only latches before a send that can fail, leaving the group uninformed | medium | patch | `active.listenOnly = true` precedes `sendProject`; a rejected send is logged by the queue and the guard returns early on every later report, so the "told once" promise is never met. |
| 7 | `audioLive` is true forever once the hook exists | low | patch | `hearing.active` is set at processor creation and never cleared; detached sources leave it true. Core ignores the field today, but the port document is wrong. |
| 8 | The late-adapter-report test does not exercise the late report | low | rejected | `FakeMeeting.leave()` clears the handler, so the calls after the watchdog are no-ops. The `finished` guard is already exercised by existing terminal tests, and a fake that reports after leave would model a state the adapter cannot reach. |
| 9 | The adapter's own telemetry emission is untested | low | rejected | `presenceFrom` / `audioStateFrom` are tested; exercising `poll` would need a CDP fake for a 5 s cadence gate, which is more than a direct correction and unlikely to be met day to day. |
| 10 | No cross-field check on the meeting budgets | medium | patch | `telemetryMs >= activityWindowMs` closes every admitted meeting before its first report; both fields are independently positive-only. |
| 11 | The new `[meeting]` table is absent from the reference config and README | low | patch | `scripts/config.example.toml` lists every other user-facing table, including `[voice]`, and the README calls it the reference config. |


## Design Notes

- **Telemetry, not policy, at the port:** the adapter knows whether audio moved; core owns the
  budgets and the group, so the guard stays fake-testable.
- **Presence is deliberately weak:** an unreadable list is `unknown`, never guessed from audio.
- **Listen-only means silent, not deaf:** `heard:` transcripts still reach the group.
- **The watchdog closes through `finishMeeting`,** preserving the one-outcome invariant.

## Verification

**Commands:**
- `npm run typecheck` — expected: exits 0
- `npm test` — expected: all suites pass, including the new telemetry cases
- `npm run build` — expected: exits 0

**Manual checks:**
- Admit the avatar in Jitsi, mute the operator's microphone, expect one group alarm in about
  five seconds; unmute and mute again for a second alarm.
- A second person joining: the group says listen-only and the avatar stays silent.
