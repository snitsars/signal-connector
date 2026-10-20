---
title: 'opencode plugin install and update step'
type: 'feature'
ticket: '6'
created: '2026-10-20'
status: 'built'
baseline_revision: '5fa2dc29dd108c1488d5f39d92dcb7a25a0fa0c4'
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

**Problem:** the package ships `plugins/signal-connector.ts`, but nothing puts it where opencode
looks for plugins, so a first run works only if the operator copies the file by hand — exactly what
the distribution spec forbids. A stale copy after an upgrade is silent, and a second copy inside a
project shadows the global one.

**Approach:** two commands and one setup step over the same helper. `plugin install` copies the
packaged file to `~/.config/opencode/plugins/signal-connector.ts` (creating the directory) and
prints the version it wrote; `plugin status` compares the installed bytes with the packaged ones and
prints `installed | stale | absent | conflict` plus the version; both take the package root and the
home directory as arguments so tests use temp dirs. A conflict is a copy under
`<cwd>/.opencode/plugins` with the same name: it is reported and never overwritten. The setup step
checks with the same comparison and applies the install.

## Boundaries & Constraints

**Always:** the packaged file and `package.json` are the source of truth (version from the
manifest, bytes from `plugins/`); install is idempotent and creates only the plugins directory;
status never writes; a conflicted project copy is named with its path and left alone; the commands
never start opencode, touch config or need the network; the plugin still works when copied by hand.

**Never:** no overwriting a project-local plugin, no deleting anything, no reading or writing the
service config, no new dependency, no `process.exit` inside the helpers (the CLI owns it).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Behavior | Error Handling |
|----------|--------------|-------------------|----------------|
| Fresh install | No plugins dir | Directory created, file written, version printed | FS error → message, exit 1 |
| Same version | Installed bytes equal package | `status: installed`, install is a no-op | — |
| After a bump | Installed bytes differ | `status: stale`; install replaces the file | — |
| Absent | No installed file | `status: absent`; install writes it | — |
| Project copy | `<cwd>/.opencode/plugins/signal-connector.ts` exists | `status: conflict`, path named; install refuses | Exit 1, nothing overwritten |
| Missing package file | `plugins/...` not found | Clear reason, exit 1 | No stack |

</frozen-after-approval>

## Code Map

- `src/cli/plugin.ts` -- new: `packageRoot()`, `pluginsDir(home)`, `projectPlugin(cwd)`,
  `pluginStatus({home,cwd,root})`, `installPlugin({home,cwd,root})`; pure helpers over `fs` with the
  paths injected.
- `src/cli/args.ts` -- `parseArgs` (27-36) understands `plugin install` and `plugin status` as a
  two-word command; `USAGE` lists them. Trailing garbage after them is usage, as with doctor/setup.
- `src/index.ts` -- the gate dispatches the plugin commands before any daemon import, prints the
  result and exits with the helper's code; the static graph stays tiny.
- `src/cli/setup.ts` -- a `plugin` step using the same status/install helpers, appended to the
  registry (check: installed; apply: install).
- `src/cli/plugin.test.ts`, `src/cli/args.test.ts`, `src/cli/setup.test.ts` -- temp home/cwd/root;
  fresh, same, stale, absent, conflict, missing source, idempotence.
- `README.md` -- one line under "Doctor and setup": `signal-connector plugin install` and
  `plugin status`.

## Tasks & Acceptance

**Execution:**
- [x] `src/cli/plugin.ts` -- status/install over injected paths; version from the packaged manifest;
  conflict detection and no-overwrite.
- [x] `src/cli/args.ts` -- the two-word `plugin` command with usage on trailing arguments.
- [x] `src/index.ts` -- dispatch and exit code without loading the daemon.
- [x] `src/cli/setup.ts` -- the plugin step; `registry()` appends it in order.
- [x] tests -- every matrix row, including a byte-identical install being a no-op.
- [x] `README.md` -- the two commands.

**Acceptance Criteria:**
- Given no plugins directory, when `plugin install` runs, then the file is there, the directory was
  created, and the printed version is the package version.
- Given the same version installed, when `status` runs, then it says `installed` and install changes
  nothing.
- Given a changed packaged file, when `status` runs, then it says `stale` and install replaces it.
- Given a project-local copy, then status says `conflict` with that path and install refuses.
- Given `setup`, then the plugin step installs it once and reports it satisfied on a second run.

## Implementation Notes

