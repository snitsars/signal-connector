# Deferred work

Recorded by build runs; not planned, not lost.

- source_plan: `_bmad-output/initiative-signal-connector/epic-distribution/story-package-the-daemon-as-an-installable-cli-plan.md`
  summary: AGENTS.md still states this repository's Node floor as "Node ≥ 20", which building entry 1 proved false.
  evidence: `package.json` now declares `engines.node >= 22.13.0` and `src/store/sqliteDriver.ts:26` requires `node:sqlite` at module scope, so the code cannot run below 22.13. The build workflow treats the agent-instruction block as the human's, so the line was left for its owner to correct.
