---
title: 'Announce permissions aloud, decide by text'
type: 'feature'
ticket: '5'
created: '2026-10-17'
status: 'built'
baseline_revision: 'da0e1102eaa63a9c4e86cf47b27ef201ca43c05e'
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

**Problem:** a permission can be announced only as Signal text, so an operator who asked a question
out loud hears nothing about the block while the agent waits. Worse, the room can say "approve" —
and although it can never decide a permission, it currently becomes a task whose prompt is the word
"approve", which is confusing and looks like a decision.

**Approach:** when a permission starts waiting, the announcement the group already receives is also
spoken into the room through the meeting's voice handle — fire-and-forget, never awaited. In
`onHeard`, a transcript that parses as an approval **while a permission is actually pending** is not
run as a task: the transcript is still posted as `heard:`, the avatar says aloud that permissions
are decided by typing in Signal, and a short group note repeats it. With nothing pending, the same
words stay an ordinary prompt, so normal speech is never blocked.

## Boundaries & Constraints

**Always:** the typed Signal path remains the only way to decide a permission; the room is told the
tool and the description and that the decision is typed; a spoken approval with a permission
pending changes no permission, aborts nothing and starts no task; every transcript is still posted
as `heard:` before anything else happens; speech is never awaited on the serial handler chain.

**Never:** no new port, config key or dependency; no spoken approval, denial or "always"; no
suppression of the group prompt; no refusal of ordinary speech when no permission waits; no
speaking when no meeting is hearing that project.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Behavior | Error Handling |
|----------|--------------|-------------------|----------------|
| Permission during a meeting | Permission event, voice handle live | Group prompt posted; the same news spoken in the room | Speech failure logged, meeting keeps running |
| Spoken approval, permission pending | `approve` / `yes` / `always` transcript | `heard:` posted, spoken refusal, group note; no task, no decision | — |
| Spoken approval, nothing pending | `yes` transcript | Ordinary prompt, exactly as today | — |
| Permission for another project | Another project's meeting is live | Nothing spoken into it | — |
| Long description | Very long permission description | Spoken text capped so it stays short | Truncated, group prompt keeps the full text |
| Meeting ending | Stop or terminal state while speech queues | Nothing spoken after the meeting closes | — |
| No voice available | Voice handle absent | Group prompt only, no error | — |

</frozen-after-approval>

## Code Map

- `src/core/app.ts` -- `handlePermission` (1394-1426) already posts the prompt at 1413-1416 and
  records the pending entry; `onHeard` (893-906) posts `heard:` and calls `runTask`; `parseInput`
  is already imported (line 37); `ActiveMeeting.voice` (102) and `speakOutcome` (940-...) show how
  speech is fire-and-forget today. Add a small `speakInMeeting(projectId, text)` helper and use it
  from both places.
- `src/core/router.ts` -- `parseInput` (68-86) and `APPROVAL_DECISIONS` (12-32): approval phrases
  are exact matches after trimming and a trailing `.!`, so "approve the PR" is a prompt.
- `src/core/app.test.ts` -- the meeting voice suite (1494-...) with `FakeVoice` and `inRoom()`;
  the existing spoken-approval test at 1562-1586 asserts today's "it becomes a task" behaviour and
  must be rewritten to the new refusal. `makeApp` (18-49) already takes a `VoicePort`.

## Tasks & Acceptance

**Execution:**
- [ ] `src/core/app.ts` -- add `speakInMeeting(projectId, text)`: finds the live meeting hearing
  that project, caps the spoken text, calls `handle.speak` without awaiting and logs a failure;
  speak the waiting permission's news from `handlePermission` after `setPending`.
- [ ] `src/core/app.ts` -- in `onHeard`, when `parseInput(text).kind === "approval"` and
  `pending(channel).length > 0`, post `heard:`, speak the refusal, post one group note naming the
  typed decision, and return without `runTask`. Otherwise unchanged.
- [ ] `src/core/app.test.ts` -- a permission during a meeting is spoken (tool and description) and
  the group prompt is unchanged; a spoken approval with a permission pending decides nothing,
  starts nothing, is spoken and is explained in the group; a spoken "yes" with nothing pending is
  still a prompt; a held speech clip does not delay the permission prompt or the next event.
- [ ] `README.md` -- one line beside the meeting notes: permissions are announced aloud but decided
  by typing in Signal.

**Acceptance Criteria:**
- Given a permission waiting while a meeting is live, then the group prompt appears and the room
  hears what is needed and that the decision is typed.
- Given a permission waiting, when the room says "approve", then no permission is answered, no task
  starts, `heard:` is posted, and the refusal is both spoken and explained in the group.
- Given no permission waiting, when the room says "yes", then an ordinary task starts with that
  prompt.
- Given speech is slow or held, then the permission prompt and the event chain still proceed.
- Given a meeting for another project, then no speech goes into it.

## Implementation Notes

## Plan Change Log

## Review Triage Log

Quick lens, 3 findings; each verified against the code. All real, all patches — no intent gap,
no plan fault, nothing deferred.

- **A long description truncates the instruction away** — `medium`, patch. Verified: the whole
  announcement is composed and then capped, so a description near the cap consumes the budget and
  the trailing "decide by typing" is lost — exactly the "Long description" row. Fix: reserve the
  budget for the head and the instruction and cap only the description; assert the instruction
  survives in the long-description test.
- **A stale pending entry refuses ordinary speech forever** — `high`, patch. Verified: `pending`
  is written by `handlePermission` and cleared only by `resolveApproval`; `stopTask` and the
  idle/error branches never clear it, the row lives in SQLite and survives restarts, and a rejected
  permission cannot clear it by typing either. Fix: prune a task's pending entries on every
  terminal path, and when deciding whether a spoken approval is refused, require that the
  permission's task is still `started` or `running`, persisting the pruned list.
- **Capping is duplicated in core and the adapter** — `low`, patch. Verified: the voice port says
  the adapter caps; `speakInMeeting` now caps too, so two truncations of the same text must be kept
  in sync. Fix: keep one final cap (the adapter's) and use the core helper only to fit the
  description into its reserved budget.

## Design Notes

- **Why refuse only while a permission waits:** the dangerous reading of "approve" exists only
  when something can be approved; without a pending item the same word is ordinary speech, and
  refusing it would block legitimate prompts.
- **Why re-post a group note:** the rule is that the room never decides, so the refusal has to be
  visible in the record and not only in the air.
- **Why `speakInMeeting` is fire-and-forget:** story 7.4's review proved that awaiting synthesis on
  the serial chain blocks `/meet stop`, approvals and every later event.
- **Why no port change:** speaking already exists on `VoiceHandle`; this story only decides what to
  say and when not to act.

## Verification

**Commands:**
- `npm run typecheck` -- expected: exits 0
- `npm test` -- expected: all suites pass, including the new permission-voice tests
- `npm run build` -- expected: exits 0

**Manual checks:**
- In a room, trigger a permission: it is announced aloud and the group shows the prompt; type
  `approve` in Signal and the agent continues.
- Say "approve" aloud while it waits: it is refused aloud, the group explains, and nothing runs.
