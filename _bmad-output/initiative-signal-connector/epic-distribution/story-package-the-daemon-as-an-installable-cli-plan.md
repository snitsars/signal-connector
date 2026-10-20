---
title: 'Package the daemon as an installable CLI'
type: 'chore'
ticket: '1'
created: '2026-10-15'
status: done
baseline_revision: '2d08ac36a41e648448da9adb8d76493440088757'
route: 'oneshot'
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

**Problem:** The package cannot be installed by anyone but its author. `package.json` is
`private: true` with no `license`, `files` or `repository`, so nothing can be published, and a
tarball built from it would omit `dist/` (gitignored, no `files` field) — the command would not
exist. There is also nothing to run but the daemon: `dist/index.js` has no shebang and no
argument handling, so `--version`/`--help` are impossible and the first thing a stranger types
after installing fails.

**Approach:** Make the package publishable and the command usable without touching how the
daemon runs. Add the manifest fields a stranger needs, a `files` list that ships exactly `dist/`
and the opencode plugin, an MIT `LICENSE`, a shebang on the entry point, and a small argument
parser in front of `main()` so `--version` and `--help` print and exit before any store, daemon,
bridge or agent is created. Running with no arguments keeps starting the daemon exactly as today.

</frozen-after-approval>

## Implementation Notes

Oneshot because the change is ~91 lines across five files, all mechanical: a guard and a pure
parser in front of an existing entry point, plus manifest fields and a licence file. No new
dependency, no new module boundary, and nothing for a coding subagent to discover that the
investigation did not already settle.

- `src/index.ts` — add the `#!/usr/bin/env node` shebang (tsc preserves it into `dist/`) and gate
  the existing `main()` call on the parsed arguments. Everything that touches the store, the
  signal-cli daemon, the bridge or the agent lives inside `main()`, so exiting before that call
  is enough.
- `src/cli/args.ts` — new, pure: turn `process.argv.slice(2)` into `{ mode }` where mode is
  `daemon` (no arguments), `version`, `help`, or `usage` (an unknown flag). Keep it dependency-free
  and testable; `src/cli/dryRun.ts:190` shows the house style of reading argv directly.
- `src/cli/args.test.ts` — colocated, picked up by `vitest.config.ts:5` and excluded from the build
  by `tsconfig.json`'s `exclude`.
- `package.json` — `private: false`, add `license`, `keywords`, `files: ["dist", "plugins"]`,
  and a `prepublishOnly` that builds and tests. `bin` already points at `./dist/index.js` and stays.
  No `main`/`exports`: nothing imports this package (verified by grep), it is a CLI.
