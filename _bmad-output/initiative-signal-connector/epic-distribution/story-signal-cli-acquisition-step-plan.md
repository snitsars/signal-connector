---
title: 'signal-cli acquisition step'
type: 'feature'
ticket: '4'
created: '2026-10-20'
status: done
baseline_revision: 'b81b8f29398b3434f617d3000a98e6bfd3d49dc0'
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

**Problem:** the signal-cli step can only report that signal-cli is missing and point at a PowerShell
script; on a machine without the repo (or off Windows) the agent cannot fix it, so the first run
stops. The ticket's unknown — whether release assets and the Java version can be resolved without a
maintained lookup table — is settled: GitHub's latest release carries the generic
`signal-cli-<version>.tar.gz`, and signal-cli 0.13+ runs on Java 17 or newer (this machine has 25).

**Approach:** the step gains an `apply`. It asks the GitHub API for the latest release, downloads the
generic archive into a temp file, extracts it with the system `tar` under
`<dataDir>/signal-cli/signal-cli-<version>`, and the check then finds that installed copy (or a
configured/PATH copy) instead of requiring a hand edit. Config writing stays in 6.5; this story only
puts the tool on the machine. Network, extraction and the command runner are injectable, so tests are
offline and deterministic.

## Boundaries & Constraints

**Always:** the release URL and the download are the only network calls and are bounded; the archive
comes from `AsamK/signal-cli`'s latest release and its name must look like `signal-cli-<ver>.tar.gz`
(no `-Linux-native`, no source zip); extraction uses `tar -xzf` into an empty version directory and a
failed extraction leaves nothing half-unpacked; an already-installed copy is never downloaded again;
the Java prerequisite is named before the download (the step's check stays independent, the fix says
Java ≥ 17); every failure is one line with the reason and the manual fallback
(`scripts/install-signal-cli.ps1`); no secret is involved.

**Never:** no new dependency, no bundled binary, no writing the service config (6.5), no `process.exit`
inside helpers, no following redirects to a non-GitHub host, no trusting an archive whose name does
not match the version it claims.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Behavior | Error Handling |
|----------|--------------|-------------------|----------------|
| Nothing installed | No config path, no PATH binary, no data-dir copy | Missing with the Java/PowerShell fix | — |
| Config points at a copy | Path exists | Ok, version from `--version` (bounded) | Timeout → failed with reason |
| Data-dir copy exists | `<dataDir>/signal-cli/*/bin/signal-cli*` | Ok, newest copy named | — |
| Install | Latest release resolvable | Downloaded, extracted, copy found by the post-check | Download/extract failure → one line, temp removed |
| Installed twice | Copy already present | No download; already satisfied | — |
| Offline | API unreachable | Missing stays, reason names the network and the manual fallback | No stack |
| Bad asset | No matching name | Clear reason naming the release | Nothing written |

</frozen-after-approval>

## Code Map

- `src/cli/steps.ts` -- `signalCliStep` (174-182) gains an `apply`; its check consults the config
  path, PATH and the installed copies; `SyncSetupStep`/`StepContext` already provide `dataDir`.
- `src/cli/signalCliInstall.ts` -- new: `latestRelease(fetchImpl)` (API, asset selection),
  `installedCopies(dataDir)`, `installSignalCli({dataDir, fetch, extract, print})`.
- `src/cli/setup.ts` -- registry order unchanged; the step's `apply` is now defined.
- `src/cli/signalCliInstall.test.ts`, `src/cli/steps.test.ts` -- fake fetch/extract/temp dirs.
- `README.md` -- doctor/setup now fetch signal-cli into the data directory when it is missing.

## Tasks & Acceptance

**Execution:**
- [x] `signalCliInstall.ts` -- release lookup, version-shaped asset choice, bounded download to a
  temp file, `tar -xzf` extraction, and the installed-copy scan.
- [x] `steps.ts` -- the check considers config, PATH and data-dir copies; the apply installs and the
  post-check finds the result; failures keep the manual fix.
- [x] tests -- every matrix row, including an extractor that writes a fake `bin/signal-cli` and a
  second run that downloads nothing.
- [x] `README.md` -- the acquisition note.

**Acceptance Criteria:**
- Given no signal-cli anywhere, when `setup` runs, then it downloads and extracts the latest release
  under the data directory and the step becomes satisfied.
- Given an installed copy, when setup runs again, then no download happens.
- Given no network, then the step stays missing with a one-line reason and the manual fallback.
- Given a release without the expected archive, then nothing is written and the reason names it.

## Implementation Notes

- `src/cli/signalCliInstall.ts` is the whole mechanism, with the network, the extractor and the
  progress sink as arguments. `latestRelease` accepts only `signal-cli-<digits and dots>.tar.gz`,
  drops an asset whose URL names a different file or is not on a GitHub host, and picks the highest
  version if a release carries several. The version is taken from the asset name, so the extracted
  `signal-cli-<version>/` must match it; a different top-level directory or a missing `bin/signal-cli`
  is refused.
- Redirects are followed by hand with `redirect: "manual"`, up to five hops, and each `Location` is
  parsed against `github.com` / `githubusercontent.com` before it is contacted. That is how
  GitHub's `browser_download_url` reaches its `objects.githubusercontent.com` target without opening
  the step to an arbitrary host.
