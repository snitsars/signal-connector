# Deferred work

Recorded by build runs; not planned, not lost.

- source_plan: `_bmad-output/initiative-signal-connector/epic-distribution/story-package-the-daemon-as-an-installable-cli-plan.md`
  summary: AGENTS.md still states this repository's Node floor as "Node ≥ 20", which building entry 1 proved false.
  evidence: `package.json` now declares `engines.node >= 22.13.0` and `src/store/sqliteDriver.ts:26` requires `node:sqlite` at module scope, so the code cannot run below 22.13. The build workflow treats the agent-instruction block as the human's, so the line was left for its owner to correct.

- source_plan: `_bmad-output/initiative-signal-connector/epic-avatar-meeting/story-the-gate-that-refuses-before-it-joins-plan.md`
  summary: The gate plan's review triage header claims ten findings (8 from the lens plus 2 self-found) but records only eight, so two may be unaccounted for.
  evidence: The file holds eight bullets and was added whole in `7111135` with no later version, so the missing findings cannot be reconstructed. A fresh review of `src/core/gate.ts` and the `/meet` command path is what would settle whether they were real.
