---
id: SPEC-distribution
companions: [install-paths.md]
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Distribute SignalConnector so a stranger can install it

## Why

**A pain to solve.** SignalConnector works, but only for the person who built it: installing it means cloning the repository, running PowerShell scripts, downloading signal-cli by hand, editing `config.toml`, and copying the opencode plugin into a global folder. Every new user pays that cost, and a large part of it is Windows-only (`secrets.ts` persists through DPAPI via `powershell.exe`; the whole install path is `.ps1`). The project's value is proportional to how cheaply someone else can start using it — a bridge nobody can install has no users.

## Capabilities

- **CAP-1**
  - **intent:** A person with no repository clone can install the connector from a published artifact — the npm package or the GitHub release zip — and get a runnable `signal-connector` command.
  - **success:** On a machine with only Node ≥ 22.13 installed, `npx <package> --version` and, from the unzipped release, `npm install -g .` both yield the same version without network access to the repository.

- **CAP-2**
  - **intent:** A guided first run takes a newcomer from install to a working bridge without editing any file by hand: prerequisites are checked, the Signal device is linked by QR in the terminal, a valid configuration is written, the opencode plugin is installed, and the loop is proven by one real message.
  - **success:** On a clean machine with a Signal account and opencode, following only `signal-connector setup` (no manual edit) ends with a numbered command in Signal producing a reply in the configured channel.

- **CAP-3**
  - **intent:** A newcomer can find out what is missing and how to fix it, instead of failing later mid-run.
  - **success:** With Java, signal-cli or opencode absent, the diagnostic reports each missing prerequisite, where to obtain it, and the exact command to run; the daemon refuses to start with the same guidance rather than crashing after linking.

- **CAP-4**
  - **intent:** The normal install and run path works on Windows, macOS and Linux.
  - **success:** Installing and completing a first run succeeds on macOS and Linux without PowerShell, and linked credentials survive a restart on all three platforms.

- **CAP-5**
  - **intent:** Installing and updating the opencode plugin is a command of the product, not a manual copy.
  - **success:** One command installs or refreshes the plugin in the opencode plugins directory and prints the version it installed; that version equals the package version.

- **CAP-6**
  - **intent:** A release is reproducible from one version tag: both artifacts come from the same commit, with the test suite green on every supported OS.
  - **success:** Tagging a version produces the npm package and the GitHub zip without manual steps, and both are built from that tag's commit by a green pipeline.

## Constraints

- Node ≥ 22.13, and no native build dependency anywhere on the install path. The floor is set by the
  store, not by taste: `src/store/sqliteDriver.ts:26` requires `node:sqlite` at module scope and
  `src/index.ts` imports the store, so older runtimes fail before the CLI can answer anything. The
  module exists from 22.5.0 and is unflagged from 22.13.0/23.4.0 (nodejs/node#55890).
- Signal access stays a *linked secondary device*: the operator scans a QR with their own phone. There is no bot number and no API-token route.
- Java and signal-cli stay external prerequisites, detected and fetched per platform, never bundled or vendored — the pattern `install-signal-cli.ps1` and `ensure-java.ps1` already establish.
- The package publishes as `signal-connector` from a public repository under the **MIT** license. The name is free on the public registry and `package.json` is `private: true` with no license today, so both change.
- The opencode plugin ships inside the same package, version-locked to it.
- Existing architecture holds: `core/` imports no adapter, one SQLite database is the single source of runtime state, secrets never appear in the repository or a log line.
- The Windows path that works today must not regress while the cross-platform path is added.
- A published artifact must carry a license and a description good enough for a stranger to judge it.

## Non-goals

- No hosted service, cloud relay or account system: everything runs on the operator's machine.
- No GUI, tray application or OS service packaging.
- No agent adapter other than opencode.
- No distribution channel beyond npm and the GitHub release zip (no Homebrew, Chocolatey, winget, Docker, Snap).
- No multi-user, team, or multi-tenant features.

## Success signal

A person who has never seen this repository goes from nothing to sending `/projects` in Signal and getting a reply, on Windows, macOS or Linux, in well under an hour, using only published documentation and release artifacts — and repeats it on a second clean machine without consulting the author.

## Assumptions

- The newcomer has Node ≥ 22.13, an opencode installation, a Signal account with a phone for linking, and is willing to use a terminal.
