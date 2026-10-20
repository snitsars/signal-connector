---
title: 'Release: one tag, both artifacts'
type: 'feature'
ticket: '10'
created: '2026-10-21'
status: 'built'
baseline_revision: '7f263c722779f64f8b0398c295216de99a46cd7c'
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

**Problem:** there is no release path: the package can be packed by hand, but nothing ties a version
tag to the npm artifact and a GitHub release, so the two can drift and a bad tag can publish.

**Approach:** a tag-triggered GitHub Actions workflow that refuses a tag which does not match
`package.json`, runs typecheck, tests and build, packs, writes a SHA-256, publishes to npm with
provenance, and creates the GitHub release with the tarball and checksum.

## Boundaries & Constraints

**Always:** the tag is `v<version>` and must equal the manifest; tests and typecheck run before
publish; the release is created only after a successful publish; the checksum names the artifact;
the npm token is a repository secret and never printed; `gh` uses the job token.

**Never:** no publishing from a branch; no release without tests; no third-party action for the
GitHub release (`gh` is preinstalled); no secrets in logs.

</frozen-after-approval>

## Verification

- Workflow YAML is syntactically valid and the steps are ordered publish-after-tests.
- Local preflight: `npm run typecheck && npm test && npm pack` on this machine.
- hitl: needs an `NPM_TOKEN` and a pushed tag; the first real release is the check.
