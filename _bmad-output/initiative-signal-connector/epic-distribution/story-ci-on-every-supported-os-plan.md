---
title: 'CI on every supported OS'
type: 'feature'
ticket: '9'
created: '2026-10-21'
status: 'built'
baseline_revision: 'e422f9501566753773e2619b7dd40ae03f9a21a3'
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

**Problem:** the cross-platform claim is only asserted; nothing runs the suite anywhere but this
Windows machine, and the POSIX-only secret tests are skipped locally.

**Approach:** a GitHub Actions workflow on every push and pull request with a
Windows/macOS/Linux × Node 22.13/24 matrix that installs with `npm ci`, type-checks, tests, builds
and asks the CLI for its version.

## Boundaries & Constraints

**Always:** the matrix includes the declared floor (22.13) and a current LTS; `fail-fast: false` so
one OS failing still reports the others; npm cache; no secrets are needed by these jobs; the job
names carry OS and Node so a failure is obvious.

**Never:** no deployment, publishing or secret usage in this workflow (6.10 owns releases); no
`npm install` without a lockfile; no platform-specific steps that would hide a real failure.

</frozen-after-approval>

## Verification

- `.github/workflows/ci.yml` parses as YAML and lists the six combinations.
- Local equivalent: `npm ci && npm run typecheck && npm test && npm run build` on this machine.
- hitl: the first push shows six green jobs; it cannot run before the repository is pushed.
