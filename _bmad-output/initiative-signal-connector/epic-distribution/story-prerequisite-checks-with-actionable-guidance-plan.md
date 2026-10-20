---
title: 'Prerequisite checks with actionable guidance'
type: 'feature'
ticket: '3'
created: '2026-10-20'
status: done
baseline_revision: 'a5f43847898bf3b28da3d55e196131d00e6fac35'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/AGENTS.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `doctor` currently knows one step (the Node floor), while the product's real
prerequisites — Java, signal-cli, opencode, the data directory, the config file and the secrets
store — are checked only by PowerShell scripts that the CLI never runs. A newcomer who misses one
gets a stack trace from the daemon instead of the exact command that fixes it.

**Approach:** add one step per prerequisite, each reporting `ok | missing | failed` with a
one-line reason and the exact fix (a script name, a command or a link). The config is read
**without side effects** (a new `readConfig` beside `loadConfig`), the steps take their paths from
it when it exists and from PATH otherwise. The daemon runs the same registry before boot and
refuses to start with the same lines when anything is missing.

## Boundaries & Constraints

**Always:** `doctor` stays read-only — `readConfig` never creates the directory or a default file,
and no step writes; every fix names a concrete action (`scripts/ensure-java.ps1`,
`scripts/install-signal-cli.ps1`, the opencode install command, a URL); command steps are bounded
(a five-second timeout) and injectable so tests never need Java, signal-cli or opencode; the daemon
prints the same doctor lines and exits 1 instead of crashing; the registry order is stable and
later stories append their installers.

**Never:** no installation here — 6.4–6.6 own fetching and writing; no new dependency; no secret
value is read, printed or compared; a missing config is `missing`, not `failed` (the fix is setup);
no `process.exit` inside steps or runners.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Behavior | Error Handling |
|----------|--------------|-------------------|----------------|
| Everything present | Config valid, tools on PATH | Each step ok; exit 0; daemon boots | — |
| Java missing | No java on PATH, no command in config | `missing java` with the install fix; exit 1 | — |
| opencode missing | No opencode binary | `missing opencode` with the install fix; exit 1 | Timeout counts as missing/failed with the reason |
| Config absent | No config.toml | `missing config` with the setup fix; doctor creates nothing | — |
| Config invalid | TOML/schema error | `failed config` with the parse message, one line | No stack |
| Data directory absent | Parent writable | `missing data-directory` with the setup fix; nothing created | Permission error → failed with the reason |
| Secrets | Windows without pwsh | `failed secrets` with the pwsh fix | Other platforms report the in-memory limitation |
| Daemon | Any step missing | Prints the same lines, exits 1 | No store or browser opened first |

</frozen-after-approval>

## Code Map

- `src/cli/setup.ts` -- `StepContext` (20-23), `registry()` (190-192): extend the context with
  `dataDir` and an optional parsed `config`, keep the runners unchanged.
- `src/config/config.ts` -- `loadConfig` (240-249) writes; add `readConfig(dir)` that only reads and
  parses (`smol-toml` + `ConfigSchema.safeParse`), returning `{ ok, config } | { ok: false, reason }`.
- `src/cli/steps.ts` -- new: `javaStep`, `signalCliStep`, `opencodeStep`, `dataDirStep`,
  `configStep`, `secretsStep`, each a factory taking `(run, env)` overrides for tests; a default
  `runCommand` using `spawnSync` with a five-second timeout and `resolveCommand`.
- `src/cli/setup.ts` -- `registry()` returns node, java, signal-cli, opencode, data-directory,
  config, secrets in that order.
- `src/index.ts` / `src/daemon.ts` -- the doctor/setup branch builds the context (data dir + read
  config); `runDaemon()` runs the registry first and returns 1 with the same guidance when a step
  is missing.
- `src/cli/steps.test.ts`, `src/cli/setup.test.ts` -- fake runners and temp dirs; no real tools.
- `README.md` -- the doctor section lists what is checked and that the daemon refuses with the same
  guidance.

## Tasks & Acceptance

**Execution:**
- [x] `src/config/config.ts` -- `readConfig` with no side effects, tested against valid, invalid and
  absent files in a temp dir.
- [x] `src/cli/setup.ts` -- `StepContext` gains `dataDir` and an optional `config`; runners take the
  context; the existing Node step keeps working.
- [x] `src/cli/steps.ts` -- the six steps with actionable fixes and injectable runners.
- [x] `src/cli/setup.ts` -- `registry()` lists all seven steps in a stable order.
- [x] `src/daemon.ts` -- preflight the registry and refuse to boot with the same lines and exit 1.
- [x] `src/cli/steps.test.ts`, `src/cli/setup.test.ts`, `src/config/config.test.ts` -- present,
  absent, throwing, timeout, invalid config, no-write checks.
- [x] `README.md` -- what doctor checks.

**Acceptance Criteria:**
- Given java and opencode removed, when `doctor` runs, then both are named with their fixes and the
  exit code is 1.
