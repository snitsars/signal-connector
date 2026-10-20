---
title: 'The gate that refuses before it joins'
type: 'feature'
ticket: '2'
created: '2026-10-17'
status: done
baseline_revision: '41dc0c315f25aea69e30441f883ca93a0292425c'
route: 'full'
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

**Problem:** story 7.1 accepts any link typed by anyone in a project's group and opens a browser
on it. The spec's gate must decide *before* anything joins: only accepted identities, only a
well-formed https room link from the configured provider, only a reachable room — and it must
refuse with named reasons that never echo the link. Today `sender` is a phone number on one
delivery path and the channel id on the other, so no single identity rule can be applied.

**Approach:** mark each inbound message with its delivery path and uuid, add a per-project
list of accepted identities in config (empty = fail-closed), and put the decision in a pure
core gate: resolve identity, parse the link, probe it briefly, then take the meeting slot with
the store's existing single write (the unique index is the final arbiter). Every refusal names
its category; nothing reaches the browser before the gate passes.

## Boundaries & Constraints

**Always:** fail-closed — an empty list refuses everyone; the gate runs before availability,
before the claim and before any browser; the claim stays one write, decided by the store's
partial unique index; a sync-delivery message is the operator's own linked device by
construction, a data-delivery one must match the configured identity; the link never appears
in a refusal, a log line or a group message; every refusal is one named category.

**Never:** no room creation, provider API or OAuth; no ACI/uuid database lookups — the identity
comes only from the envelope; no retries or polling on the probe; no change to the meeting
adapter; no per-project store table for identities (config carries them); no acceptance of a
link that is quoted from someone else's message.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Behavior | Error Handling |
|----------|--------------|-------------------|----------------|
| Operator pastes | sync delivery, link in the project's group | Gate passes, slot claimed, browser opens | — |
| Stranger pastes | data delivery, sender not configured | Refused "not authorised", naming the sender; no claim, no browser | The refusal never quotes the link |
| Empty allow-list | any paste | Refused "no accepted identities are configured for `<project>`" | Fail-closed, not open |
| Revoked entry | an entry whose `revokedAt` is past | Refused as not authorised | — |
| Malformed link | not `https`, no host | Refused "malformed link" | No claim |
| Foreign provider | host not the configured one | Refused "not the configured meeting provider" | No claim |
| Unreachable room | probe fails or times out | Refused "could not reach the room" | No claim; one bounded probe |
| Slot taken | another meeting open | Refused "already running under `<project>`, started …" | The store's index decides, not a read |
| Same link again | the open meeting's link | The same "already running" refusal | No second join |

</frozen-after-approval>

## Code Map

- `src/domain/types.ts` -- `IncomingMessage` (79-90) gains `delivery: "data" | "sync"` and
  `senderUuid?: string`; every construction site in tests must pass `delivery`.
- `src/adapters/signal/signalCliClient.ts` -- the data branch (387-422) sets `delivery: "data"`
  and `senderUuid` from the envelope; the sync branch (424-466) sets `delivery: "sync"` (its
  sender is the channel by construction); `Envelope` (50-71) gains `sourceUuid?: string`;
  keep the `/meet` log redaction added in 7.1.
- `src/config/config.ts` -- the project object (52-78) gains
  `meet?: { allow?: Array<{ id: string; label?: string; revokedAt?: string }> }`, default
  empty; `scripts/config.example.toml` and the README's `[[projects]]` section document it.
- `src/core/gate.ts` -- new, pure: `decidePaste({ delivery, sender, senderUuid, allow, text,
  providerHosts })` → `{ ok: true; link: URL } | { ok: false; category; detail }`, with the
  categories as a closed union; no fetch, no store, no logger.
- `src/core/app.ts` -- `meetCommand` (566-657): call the gate first and reply with its category;
  then `available()`, then the claim; log only the category, never the text.
- `src/store/store.ts` -- unchanged; the claim's partial unique index (`meetings_one_open`,
  54-55) already forces the failed write, so the gate needs no new store method.
- Tests: `src/core/gate.test.ts` (new, the whole matrix), `src/core/app.test.ts` (the refusal
  paths and that nothing joins), `src/adapters/signal/signalCliClient.test.ts` (delivery and
  uuid on both paths), `src/config/config.test.ts` (new, the default and a configured list).

