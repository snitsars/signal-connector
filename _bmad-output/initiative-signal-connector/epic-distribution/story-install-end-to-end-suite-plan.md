---
title: 'Install end-to-end suite'
type: 'test'
ticket: '12'
created: '2026-10-21'
status: done
baseline_revision: 'b18f9d6ab7fa3cc22a02378987f24d5e59375ee1'
route: 'quick'
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

**Problem:** every test runs from the checkout with `tsx`, so nothing proves that `npm pack` ships
what the CLI needs (`files`, `bin`, the plugin) or that the installed entry behaves like the source.

**Approach:** a suite in `tests/` that packs the package, installs the tarball into a temp prefix
with its own temp HOME/APPDATA, and drives the installed CLI: `--version` matches the manifest,
`doctor` reports the missing config and creates nothing, `plugin status` is absent then `install`
writes the packaged file and a second install is a no-op, and `setup --help` is rejected. No real
data directory or plugin folder is touched; the pack/install is done once.

## Boundaries & Constraints

**Always:** temp HOME, APPDATA and XDG_CONFIG_HOME; one pack and one install for the whole file;
network only for the package's own dependencies; cleanup removes the workspace; only the installed
entry is executed (never the checkout); assertions are on exit codes and output, not timing.

**Never:** no writing to the real `~/.config/opencode`, no device linking, no real Signal account,
no `doctor` success requirement (CI has no Java/signal-cli).

</frozen-after-approval>

## Verification

- `npx vitest run tests/install.e2e.test.ts` -- 4 pass in ~23 s on this machine.
- `npm test` -- includes it and stays green.