- `LICENSE` — MIT, holder `snitsars` (the repository's git identity).
- Deliberately not touched: `dev`, `start`, `link`, `dry` scripts (the Windows scripts in
  `scripts/` call the first two), and `stop.ps1:21`, which matches the literal `src/index.ts` /
  `dist/index.js` command lines.

- Also changed while implementing: `print()` writes with `fs.writeSync` rather than
  `process.stdout.write`, because the process exits immediately after and a piped stdout would be
  truncated by `process.exit`; only the first argument is significant, so a stray argument is a
  usage error instead of being ignored.
- Four review findings were patched: the usage text no longer promises a README that does not
  describe the installed command, `-v`/`-h` are documented, `prepack` builds before packing so
  `npm pack` cannot ship a tarball without `dist/`, and `src/index.ts` regained its trailing
  newline. The two findings that needed a product decision — the Node floor and the repository
  URL — were raised to the human and both answered: floor 22.13, repository created.
- Verified after the decisions: `engines.node` `>=22.13.0`; a fresh tarball installed into an empty
  prefix prints `0.1.0` from its own binary, ships `dist/` and the plugin, leaks no `src/`, and
  installs 34 packages with no install-script prompt. `npm test` is 154 passed in 16 files and
  `npm run typecheck` is clean.

## Review Triage Log

Quick lens, 7 findings; every claim checked in the repository before judging.

- `--version` could not work on the Node 20 the manifest advertised — **verified, `high`, patched.**
  `src/store/sqliteDriver.ts:26` requires `node:sqlite` at module scope, `src/store/store.ts:6`
  imports it, and `src/index.ts:22` imports the store statically, so the module graph throws before
  the new argument gate is reached; `node:sqlite` does not exist before Node 22.5 and is unflagged
  only from 22.13/23.4 (nodejs/node#55890), and the daemon needs SQLite too, so Node 20 can run
  none of the product. A lazily loaded store would only rescue `--version` and leave the false floor
  standing. Raised to the human, who chose the honest floor: `engines.node` is now `>= 22.13.0`, and
  the spec constraint and success signal were corrected from 20 to 22.13. `AGENTS.md` still says 20
  and is recorded in `deferred-work.md` rather than edited here.
- `repository` was missing although entry 1 and the plan's Intent name it — **verified, `high`,
  patched.** There was no git remote, so any URL would have been invented. Raised to the human, who
  chose to create it: `github.com/snitsars/signal-connector` (public, `origin` set, nothing pushed),
  and the manifest carries `repository` and `bugs`.
- The usage text promised a README that does not describe the installed command — **verified,
  patched.** The tarball ships `README.md`, but its steps are clone-only (`npm run dry` needs `tsx`
  and `src/`, both excluded by `files`; `scripts/` does not ship), so the clause was false as
  shipped. Removed; the remaining lines are all true of the installed package.
- `prepublishOnly` never runs for `npm pack`, which is entry 1's own verification command —
  **verified, patched.** Reproduced in a tree without `dist/`: `npm pack` shipped three files and no
  `bin` target. A build hook was added and re-verified twice: with `dist/` deleted, `npm pack
  --dry-run` rebuilds it and lists `dist/index.js`. It is `prepack`, not `prepare`, because npm 11
  warns that `prepare` carries install scripts and blocks them — installing the published tarball
  must not prompt a stranger about scripts. `prepublishOnly: npm test` still gates publish.
- The shipped plugin registers `version: "0.2.1"` while the package is `0.1.0` — **`low`, rejected.**
  Verified: the field is optional in `src/bridge/protocol.ts:19` and no consumer reads it, so nothing
  a user can see changes. Reconciling it belongs to entry 6.6, which owns the version-locking the
  spec asks for; tying the literal to the manifest here would need plugin-side manifest reading —
  more than a simple correction, for an unread field.
- `-v`/`-h` were accepted but undocumented — **`low`, patched.** Both now appear in `USAGE` alongside
  the long forms.
- The change dropped the trailing newline of `src/index.ts` — **`low`, patched.** Verified byte:
  the file ended `}` (125) and ends `\n` (10).

## Verification

**Commands:**
- `npm run typecheck` — expected: exits 0
- `npm test` — expected: all suites pass, including the new `src/cli/args.test.ts`
- `npm run build` — expected: exits 0 and `dist/index.js` starts with `#!/usr/bin/env node`
- `head -1 dist/index.js` — expected: the shebang line
- `node dist/index.js --version` — expected: prints `0.1.0` and exits 0 without starting anything
- `node dist/index.js --help` — expected: prints usage naming `signal-connector` and exits 0
- `node dist/index.js --nope` — expected: prints usage to stderr and exits non-zero
- `npm pack --dry-run` — expected: the file list contains `dist/**`, `plugins/signal-connector.ts`,
  `package.json`, `README.md` and `LICENSE`, and contains no `src/`, `node_modules/`, `_bmad-output/`
  or test files
- `npm pack` then install the tarball into a throwaway prefix and run its binary —
  expected: `--version` prints `0.1.0`

**Manual checks (if no CLI):**
- The running service is started by `npm run dev` (`tsx src/index.ts`); after the change, confirm
  that script is untouched and that `node dist/index.js` with no arguments still reaches `main()`.