## Tasks & Acceptance

**Execution:**
- [x] `src/domain/types.ts` -- add `delivery` and `senderUuid` to `IncomingMessage`; make
  `delivery` required so no site forgets it -- the gate's first input.
- [x] `src/adapters/signal/signalCliClient.ts` -- set both fields in the two branches and read
  `sourceUuid` from the envelope -- the only place that knows how a message arrived.
- [x] `src/config/config.ts` -- the per-project `meet.allow` list, optional and defaulting to
  empty -- an unset list must refuse, not accept.
- [x] `scripts/config.example.toml` and `README.md` -- document the key beside `session` and
  `launch` -- the operator must be able to find it.
- [x] `src/core/gate.ts` -- the pure decision: identity (uuid when both sides have one, else the
  number, honouring `revokedAt`), canonical https parse, provider host list, and the closed
  refusal categories; a probe is *not* here -- one pure function, fully testable.
- [x] `src/core/app.ts` -- run the gate before anything else in `meetCommand`, reply with its
  category, and add one bounded reachability probe (fetch with `AbortSignal.timeout(3000)`,
  no retries) whose failure is the "could not reach the room" refusal -- the only I/O in the
  gate, kept out of the pure module.
- [x] `src/core/gate.test.ts` and the touched suites -- every matrix row as its own case, plus
  the app-level check that a refused paste claims no row and never calls the port -- proof
  without Signal or a browser.

**Acceptance Criteria:**
- Given a project with `meet.allow` listing the operator, when the operator pastes a link in that
  project's group, then the link passes the gate, the slot is claimed and the port joins.
- Given the same project, when a group member who is not listed pastes a link, then the refusal
  names "not authorised" and the sender, and no row is written, the port is never called and no
  browser opens.
- Given a project with no `meet.allow`, when any link is pasted, then it is refused for having no
  accepted identities — never accepted by default.
- Given an entry whose `revokedAt` has passed, when that identity pastes, then it is refused as
  not authorised.
- Given a malformed link, a link to another provider, or an unreachable room, then each is
  refused with its own category, no row is written and nothing joins.
- Given an open meeting, when the same or another link is pasted, then the refusal names the
  holding project and its start time, decided by the store's write, not by a read.
- Given any refusal, when the group message and the log are inspected, then neither contains the
  link.

## Implementation Notes

