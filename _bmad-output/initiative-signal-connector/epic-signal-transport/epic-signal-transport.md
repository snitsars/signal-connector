---
tracker_id: ""
key: ""
type: epic
title: "Signal transport and channel"
parent: initiative-signal-connector
covers: [TC1, TC2, TC3, TC4, TC5, TC6, TC7]
after: []
assignee: ""
risk: high
---

# Signal transport and channel

## Description

Owns the Signal boundary: manage a local `signal-cli` JSON-RPC daemon, link as a secondary device
to the operator's number, receive messages, send/edit/attach, restrict to one channel, reconnect,
and rate-limit outbound sends. Implements `SignalPort`.

## Outcome

The service is reachable from the operator's phone: a message to Note-to-Self arrives in the
service, and the service can reply, edit that reply in place, and attach a file.

## Requirements

- TC1: connect to a managed signal-cli JSON-RPC daemon; link as a secondary device via QR.
- TC2: receive messages near real time; persist them.
- TC3: send text and edit a sent message in place.
- TC4: send attachments.
- TC5: restrict to one configured channel (Note-to-Self by default).
- TC6: reconnect after daemon restart.
- TC7: conservative outbound rate limit; never broadcast.

## Done when

1. The service links via QR and shows as a linked device; a Note-to-Self message reaches it.
2. A reply is sent, then edited in place, and the edit is visible on the phone.
3. A file attachment is delivered to the phone.
4. Killing the daemon and restarting it recovers without operator action.
5. Messages outside the configured channel are ignored.

## Boundaries

The Signal transport only. Not command interpretation (epic-command-router), not agent control
(epic-agent-adapter). Uses signal-cli as the protocol implementation; does not implement Signal.

## References

- architecture — _bmad-output/initiative-signal-connector/architecture-signal-connector/architecture-signal-connector.md, AD-4, AD-7
- prd — _bmad-output/initiative-signal-connector/prd-signal-connector/prd-signal-connector.md, section Transport & Channel

## Notes

- Decision: signal-cli JSON-RPC over a locally managed daemon; no signald (2026-10-11).
- Unknown: exact JSON-RPC method names/params for v0.14.x; confirm against the daemon's docs during entry 2.
- Constraint: signal-cli must be kept current against Signal-Server.
