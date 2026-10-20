---
title: 'Setup-step interface and doctor/setup commands'
type: 'feature'
ticket: '2'
created: '2026-10-20'
status: 'built'
baseline_revision: '5236348358159ef14f6f7cb98f66d59739316045'
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

**Problem:** first-run work will be spread over five stories (prerequisites, signal-cli, device
link, plugin install, documentation), and there is no shared shape for a "step" — nothing that
`doctor` can report and `setup` can run, skip and resume. Today the CLI understands only
`--version`, `--help` and the daemon; `loadConfig` even writes a default config as a side effect,
so a diagnostic that reused it would change the machine it is describing.

**Approach:** a pure `SetupStep` contract (`id`, `title`, `check`, optional `apply`) and two
runners: `doctor` calls every `check`, prints one line per step without changing anything and exits
non-zero when any step is missing or failed; `setup` walks the same order, skips steps whose check
is already satisfied, applies the rest, and is safe to run twice. `src/cli/args.ts` gains `doctor`
and `setup` modes, `src/index.ts` dispatches them before the store, daemon or config are touched,
and one real step (the Node floor) proves the contract end to end. Later stories only add steps.

## Boundaries & Constraints

**Always:** `doctor` is read-only — no config written, no data directory created, no secret store
constructed, no daemon or store opened; a step reports `ok | missing | failed` with a one-line
reason and, where possible, the exact fix; `setup` runs the same registry in the same order, skips
satisfied steps (twice is a no-op), stops at the first failure with its guidance and exits non-zero;
step ids are stable and ordered by the registry, not alphabetically; `--version` and `--help` keep
working without any side effect; output is plain text with no secrets.

**Never:** no new dependency; no step may hold state outside its report; no `process.exit` inside the
runners (they return an exit code so they are testable); no prerequisite *installation* here — that
is 6.3–6.6; no change to the daemon's boot path.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Behavior | Error Handling |
|----------|--------------|-------------------|----------------|
| Healthy machine | Every step checks ok | `doctor` prints one ok line per step, exits 0 | — |
| A missing prerequisite | One step reports missing with a fix | Its line names the reason and the fix; exit 1 | — |
| A throwing check | A step throws instead of reporting | Treated as `failed` with the message; other steps still run | Message printed, no stack |
| Setup twice | First run applied a step | Second run reports it already satisfied and changes nothing | — |
| Setup interrupted | Steps 1–2 done, step 3 fails | Exit 1 at step 3; a rerun starts by skipping 1–2 | — |
| No steps | Empty registry | `doctor` says nothing is registered and exits 0 | — |
| Daemon args | `--version` / `--help` / no args | Unchanged behaviour; no setup code runs | — |

</frozen-after-approval>

## Code Map

- `src/cli/args.ts` -- `CliMode` and `parseArgs` (7, 27-33), `USAGE` (9-21): add `doctor` and `setup`.
- `src/cli/setup.ts` -- new: `SetupStep`, `StepReport`, `StepContext`, `registry()`, `runDoctor`,
  `runSetup`, and `printReport`; pure runners that take steps and a print sink and return an exit
  code. The real registry starts with the Node-floor step.
- `src/cli/setup.test.ts` -- new: fake steps for order, skip, resume, throw, empty registry, exit codes.
- `src/index.ts` -- the arg gate (201-216): dispatch `doctor`/`setup` before `main()` and exit with
  the returned code; nothing else changes.
- `src/cli/args.test.ts` -- cover the two new modes in `parseArgs`.
- `README.md` -- one short "Doctor and setup" note beside the existing first-run section.

## Tasks & Acceptance

**Execution:**
- [x] `src/cli/setup.ts` -- define the contract and the two runners: ordered registry, per-step
  check, read-only doctor, resumable idempotent setup, no `process.exit` inside.
- [x] `src/cli/setup.ts` -- the first real step: the Node floor (>= 22.13, from `package.json`
  engines) reporting its version and the fix link; a `registry()` returning it.
- [x] `src/cli/args.ts` + `src/index.ts` -- `doctor` and `setup` modes parsed and dispatched before
  any store/config/daemon work, with the runner's exit code.
- [x] `src/cli/setup.test.ts`, `src/cli/args.test.ts` -- order, skip, resume, throwing check, empty
  registry, exit codes, and the two parsed modes.
- [x] `README.md` -- `doctor` reports and `setup` runs the same steps; both are safe.

**Acceptance Criteria:**
- Given a machine where every step checks ok, when `doctor` runs, then it prints one line per step
  and exits 0 without creating or changing any file.
- Given a step that reports missing, when `doctor` runs, then its line names the reason and the fix
  and the exit code is 1.
- Given a step that throws, then it is reported as failed and the remaining steps still run.
- Given `setup` ran once, when it runs again, then every step is reported already satisfied and
  nothing is applied twice.
- Given `setup` stops at a failing step, when it is rerun, then earlier steps are skipped and the
  run resumes from the failure.
- Given `--version` or `--help`, then neither runner executes.

## Implementation Notes

- `src/cli/setup.ts` owns the contract (`SetupStep`, `StepReport`, `StepContext`, `Print`),
  `printReport`, `runDoctor`, `runSetup`, the Node-floor helpers (`NODE_FLOOR`,
  `meetsNodeFloor`, `nodeVersionStep`) and `registry()`. The runners take a `readonly SetupStep[]`
  plus a `Print` sink and return `0 | 1`; `src/index.ts` alone calls `process.exit`.