- Both calls carry a timeout (`API_TIMEOUT_MS` 15 s, `DOWNLOAD_TIMEOUT_MS` 120 s) and the archive is
  capped at 128 MiB: `content-length` is checked first and the body is streamed through a reader
  that cancels at the cap, so an oversized or endless response cannot be buffered whole. A failed
  lookup or download is one reason, with the underlying network text on the same line.
- `installSignalCli` returns `{ version, home, path, downloaded }` and never exits. It short-circuits
  on `installedCopies(dataDir)[0]`, so the second run does no network work. The archive is written to
  a `mkdtemp` directory and unpacked into `<dataDir>/signal-cli/.staging-<pid>-<time>`; only after
  the launcher exists is the version directory renamed into place. The `finally` removes the staging
  directory and the temp archive, so a failure leaves no partial copy.
- Windows needed one deviation from the obvious probe. The release's `bin/signal-cli.bat` expands a
  ~7 KB classpath into one cmd line; under `<dataDir>/signal-cli/signal-cli-<version>` that exceeds
  cmd's ~8 KB limit and the launcher fails with "The input line is too long" (the existing
  `%LOCALAPPDATA%` install does the same). So a copy found on Windows is probed the way generated
  configs already start signal-cli — `java -cp <home>/lib/* org.asamk.signal.Main --version`, using
  the configured JDK when there is one. Elsewhere the shipped launcher is probed directly.
  `installedCopies` still names the `.bat` as the copy's path; `home` is exposed for 6.5.
- The live `signal-cli-0.14.9` is compiled for Java 25 (class file 69), not 17: on this machine the
  `java` on PATH is 24 and is rejected, while the configured JDK 25 runs it. The plan's "Java >= 17"
  wording is kept in the fix, with a note that recent releases need the configured JDK; the failure
  itself names the class-file mismatch. Checking the JDK floor belongs to the java step, not here.
- `signalCliStep` keeps its check synchronous: configured command → `signal.cliPath` → PATH, then
  the installed copies newest first. A configured probe that times out or exits non-zero with a real
  error is `failed` (the matrix row) and does not silently fall back. A "not found" probe does move
  on, and `MISSING_TEXT` now also recognises cmd's "cannot find the path specified" and a Java
  `ClassNotFoundException`, so a config still naming a deleted copy falls through to the data-dir
  copy — which is what makes the apply satisfiable before 6.5 writes config. The apply prints the
  Java prerequisite before touching the network, calls `installSignalCli`, and prints the installed
  path; `setup` re-checks afterwards. The missing `fix` names both `node dist/index.js setup` and
  the manual `scripts/install-signal-cli.ps1`.
- Tests: `src/cli/signalCliInstall.test.ts` (23) covers the asset shape and decoys, newest-version
  choice, URL/version mismatch, non-GitHub assets and redirects, the redirect limit, HTTP and JSON
  failures, network failure, the copy scan (newest first, staging ignored, `.bat` preference), a real
  install with a fake archive, a no-op second install, extraction failure and wrong-version/no-launcher
  archives, a missing asset writing nothing, and the size cap. `src/cli/steps.test.ts` gained 9
  signal-cli cases: configured command, cliPath/PATH fallback, a data-dir copy named in the reason, a
  timeout staying `failed`, falling through a deleted config to the copy, the Windows java probe,
  apply-then-check, a second apply without downloads, `runSetup` installing once and skipping,
  offline one-line failure, and a bad release writing nothing.
- `src/index.test.ts` now lists `src/cli/signalCliInstall.ts` among the sources that force a
  rebuild, because `steps.ts` imports it and the doctor path ships it.
- Verified: `npm run typecheck` clean; `npm test` 593 passed / 2 skipped in 42 files (was 561 / 2 in
  41); `npm run build` clean; `node dist/index.js doctor` shows `ok signal-cli signal-cli 0.14.9`
  on this machine. Real runs against a temp data dir downloaded `signal-cli-0.14.9.tar.gz`,
  extracted `signal-cli/signal-cli-0.14.9/bin/signal-cli.bat`, and returned `downloaded: false` on
  the second call with no further network work. The step then found the copy (`ok`, 0.14.9) when the
  config named the JDK 25; with no config the same probe correctly failed on this machine because
  `java` on PATH is 24 and the release needs 25.

## Plan Change Log

## Review Triage Log

## Design Notes

- **Why the generic tar.gz:** it is pure Java and works on all three OSes; the native Linux build
  would tie the step to one platform.
- **Why the check scans the data directory:** after apply the tool is on the machine but the config
  still names the old path; requiring a config write here would make the step unsatisfiable until
  6.5, and scanning is what proves the download landed.
- **Why extraction is injected:** a test that shells out to real `tar` would need a fixture archive
  and a real download; the fake extractor writes the expected layout and keeps the suite offline.

## Verification

**Commands:**
- `npm run typecheck` -- expected: exits 0
- `npm test` -- expected: all suites pass
- `npm run build` -- expected: exits 0
- `node dist/index.js doctor` -- expected: the signal-cli line is ok on this machine

**Manual checks:**
- In a temp data dir with no signal-cli on PATH, run `setup` and confirm the archive lands and the
  second run is a no-op; then point `signal.cliPath` at the extracted binary (6.5 does this) and
  start the daemon.
- Result: the CLI has no data-dir override, so the install and no-op half was driven through the
  compiled module against a temp dir. On Windows the extracted `.bat` cannot be used as
  `signal.cliPath` under the data dir because its classpath exceeds cmd's line limit; 6.5 must
  write `signal.command` with the configured JDK and `lib/*` (see Implementation Notes).
