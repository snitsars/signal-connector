---
title: 'Device link and configuration step'
type: 'feature'
ticket: '5'
created: '2026-10-20'
status: 'built'
baseline_revision: '0b28db174ffb1845d66a2a875cae517f48387feb'
route: 'full'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/AGENTS.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** a newcomer must link a Signal device and hand-write a config before anything works;
the repo only has a PowerShell script for that (`scripts/link-device.ps1`) and a standalone
`npm run link` that does not write the config. The spec's first run must need no hand edits.

**Approach:** a `link-device` setup step. Its check is "config exists and names an account". Its
apply links through the existing `SignalCliDaemon` + `startLink`/`finishLink`, shows the QR image it
writes, and then creates `config.toml` **only when the file is absent**: note-to-self channel, the
linked number, the installed signal-cli command, plugin agent, and one project named after the
current directory. An existing config is never overwritten; if it lacks an account the step stops
with the exact line to add. The link, QR rendering and file write are injectable, so the suite never
needs a phone.

## Boundaries & Constraints

**Always:** the linked number comes from `finishLink`, never from a guess; the QR image is written
under the data directory and its path is printed for the operator to scan; a missing config is
created with user-only permissions; an existing config is left byte-identical (reported instead of
edited); the step reports the number and the project path it wrote; the daemon used for linking is
stopped on every path.

**Never:** no overwriting or merging an existing config, no account number in a log line beyond the
step's own report line, no secret written, no network besides signal-cli's own link, no new
dependency, no `process.exit` in the helpers.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Behavior | Error Handling |
|----------|--------------|-------------------|----------------|
| First run | No config, phone ready | QR shown, link completes, config written, step ok | Link timeout → missing with the retry line |
| Second run | Config with account | Check ok, no link, nothing rewritten | — |
| Existing config without account | File present, no account | Stop with the exact line to add; file untouched | — |
| Link refused | `finishLink` throws | Missing with the reason; no config written | Daemon stopped |
| No signal-cli | Binary absent | Missing, fix names setup/Java | — |
| Bad data dir | Not writable | Failed with the reason | No partial file |

</frozen-after-approval>

## Code Map

- `src/cli/configure.ts` -- new: `writeInitialConfig({dir, account, projectPath, signal})` (template,
  no overwrite, 0600), `linkDevice({dataDir, config, link, print})` with an injectable linker and QR
  sink, and `linkStep(linker?)` returning the step.
- `src/cli/steps.ts` -- `registry()` appends `linkStep()` after `signal-cli`.
- `src/cli/configure.test.ts` -- fake linker/QR: first run, second run, existing config untouched,
  refused link, unwritable dir.
- `src/cli/link.ts` -- the QR/poll body moves into a callable `linkWithQr` used by both the script
  and the step (no behaviour change for `npm run link`).
- `README.md` -- setup now links the device and writes the config.

## Tasks & Acceptance

**Execution:**
- [x] `configure.ts` -- config template from the linked account, the installed signal-cli, the plugin
  agent and the current directory as one project; refuses to overwrite.
- [x] `configure.ts` -- `linkDevice` with an injected linker (start/QR/finish/stop) and the step.
- [x] `src/cli/link.ts` -- extract `linkWithQr` (daemon start, QR file, poll, stop) and reuse it.
- [x] `steps.ts` -- the new step in the registry.
- [x] tests -- every matrix row with fakes; a real phone is not needed.
- [x] `README.md` -- the first-run sequence.

**Acceptance Criteria:**
- Given no config and a successful link, then config.toml exists, parses, names the linked number,
  one project for the current directory, and the step is ok.
- Given a config with an account, then the step is ok without linking and the file is unchanged.
- Given a config without an account, then the step stops with the line to add and the file is
  byte-identical.
- Given a refused link, then no config is written and the daemon was stopped.
- Given the step is applied twice, then no second link and no rewrite.

## Implementation Notes

- `configure.ts` holds the template, the atomic `wx` create, the four-phase `DeviceLink`, the shared
  `driveLink` phase order and the step. `link.ts` supplies the production phases (`signalLinker`)
  and `linkWithQr`; the step imports it dynamically inside `apply`, so `doctor`'s static graph still
  has no adapters or config/toml/zod.
- `linkStep` sits immediately after `signal-cli`. Because the `StepContext` is a snapshot taken
  before the run, both `linkStep.check` and `configStep.check` re-read `config.toml` from disk; a
  step that just wrote the file would otherwise leave the config step reporting the old absence.
- The QR image is now written under the data directory for `npm run link` too (`link-qr.png`), not
  the OS temp directory; the rest of the script flow (start, instructions, poll, open, stop) is
  unchanged.
- `npm run link` is now import-safe: a direct-invocation guard keeps `main()` from starting a daemon
  when the setup step imports `signalLinker`. A `finish` rejection is a refusal (it stops and is
  reported); the production `finish` maps a not-yet-scanned RPC error to `""` and keeps polling.
- An existing config without an account reports `failed` with
  `account = "+<your number>"`, so `setup` never calls the apply and the bytes stay identical.

## Plan Change Log

## Review Triage Log

## Design Notes

- **Why only create, never edit:** a hand-written config is the operator's work; merging would
  silently drop comments and projects. The step's job is the empty first run.
- **Why the project is the current directory:** setup is run where the operator wants to work; that
  is the only project path it can know without asking, and 6.5 can add more later.
- **Why the linker is injected:** the live path needs a phone; the fakes prove the config bytes and
  the no-overwrite rule.

## Verification

**Commands:**
- `npm run typecheck` -- expected: exits 0
- `npm test` -- expected: all suites pass
- `npm run build` -- expected: exits 0
- `node dist/index.js doctor` -- expected: the link step is ok on this machine

**Manual checks (hitl):** in a fresh data dir, run `setup`, scan the QR with Signal, confirm the
config appears and a message sent to the group reaches the agent.