- `src/cli/plugin.ts` is the whole mechanism, pure over injected paths. `packageRoot()` is two
  levels up from the module, which is the same directory for `src/cli/plugin.ts` and
  `dist/cli/plugin.js`, so a checkout and a published package both find `package.json` and
  `plugins/`. `pluginsDir(home)` / `projectPlugin(cwd)` spell the two opencode locations once;
  `pluginStatus` reads the packaged bytes and compares them with `Buffer.equals`, so a hand-edited
  copy that kept the old banner is `stale`, not `installed`.
- `pluginStatus` throws exactly one reason when the package itself is broken (missing manifest or
  missing `plugins/signal-connector.ts`) — there is no state for that — and everything else is a
  state: `conflict` (project copy present, wins over `installed`), `installed`, `stale`, `absent`.
  It never creates the plugins directory just to look. `installPlugin` returns
  `{ code, message, status }` and never exits: conflict is a refusal, a failed `mkdir`/write is a
  message, and a byte-identical copy is left untouched (the test pins its mtime to epoch and proves
  it is not rewritten). `describeStatus` owns the one-line text the CLI prints.
- `plugin status` exits 0 only for `installed` and 1 otherwise, so it is usable in a script; the
  plan did not pin that code, and `install` keeps 0 for a no-op or a write and 1 for a refusal or an
  FS error. `src/index.ts` prints `describeStatus(...)`/`install.message` and exits with the
  helper's code; its `try`/`catch` turns a broken package into `fatal: <reason>` on stderr with exit
  1 and no stack.
- The entry's static graph grew by `node:os` and `./cli/plugin.js`; `src/index.test.ts` now locks
  those five imports and adds `src/cli/plugin.ts` to the sources it rebuilds for. The plugin branch
  sits before the daemon import, so none of this reaches config, the store or an adapter.
- `pluginStep` lives in `setup.ts` (where the Code Map puts it) and is appended last to
  `registry()`; its check is `pluginStatus`, its apply is `installPlugin`, so the step and the
  command cannot disagree. A conflict is reported as `failed`, not `missing`, deliberately:
  `runSetup` must not "repair" it, because the repair would delete the operator's file, so the run
  stops with the path in the fix. `absent` and `stale` are `missing`, which is what lets setup
  install and re-check.
- Consequence to be aware of: the daemon runs the same registry before it opens the store, so the
  plugin is now a preflight prerequisite on every start — including `agent.kind` values that do not
  use the plugin. That follows the plan (append to the registry) and matches CAP-3's "refuse with
  the same guidance", but it is a new refusal no gate in this story softens.
- Tests: `src/cli/plugin.test.ts` (19) covers every matrix row — fresh install, same version,
  after a bump, absent, project copy, missing package file, plus status being write-free, install
  creating only the plugins directory, the FS-error message, and the manifest version. `args.test.ts`
  covers the two-word command, an unknown subcommand, an incomplete one and trailing arguments;
  `setup.test.ts` covers registry order, the plugin step's four states, install-once-then-skip under
  `runSetup`, and a broken package reported as a failed step instead of a crash.
- Verified: `npm run typecheck` clean; `npm test` 532 tests / 40 files green (was 506 / 39);
  `npm run build` clean. On this machine `plugin status` said `installed 0.1.0`, `doctor` and
  `setup` both ended 0 with the plugin line; moving the installed file away gave `absent` + exit 1,
  `plugin install` wrote it back byte-identically and `status` returned `installed` + exit 0; a
  temp cwd with `.opencode/plugins/signal-connector.ts` gave `conflict` naming that path and
  `install` exited 1 leaving both copies and the global file untouched; renaming
  `plugins/signal-connector.ts` made both commands print one `fatal:` line and exit 1 with no stack.

## Plan Change Log

## Review Triage Log

## Design Notes

- **Why the paths are arguments:** a helper that reads `os.homedir()` and `process.cwd()` cannot be
  tested for a conflict without touching the real machine; the CLI passes them, tests pass temp dirs.
- **Why bytes, not a version stamp:** the packaged file is the truth; comparing bytes catches a
  hand-edited copy that still claims the old banner, and needs no metadata file.
- **Why refuse a project copy:** opencode loads both; two copies would double the bridge connection
  and confuse the operator, and silently deleting one would destroy their work.

## Verification

**Commands:**
- `npm run typecheck` -- expected: exits 0
- `npm test` -- expected: all suites pass
- `npm run build` -- expected: exits 0
- `node dist/index.js plugin status` -- expected: `installed` or `absent` on this machine
- `node dist/index.js plugin install` -- expected: writes to `~/.config/opencode/plugins`, prints the version

**Manual checks:**
- Move the installed file away, run status (absent), install, status (installed).
- Create `.opencode/plugins/signal-connector.ts` in a temp cwd and confirm conflict + refusal.
