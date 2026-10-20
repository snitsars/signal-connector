---
title: 'Refactor sweep'
type: 'refactor'
ticket: '11'
created: '2026-10-21'
status: 'built'
baseline_revision: '0b2730a3805c8ee8bc3a5f3b72d5e8220162f267'
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

**Problem:** the distribution stories each added a CLI helper and every one copied the same
"collapse an error to one line" function — six copies with two behaviours (some fall back to
"unknown error", some do not), which is how a future fix lands in one place only.

**Approach:** one `src/oneLine.ts` used by the config loader and all five CLI modules; the stronger
behaviour (any value, one line, never empty) is the single contract. No other behaviour changes.

## Boundaries & Constraints

**Always:** one definition, imported everywhere; the report stays one line and an empty message
still says "unknown error"; no public API or output format change beyond that fallback.

**Never:** no drive-by renames, no formatting churn, no dependency.

</frozen-after-approval>

## Verification

- `npm run typecheck` -- exits 0
- `npm test` -- 605 pass, 2 POSIX-only skips
- `node dist/index.js doctor` -- nine ok lines, exit 0