- Output is one fixed-width line per step: a 7-column status (`ok`, `missing`, `failed`, plus the
  runner's `skip`/`apply` progress labels), a 14-column id, the reason, then ` — fix: …` when the
  step supplied one. Newlines in reasons, fixes and error messages are collapsed so a multi-line
  shell error cannot break the one-line rule, and a thrown value prints only its message.
- `setup` labels an already-satisfied step `skip`, applies a missing step with an `apply`, then
  re-checks: a post-apply `ok` is the only success, so an installer that exits cleanly without
  doing its job still fails the run. A `missing` step with no `apply` (the Node floor) stops the
  run with its fix. `registry()` returns a fresh array each call, so a caller cannot mutate the
  product order.
- `NODE_FLOOR = "22.13.0"` is a constant mirroring `engines.node`; `setup.test.ts` reads
  `package.json` and fails if the two drift, so no check ever reads the manifest at run time. The
  Node step deliberately has no `apply`: 6.3–6.6 own their installers.
- Review fixes: `src/index.ts` now has a tiny static graph (`node:fs`, `./cli/args.js`,
  `./cli/setup.js`); the daemon body moved to `src/daemon.ts` and is imported dynamically only in
  the daemon branch, so a below-floor process reaches the Node step instead of dying on
  `node:sqlite`. `sqliteDriver` requires `node:sqlite` inside the `DatabaseSync` constructor and
  fails with a clear "needs Node.js 22.13" message. `doctor`/`setup` reject trailing arguments, a
  thrown `apply` still shows the check's fix, and `src/index.test.ts` locks the entry graph and
  spawns the built CLI for `doctor`/`--version`. `README.md` now states Node ≥ 22.13.
- Verified: `npm run typecheck`, and the suites covering the changed files (`setup`, `args`,
  `index`, `store` — 35 tests) pass, including the entry test that builds and spawns the real CLI.
  The first build round also passed the full `npm test` (473 tests / 37 files) and `npm run build`,
  plus `doctor`/`setup` exit 0 with an unchanged `%APPDATA%\SignalConnector` snapshot and a scratch
  copy at floor 99.0.0 exiting 1 with the fix; the parent reruns full verification after these
  review fixes.

## Plan Change Log

## Review Triage Log

Quick lens, 5 findings; each verified against the code. All real, all patched — no intent gap,
no plan fault, nothing deferred.

- **`doctor` could not run below the Node floor** — `high`, patch. Verified: the entry statically
  imported the store, and `sqliteDriver` called `require("node:sqlite")` at module scope, so on
  Node 18/20 the process died before the Node step could report the fix — the one case the step
  exists for. Fix: the entry's static graph is now `node:fs` + the parser + `setup`, the daemon
  body moved to `src/daemon.ts` behind a dynamic import, and `node:sqlite` loads lazily inside
  `openStore` with a clear message. Verified for real: `npx node@18.20.4 dist/index.js doctor`
  prints `missing node-version … fix: install Node.js 22.13.0` and exits 1.
- **A throwing `apply` dropped the check's guidance** — `medium`, patch. Verified: the failure path
  printed only the apply error, so the installers' most useful line (the fix URL) vanished exactly
  when it was needed. Fix: print the check's report as failed with the apply error appended; the
  stop line stays.
- **Trailing arguments were ignored** — `medium`, patch. Verified: `parseArgs` returned on the first
  token, so `setup --help` would have run the installers once 6.3–6.6 exist. Fix: `doctor`/`setup`
  with any trailing argument return usage; covered by tests.
- **README still advertised Node ≥ 20** — `low`, patch. Verified next to the new section that says
  22.13; the header and the host prerequisites line now agree with `engines.node`. `AGENTS.md`
  stays for its owner (recorded in deferred work).
- **Nothing proved `doctor` is read-only** — `low`, patch. Verified: the suite compared output
  arrays only. Fix: a step with an `apply` is asserted never to be applied, and a recursive temp-dir
  snapshot (paths, sizes, mtimes, contents) is unchanged after `doctor`; the entry's static import
  list and a spawned `doctor`/`--version` are covered too.

## Design Notes

- **Why the runners return a code:** `process.exit` inside them would make every case a subprocess
  test; returning a number keeps the contract pure and lets `index.ts` own the exit.
- **Why the registry lives in code, not config:** order and ids are product decisions, and a
  config-driven registry would let a half-written file silently remove a step.
- **Why only the Node step now:** 6.3–6.6 own their checks and installers; 6.2 proves the contract
  with the one prerequisite that already exists and cannot be fixed by a download.

## Verification

**Commands:**
- `npm run typecheck` -- expected: exits 0
- `npm test` -- expected: all suites pass, including the new setup and args tests
- `npm run build` -- expected: exits 0
- `node dist/index.js doctor` -- expected: lists the Node step and exits 0 on this machine
- `node dist/index.js setup` -- expected: reports the step satisfied, changes nothing

**Manual checks:**
- Run `doctor` twice and confirm no file under the data directory appears or changes.
- Break the Node step's comparison in a scratch copy and confirm `doctor` exits 1 with guidance.
