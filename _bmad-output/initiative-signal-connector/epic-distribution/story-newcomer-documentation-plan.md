---
title: 'Newcomer documentation'
type: 'docs'
ticket: '8'
created: '2026-10-21'
status: 'built'
baseline_revision: '700796cc52c8b3a47513cbc2c8559035bfd0e992'
route: 'quick'
route_source: 'auto'
risk: 'low'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/AGENTS.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** the README grew story by story: a newcomer meets the dry run first, then a doctor
section, then a long integration chapter, and nowhere a single path from "nothing installed" to "a
Signal reply".

**Approach:** a Quick start near the top (prerequisites with why and the exact fix, Windows and
POSIX commands, the first `/open` and `/task`), a Troubleshooting table keyed to the lines `doctor`
prints, upgrade and uninstall steps, and pointers to where secrets live. Existing reference
material stays below.

## Boundaries & Constraints

**Always:** every command in the new sections exists in this repository or in the published package
and works as written; no claim about a published npm package that does not exist yet (the install
line names the local checkout); secret locations are named, never values; the Windows and POSIX
paths are both spelled.

**Never:** no rewrite of the reference chapters, no screenshot placeholders, no invented flags.

</frozen-after-approval>

## Verification

- `npm test` -- expected: unchanged, docs only
- manual: every command in Quick start, Troubleshooting and Upgrade exists (`node dist/index.js
  doctor|setup|plugin install`, `scripts/ensure-java.ps1`, `scripts/install-signal-cli.ps1`,
  `scripts/stop.ps1`)
