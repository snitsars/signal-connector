---
title: 'Join a room as the avatar'
type: 'feature'
ticket: '1'
created: '2026-10-17'
status: done
baseline_revision: '5456ea39c555798af4c9af708852555ff2471c0d'
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

**Problem:** The connector is reachable only by typing. This story proves the spoken path can
exist at all by putting a drawn face into a meeting room as an anonymous guest: three unknowns
can kill the epic — driving a real browser, publishing a canvas as the camera, and anonymous
admission — and no meeting code exists yet.

**Approach:** A `MeetingPort` in core and one adapter behind it that launches the installed
Chrome (Edge as fallback) with a dedicated incognito profile and a debugging port, drives it
over the DevTools Protocol with the `ws` dependency already present, injects a script that
publishes a canvas face as the room's camera, and returns a handle that leaves. `/meet <link>`
claims one meeting row, edits one message through the lifecycle, joins; `/meet stop` leaves and
posts one summary.

## Boundaries & Constraints

**Always:** one meeting at a time, enforced by a store constraint; the link lives only in the
meeting row and never in a log line, a refusal or a group message; the browser uses its own
profile under the data dir, never the operator's; `src/core/` gains no browser or audio import;
every ending closes the row, wipes the link and says why in the project's group; the admit
budget is **90 s**; the closing summary reports the **duration and outcome only**.

**Never:** no room creation, provider API, OAuth or credentials; no audio capture or synthesis;
no rejoin after a restart; no new runtime dependency for browser control; no touching the
operator's Chrome or Edge profile; no logging of the link, room id or debugging port.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Behavior | Error Handling |
|----------|--------------|-------------------|----------------|
| Happy path | `/meet <link>` in a project group, no open meeting, Chrome present | One editable meeting message within 2 s, a claimed row, a window on the room, the face visible once admitted; `/meet stop` leaves, closes the row, posts one summary | None |
| Linked twice | `/meet <link>` while a meeting is open | Refusal naming the holding project and its start time; nothing opens | The second claim fails on the store's uniqueness, not a read-then-write |
| Empty or stop-with-nothing | `/meet`, or `/meet stop` with no meeting | Usage, or "no meeting is running" | No row written |
| Not admitted | Nobody admits the avatar | At 90 s: leave, close the row, wipe the link, post the reason | One terminal outcome, never silence |
| No browser | Neither Chrome nor Edge found | Refusal before any row is claimed | Not a crash |
| Room or browser ends by itself | The page leaves the call, or the process exits | Same terminal path, one summary | Idempotent; a later stop only says it is over |
| Stale row at startup | A meeting row left open by a previous process | Close it, say so in that project's group | The slot is never locked for good |
| Browser survives leave | The process tree outlives `Browser.close` | Force-kill by process id; if it survives, say the room may be open | Surfaced, never swallowed |
| Face stops publishing | The liveness flag goes false | Report "in the room, face not publishing" | Checked, not assumed |

</frozen-after-approval>

## Code Map

- `src/core/ports.ts` -- add `MeetingPort`: `available()`, `join({ projectId, projectName, link, onState })` → a handle with `leave()`; state union `joining | in-room | left | failed` (beside `SignalPort`/`LauncherPort`, 32-114).
- `src/core/router.ts` -- `KNOWN_COMMANDS` (36-48) gains `meet`; `HELP_TEXT` (50-63) gains the two lines; the command regex (68) already accepts it.
- `src/core/app.ts` -- `dispatchCommand` switch (178-225) gains `meet`; reuse `sendProject` (609-620), `channelFor` (241-243), the notice pattern (567-570), `editStatus` (585-595) for the in-place message, `summaryText` (`src/core/progress.ts` 70-81), and sequence like `startProjectWindow` (314-337) / `runTask` (353-378). Startup reconciliation belongs next to `app.start()`.
- `src/store/store.ts` -- schema is applied with `CREATE TABLE IF NOT EXISTS` on every open (93-96), so a new table needs no migration; copy the upsert shape from `setSession` (115-120), extend the interface (47-72) and the object (98-216).
- `src/adapters/meeting/` -- new: `chromeFinder.ts`, `cdp.ts`, `avatarScript.ts`, `browserMeeting.ts` (details in the tasks below).
- `src/adapters/fakes/fakeMeeting.ts` -- beside `fakeSignal.ts`/`fakeAgent.ts`.
- `src/index.ts` -- build the adapter like `ProjectLaunchers` (112-119) and stop it in shutdown (134-143).
- `src/adapters/signal/daemon.ts` (128-166) -- the model for a kept, stoppable child; `src/adapters/spawnCommand.ts` (18-31) resolves the Windows invocation.

## Tasks & Acceptance