- `src/core/gate.ts` is the whole pure decision: `decidePaste` returns either the parsed
  `URL` or one closed refusal category (`no-identities`, `not-authorised`,
  `malformed-link`, `foreign-provider`, plus `unreachable-room` for the app's probe). It
  holds the identity rule (uuid first, number second; the sync path trusted by
  construction), the canonical https parse (no embedded credentials), the provider host
  match and `revokedAt`. No store, logger or network import.
- `meetCommand` order is: gate → port present → one bounded probe
  (`fetch` + `AbortSignal.timeout(3000)`, no retries) → `available()` → the single claim
  write. The old open-meeting pre-read was removed: the slot is decided by the partial
  unique index's failed write, and the catch still names the holder.
- The probe is injected through `CoreDeps.probeRoom` (production uses the fetch above) so
  the app tests prove every path with no network. `app.test.ts` passes a fake that returns
  true, or false for the unreachable case.
- The link stays out of every refusal and log line: `meetCommand` logs only the refusal
  category, and `handleMessage`'s debug line still redacts a `/meet` argument.
- No provider host is baked in: the default list is empty and a project names its
  accepted hosts with `meet.providers`, so an unconfigured project refuses every host.

## Plan Change Log

- `2026-10-17`: added `meet.providers?: string[]` beside `meet.allow`. The plan gave the
  gate's `providerHosts` as an input but never said where the app gets it, while the matrix
  says "host not the **configured** one". No provider is baked in: the project names its
  hosts, and an unconfigured project refuses every paste as a foreign provider.
  `meet.allow` is unchanged and still defaults to empty (fail-closed).

## Review Triage Log

Quick lens, 8 findings, plus 2 found while reading the diff myself. No intent gap and no plan
fault: everything real is a patch, and one is rejected as out of scope.

- **uuid-first is not implemented; list order decides** — `high`, patch. Verified in
  `resolveIdentity`: the loop breaks on `byUuid || byNumber`, so an earlier number entry beats a
  later uuid one — a revoked uuid entry is bypassed when a live number entry precedes it, and a
  live uuid entry is ignored when a revoked number precedes it. The two tests named for the rule
  miss it (`gate.test.ts:21-27` asserts only `ok`, `49-52` has no number entry to fall back to).
  Fix: resolve uuid matches across the whole list before considering numbers, and add both order
  cases.
- **An unparseable `revokedAt` fails open** — `medium`, patch. Verified: the schema accepts any
  string and `Date.parse` returns NaN, so the entry never counts as retired. Fix: an unparseable
  value counts as revoked.
- **The probe follows redirects to any host and leaves the body open** — `medium`, patch.
  Verified: `fetchRoom` passes `redirect: "follow"` and never re-checks `response.url`, so a 3xx
  from an allow-listed host makes the connector fetch an address the gate refused; the discarded
  body also holds a socket. Fix: `redirect: "manual"` with a 3xx counted as reachable, and cancel
  the body.
- **Two planned cases have no test** — `low`, patch. Verified: the matrix's "same link again" is
  exercised only with a *different* link (`app.test.ts:932-949`), and `FakeMeeting` has no counter
  for `available()`, so "never calls the port" is not asserted. Fix: add the same-link case and an
  `availableCalls` counter with an assertion.
- **The shipped examples identify the operator by a recyclable number** — `low`, patch. Verified:
  README and `scripts/config.example.toml` both show `id = "+1000"`, so no example exercises the
  uuid branch the design prefers. Fix: one sentence — the number works today, a uuid entry is
  honoured when known.
- **core now performs outbound I/O** — `low`, rejected as out of scope. The spine forbids core
  *importing adapters*, which holds; the frozen intent explicitly places the bounded probe in
  `meetCommand`. A port-based probe is a later option, not a defect to fix here.
- **An unreachable paste while a meeting is open reports the wrong refusal** — `low`, patch.
  Verified by reading `meetCommand`: the gate and probe run before anything looks at the open
  meeting, so that combination is refused as unreachable where the matrix's Slot-taken row expects
  "already running under <project>". Fix: read the open meeting between the gate and the probe —
  the write still decides the race.
- **`PROVIDER_HOSTS` accepts Jitsi by default** — `low`, patch. Verified: the default list is
  `["meet.jit.si", "meet.google.com"]`, while the spec's non-goals exclude platforms other than
  the one this adapter is written for. Fix: default to the configured provider only, keeping
  `meet.providers` as the override.

## Design Notes

- **Why a delivery marker:** on the sync path `sender` is the channel (the operator's own linked
  device by construction), on the data path it is a phone number. One rule cannot cover both, and
  inferring the path from the value is a guess that breaks on a group id shaped like a number.
- **Why config and not the store:** the spec asks for a configured list, one entry per project,
  never a directory; config is where the operator already edits projects, and an absent key is
  naturally fail-closed.
- **Why uuid first, number second:** signal-cli's envelope carries `sourceUuid`, and numbers are
  recyclable; the number stays as the label so a refusal can name someone recognisable.
- **Why the probe is only reachability:** this spec has no provider API, so an ended room cannot
  be told from a live one by fetching it; a failed fetch or timeout still rules out the mistyped
  and unreachable cases, and "the room ended" keeps being the adapter's job after joining.
- **Why the gate is pure:** the identity, parse and category rules are the fiddly part and must
  be testable without Signal, a browser or a network; only the single probe touches I/O.

## Verification

**Commands:**
- `npm run typecheck` -- expected: exits 0
- `npm test` -- expected: all suites pass, including the new gate and config tests and the
  updated client tests
- `npm run build` -- expected: exits 0

**Manual checks:**
- Paste a link from a phone number that is not in `meet.allow`: the group gets "not authorised"
  naming the sender, and no browser opens.
- Paste a Zoom link and a piece of junk: each gets its own category, and nothing joins.
- Paste the same link twice: the second is refused with the holding project and its start time.
