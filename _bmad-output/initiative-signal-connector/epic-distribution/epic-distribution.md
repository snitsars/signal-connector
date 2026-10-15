---
tracker_id: ""
key: ""
type: epic
title: "A stranger can install SignalConnector and get a reply"
parent: initiative-signal-connector
covers: [CAP-1, CAP-2, CAP-3, CAP-4, CAP-5, CAP-6]
after: []
assignee: ""
risk: high
---

# A stranger can install SignalConnector and get a reply

## Description

Today the product works only for the person who built it: installing means cloning the
repository, running PowerShell scripts, downloading signal-cli by hand, editing `config.toml`
and copying the opencode plugin into a global folder — and the secrets path is Windows-only.
This epic makes the same product installable from a published artifact and startable by a
guided first run, on Windows, macOS and Linux. The requirement source is
`spec-distribution/spec-distribution.md`, whose six capabilities this epic owns whole.

## Outcome

Someone who has never seen the repository goes from nothing to sending `/projects` in Signal
and getting a reply, using only published documentation and release artifacts; the spec's
success signal is the measure.

## Requirements

The numbered source is the spec in this folder; it owns the ids.

- CAP-1 — install from npm or the GitHub release zip, with no clone.
- CAP-2 — guided first run from install to a proven loop, without hand-editing files.
- CAP-3 — missing prerequisites diagnosed with actionable instructions.
- CAP-4 — the normal install and run path works on Windows, macOS and Linux.
- CAP-5 — installing and updating the opencode plugin is a product command.
- CAP-6 — one version tag produces both artifacts with the suite green on every supported OS.

## Done when

1. A machine with only Node ≥ 20 installs the published package or the release zip and
   `signal-connector --version` prints the package version, on Windows, macOS and Linux.
2. On a clean machine, the guided first run links a Signal device, writes configuration,
   installs the plugin, and ends with a numbered command in Signal answered in the configured
   channel — with no file edited by hand.
3. With Java, signal-cli or opencode absent, the diagnostic names each gap with the exact
   command to fix it, and the daemon refuses to start with the same guidance instead of
   failing after linking.
4. Linked credentials survive a daemon restart on Windows, macOS and Linux.
5. Tagging a version produces the npm package and the GitHub zip from that commit, with the
   test suite green on every supported OS.
6. The clone-based Windows workflow that exists today still passes `npm run typecheck` and the
   test suite, unchanged.

## Boundaries

The install, first-run, packaging and release of the product as it is today. Not the bridge's
runtime behaviour (owned by the existing epics), not new agent adapters, not a GUI or tray, not
a hosted service, not distribution channels beyond npm and the GitHub release zip — the spec's
non-goals are this epic's non-goals.

## References

- parent — _bmad-output/initiative-signal-connector/initiative-signal-connector.md
- spec — spec-distribution/spec-distribution.md (capability ids this epic owns)
- spec — spec-distribution/install-paths.md (channels, prerequisites, platform notes)
- constraint — AGENTS.md, Conventions (Node ≥ 20, no native build dependency)
- constraint — architecture-signal-connector/architecture-signal-connector.md, AD-9 (secrets never in the repo or a log line) and AD-1 (core imports no adapter)
- constraint — prd-signal-connector/prd-signal-connector.md, TC1 (linking is a QR device link; there is no bot account)

## Notes

- Decision: one epic, not several (2026-10-15). All six capabilities are delivered by one owner
  and one module (the package) and the Done when reads as one outcome a product owner can check;
  a second epic would need a contract between them for no boundary gain.
- Decision: the tracer bullet is entry 1 (2026-10-15). `npm pack` → install the tarball → run
  `--version` cuts through manifest, build output, bin wiring and CLI parsing, proving they
  connect before anything else is built, and needs no registry account.
- Assumption: the newcomer has Node ≥ 20, opencode, a Signal account with a phone, and a terminal
  (spec, still assumed).
- Decision: keep the npm name `signal-connector` (2026-10-15). The registry returned 404 for it,
  and for `opencode-signal-connector` and `signal-connector-cli`; `opencode-signal` is taken by an
  unrelated package. No scope is needed.
- Decision: MIT license, public repository in this sprint (2026-10-15). Nothing in the code rules
  another licence in; MIT is the least friction for a tool others are asked to install, and
  `package.json` is `private: true` with no licence field today.
- Decision: Windows, macOS and Linux (2026-10-15). The code is already cross-platform except
  `secrets.ts`: `config.ts` falls back from APPDATA to `~/.config`, `spawnCommand.ts` has its win32
  branch and passes through elsewhere, `link.ts` branches on win32 and darwin.
- Decision: Java and signal-cli stay detected-and-fetched prerequisites, never bundled
  (2026-10-15). `install-signal-cli.ps1` already downloads signal-cli and `ensure-java.ps1`
  installs a JDK; no bundling machinery exists and vendoring a runtime contradicts the
  no-native-dependency constraint.
- Decision: the opencode plugin ships inside the main package, version-locked (2026-10-15).
  `plugins/signal-connector.ts` already lives in the repository and `start-all.ps1` copies it into
  the user plugins directory, so the package can carry it and entry 6 can install it.
- Waits on the user: nothing — the five open questions are answered; entry 10 can publish once the
  name is registered under the user's npm account.
- Parked: the six `in-review` tickets in `epic-signal-transport` and `epic-agent-adapter` are
  stale (their work is committed); they are not this epic's to close.
- Decision: at tag time "the suite" means the three-OS CI suite (entry 9). The install
  end-to-end suite (entry 12) is this epic's closing proof and gates the *next* tag, not the
  first one (2026-10-15).
- Decision: transitive `after` is enough for the Refactor sweep (2026-10-15). Entry 11 names the
  entries whose output it cleans (4, 5, 6, 7, 8, 10); the rest are reachable through them, and
  listing every predecessor would restate the build order.
- Decision: entry 5 owns `config.toml` (2026-10-15). Entry 4 resolves the signal-cli invocation
  and hands it over; one writer, as the single PowerShell script has today.
- Waits on the user: entry 10 needs the npm name and scope chosen and the LICENSE decided before
  it can publish; entry 4's scope still depends on whether Java may remain a prerequisite.
- Validated: the Set and Dependencies checks ran as an independent subagent on the draft
  (2026-10-15), not in this conversation. Findings merged: entry 5 gained the real prerequisite
  (`after = [3, 4]`, signal-cli comes from entry 4), entry 4 dropped the CAP-1 claim it does not
  deliver and stopped writing configuration, entry 3 now covers the daemon-refusal branch of
  Done when 3, entries 7 and 12 verify themselves without a linked account, and entry 10 names
  which suite must be green. Nothing contradicted the spec.