**Execution:**
- [ ] `src/core/ports.ts` -- declare `MeetingPort` and its state union; the port takes ids and names, never `Project` or browser types -- keeps core browser-free.
- [ ] `src/store/store.ts` -- `meetings` table (`project_id`, `link`, `started_at`, `closed_at`, `outcome`) with a partial unique index on the open row; `claimMeeting`, `getOpenMeeting`, `closeMeeting` (nulls the link), `closeOpenMeetings` (startup reconciliation) -- the one-meeting rule and the wipe become single writes.
- [ ] `src/adapters/meeting/chromeFinder.ts` -- probe Chrome then Edge at their standard paths; return the first or a reason -- pure and testable.
- [ ] `src/adapters/meeting/avatarScript.ts` -- the injected script: a canvas face (head, eyes, mouth) that repaints on `setState(state)` in the connector's colours, **no animation loop** (a covered window is throttled), a published **liveness flag**, and an override publishing `canvas.captureStream()` as the camera.
- [ ] `src/adapters/meeting/cdp.ts` -- DevTools Protocol over `ws`: read the port from the profile's `DevToolsActivePort` file, attach the page target, `Page.addScriptToEvaluateOnNewDocument`, `Runtime.evaluate`, navigation and target-loss events -- no new dependency, no guessed port.
- [ ] `src/adapters/meeting/browserMeeting.ts` -- spawn with a dedicated `--user-data-dir` under the data dir, `--remote-debugging-port=0`, `--incognito`, and the room URL; inject; pre-fill the guest name with the project's name; probe the face's liveness; report `joining`, `in-room`, `left`; `leave()` = `Browser.close`, wait, force-kill the process tree if needed, and report a survivor -- no orphaned room.
- [ ] `src/adapters/fakes/fakeMeeting.ts` -- an in-memory port recording joins, able to fail, to skip admission, or to die mid-meeting.
- [ ] `src/core/router.ts` -- register the command and its help lines.
- [ ] `src/core/app.ts` -- the `meet` case: refuse when a meeting is open or the argument is empty; claim; post **one editable message** (🔵 joining as `<project>`, edited to the in-room state with the project's current task state); join through the port; on failure close, wipe and edit the same message to the reason. `/meet stop` leaves when there is a handle, closes, wipes and posts exactly one summary (🟢/🔴, duration + outcome); with no handle it still closes a stale row. At startup close any row a previous process left open and say so. Subscribe to port states so an unexpected ending takes the same path.
- [ ] `src/index.ts` -- construct and stop the adapter.
- [ ] `src/core/app.test.ts` -- the command cases against `FakeMeeting` and the in-memory store (including the stale-row reconciliation and stop without a handle); plus `chromeFinder.test.ts` and `avatarScript.test.ts` -- provable without a browser.

**Acceptance Criteria:**
- Given a project's group and no open meeting, when `/meet <link>` is sent, then one meeting message appears within two seconds, a row holds the link, and the port was asked to join that link.
- Given the avatar waiting for admission, when the operator looks at the room, then the guest asking to join is named after the project.
- Given the avatar admitted, when the connector's state changes, then the face in the room shows blue joining, green in the room, red on a problem, and the group message is edited in place rather than repeated.
- Given an open meeting, when `/meet <link>` is sent in any project, then it is refused with the holding project and its start time, no row is written and no browser opens.
- Given an open meeting, when `/meet stop` is sent, then the handle leaves, the browser exits, the row closes with the link wiped, and exactly one summary (duration + outcome) appears.
- Given nobody admits the avatar, when 90 s pass, then the connector leaves, wipes the link and posts the reason; a later stop only reports that nothing is running.
- Given a browser that dies, or a stale row from a previous process, then the same terminal path runs, or the row is closed at startup with a reason in the group.
- Given the connector ran a meeting, when the log is inspected, then neither the link nor the room id appears in any line.

## Implementation Notes

- Implemented by a plan-only subagent: a `MeetingPort` (ids and names only), the `meetings` table with a partial unique index on the open row, four adapter files (`chromeFinder`, `cdp`, `avatarScript`, `browserMeeting`), a `FakeMeeting`, and the `/meet` lifecycle in `CoreApp` (one editable message, one summary, startup reconciliation, shutdown).
- Found while reading the diff rather than from the report: the injected script overrode only the video answer, so an audio request — combined or audio-only — fell through to the machine's real microphone and would have published this room's sound. Patched: audio is now always a silent synthetic `MediaStreamAudioDestinationNode` track, never a device, and the test that encoded the old behaviour was rewritten to assert no device call.
- The live-room parts (a real room, admission, the face on a phone, the force-kill of a surviving browser) are the ticket's hitl part and remain in the plan's manual checks.

## Plan Change Log

## Review Triage Log

Quick lens, 7 findings; each verified against the code at the cited location. No intent gap and
no plan fault, so all seven are patches and nothing loops back.

- **The link leaks into the Signal adapter's envelope log** — `high`, patch. Verified:
  `src/adapters/signal/signalCliClient.ts` logs `"signal envelope", { envelope: env }` at debug
  and `env` carries `data.message`/`sent.message`, so with `LOG_LEVEL=debug` a pasted
  `/meet https://…` is written to the log file; the core redacted only its own line, so the AC
  "the log holds neither the link nor the room id" fails. Fix: redact the text of a `/meet`
  message inside that log call.
- **A publishing canvas is taken as proof of admission** — `high`, patch. Verified: the poll
  latches `inRoom` on `publishing && admission !== "joining"`; the room's own lobby preview
  publishes the canvas and the probe returns `"unknown"` when it does not recognise the lobby,
  so the 90 s branch is unreachable and "in the room · unverified" is posted while the avatar
  still waits. Fix: latch in-room only on the probe's `in-room`, keep `publishing` for liveness,
  and let the budget end an unverified join with a reason.
- **Nothing makes the guest knock** — `high`, patch. Verified: no code in
  `src/adapters/meeting` clicks or dispatches on a join control, only the name is filled, so a
  host-locked room never shows the avatar and the story's manual check cannot pass. Fix: a
  best-effort join click from the injected script, reported when no control is found.
- **The media override races the room's first `getUserMedia`** — `high`, patch. Verified: the
  browser is spawned on the room URL and the override is installed only after attach, while
  `--use-fake-ui-for-media-stream` auto-accepts the permission, so a room that asks early is
  given the real camera and microphone. Fix: launch on `about:blank`, install the script, then
  navigate.
- **A lost DevTools socket is swallowed** — `medium`, patch. Verified: `poll` catches every
  failure and `CdpClient` closes silently, so a browser alive with a dead socket leaves the row
  open and the message frozen until a restart reconciles it. Fix: surface the client's close and
  take the terminal path.
- **A stop during launch can post "could not start"** — `medium`, patch. Verified: the join's
  rejection handler has no `stopping` guard, so a deliberate shutdown can win the race and post
  a red reason. Fix: ignore the join rejection while stopping.
- **`setState("left")` paints blue** — `low`, patch. Verified: `FACE_COLOURS.left` is red but
  the setter maps every other state to `joining`, and the adapter never passes `left`, so the
  entry is dead. Fix: remove it rather than add a branch.

## Design Notes

- **CDP, not Playwright:** the dependency rule allows one only if pure-JS and cross-platform, and the browser must be stoppable; Chrome 154 and Edge 155 are installed, Node has a global `WebSocket`, and `ws` is already a dependency, so a small protocol client buys the same control with nothing to download.
- **Injected, not served:** there is no HTTP server in the repo and adding one would be another port to bind; the face is a string added with `Page.addScriptToEvaluateOnNewDocument`, so it runs before the room's own scripts.
- **The debugging port is read, never guessed:** `--remote-debugging-port=0` plus `DevToolsActivePort`; a probed port is racy and guessable, and whoever finds it can read the room link out of the address bar — a place no log would ever leak.
- **`--incognito` and the profile:** the link must not land in browser history, which is where it would outlive the wiped row. The dedicated profile is the browser's only footprint and may be deleted at any time.
- **The credential:** written once into the row, read by the adapter, nulled on close, never logged; the adapter logs states and reasons only.
- **The one-meeting rule is a constraint, not a check:** the partial unique index turns the second claim into a failed write — the spec's "one atomic store write before the browser opens".
- **No animation, but a liveness flag:** throttling makes motion a lie in a covered window, and only state matters here; the flag turns "the face is publishing" into a check — the seed of the deaf alarm.
- **One message per meeting:** the group is also the task traffic; the meeting edits one message and adds one summary, the same lesson as the duplicate-replies fix.
- **Left to implementation:** how "in the room" is detected (a DOM probe that degrades to "unverified" rather than blocking).

## Verification

**Commands:**
- `npm run typecheck` -- expected: exits 0
- `npm test` -- expected: all suites pass, including the new store, chrome-finder, avatar-script and core meeting-command tests
- `npm run build` -- expected: exits 0
- `node dist/index.js --version` -- expected: prints the version

**Manual checks:**
- Create a room by hand, send `/meet <link>` in a project group, admit the avatar: a window opens, the face appears, the group message updates; `/meet stop` leaves, closes the window, and one summary appears; the log holds neither link nor room id.
- With a meeting open, send `/meet <link>` again: the refusal names the holding project and its start time.
- The dedicated profile has no history for the room (incognito) and deleting it is safe.
- Kill the daemon mid-meeting and restart: the group is told, and `/meet <link>` works again.
- End the call from the phone without `/meet stop`: the browser closes, the row is closed with the reason, one summary appears.