- Given a complete machine, then every step is ok, `doctor` exits 0 and the daemon starts.
- Given no config, then `doctor` reports it missing with the setup fix and creates no file.
- Given an invalid config, then the message is one line with the parse reason and no stack.
- Given the daemon starts with a missing prerequisite, then it prints the same lines and exits 1
  without opening the store, the daemon or a browser.

## Implementation Notes

- `readConfig(dir)` mirrors `loadConfig` but only reads: `ENOENT` becomes `absent: true`, TOML and
  schema failures become `absent: false` with a one-line reason, and a valid file returns the
  parsed `Config`. `loadConfig` is untouched and still owns creating the directory/default file.
- `StepContext` now carries `dataDir`, an optional parsed `config`, and an optional
  `configProblem { absent, reason }`. `src/index.ts` and `src/daemon.ts` build it once through
  `stepContext()` from the dynamic `readConfig(dir)`, so `setup.ts` never imports config and the
  doctor path keeps its tiny static graph (`node:fs`, `./cli/args.js`, `./cli/setup.js`).
- `src/cli/steps.ts` holds `javaStep`, `signalCliStep`, `opencodeStep`, `dataDirStep`,
  `configStep` and `secretsStep`. Command steps take a `RunCommand` (argv includes the executable)
  and use the configured `signal.command`/`signal.cliPath`/`agent.opencodePath` when present,
  otherwise PATH. The production runner uses `resolveCommand` plus `spawnSync` with a 5000 ms
  timeout; `ENOENT` and "not recognized"/"not found" output are `missing`, timeouts and other
  non-zero exits are `failed`. Every report stays one line.
- Fixes name a concrete action: `scripts/ensure-java.ps1`, `scripts/install-signal-cli.ps1`,
  `npm install -g opencode-ai` + https://opencode.ai/docs, creating the data directory/`setup`,
  fixing the named config file, and https://aka.ms/powershell for the DPAPI store. On non-Windows
  the secret step is `ok` with the in-memory limitation.
- `registry()` returns node, java, signal-cli, opencode, data-directory, config, secrets in that
  order. `runDoctor`/`runSetup` now take the whole `StepContext`.
- `runDaemon()` runs `runDoctor(registry(), …)` before the logger, bridge, store, signal-cli daemon
  or browser; on a non-zero result it prints the same lines (plus one "not ready" line) and returns
  1, which `src/index.ts` turns into `process.exit(1)`. A successful start returns 0 only after the
  shutdown handlers are registered, so the process keeps running.
- Tests cover present/absent/invalid config without writes, missing/throwing/timeout/non-zero
  probes through fakes, configured-vs-PATH command selection, data-directory permissions, the
  non-Windows secret branch, and the production runner against `node --version`. `src/index.test.ts`
  now also rebuilds when `steps.ts` or `config.ts` changes.
- Verified: `npm run typecheck`, `npm test` (39 files / 505 tests) and `npm run build` pass.
  `node dist/index.js doctor` prints seven `ok` lines and exits 0 on this machine. With a scratch
  `APPDATA` and Java removed from PATH it reports `missing java`, `missing signal-cli`,
  `missing data-directory` and `missing config`, creates no `SignalConnector` directory, and exits
  1; `node dist/index.js` prints the same lines and also exits 1. An invalid TOML file reports
  `failed config` in one line with no stack and is left byte-for-byte unchanged.

## Plan Change Log

- `StepContext` also gained `configProblem` (absent + reason). Without it `configStep` could not
  distinguish a missing config from an invalid one without reading the file a second time; the
  context remains the single read-only source of that outcome.

## Review Triage Log

Self-review, one finding, patched. The new `secrets` step required PowerShell 7 only, while the
secret store falls back to Windows PowerShell; on a machine without `pwsh` the daemon would have
refused for a prerequisite that is actually satisfied. The step now probes `pwsh.exe` and then
`powershell.exe` and reports which one it found; both missing is still a failure with the installer
link. Covered by a test that fakes the two probes.

## Design Notes

- **Why `readConfig` and not `loadConfig`:** doctor must be able to describe a machine without
  changing it; the existing loader writes a default file and creates the directory.
- **Why steps are factories:** each command step takes its runner, so tests prove the classification
  and the fix text without Java or opencode installed; production passes the spawn runner.
- **Why the daemon runs the registry:** the spec's Done-when asks for the same guidance instead of a
  crash after linking; reusing the registry keeps the two surfaces in step.

## Verification

**Commands:**
- `npm run typecheck` -- expected: exits 0
- `npm test` -- expected: all suites pass
- `npm run build` -- expected: exits 0
- `node dist/index.js doctor` -- expected: seven lines, exit 0 on this machine
- `node dist/index.js doctor` with PATH stripped of java -- expected: java named, exit 1
- `node dist/index.js` -- expected: same lines and exit 1 when a prerequisite is missing

**Manual checks:**
- Rename the config in a temp data dir and confirm doctor reports it missing without creating it.
- Confirm the daemon prints the same lines when started in that temp dir.
