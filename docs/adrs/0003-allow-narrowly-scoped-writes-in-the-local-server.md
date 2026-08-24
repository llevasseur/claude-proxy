---
type: adr
title: Allow narrowly scoped writes in the local server
description: Keep log analysis read-only while allowing an explicit, origin-checked set of local chat and suggestion-status writes.
tags: [architecture, backend, security]
timestamp: 2026-07-28
scope: claude
provenance:
  - repo: claude-proxy
    number: "0003"
    file: docs/adrs/0003-allow-narrowly-scoped-writes-in-the-local-server.md
ratified: true
needs-human: false
---

# Allow narrowly scoped writes in the local server

## Status

Accepted. Supersedes the read-only `server/` constraint in
[ADR 0002](0002-monorepo-with-pnpm-tanstack-and-node.md); the rest of ADR 0002
remains in force.

## Context

ADR 0002 made `server/` a read-only API over captured logs. The dashboard later
added two required writes: running and controlling Claude Code chat sessions,
and persisting pending/done/skipped suggestion flags. Moving them elsewhere
would duplicate the server's in-memory chat lifecycle and knowledge of the
`LOG_DIR`-scoped status store.

One chat POST can start an agent that runs commands in the checkout, so treating
the expanded server as unrestricted would make a localhost convenience a much
larger security boundary.

## Decision

Keep analysis, transcript, config, and project-memory endpoints read-only.
Permit writes only through an explicit route allowlist:

- start, continue, stop, or end a dashboard chat session;
- update the status of session suggestions.

These POST routes use origin-checked CORS instead of the read endpoints'
wildcard CORS. The server still binds to localhost by default; config-inventory
endpoints remain GET-only and never write Claude settings or shell
configuration. Origin checks limit which browser pages can drive writes but are
not authentication: deployments must add access control before exposure.

## Consequences

- The dashboard owns the local agent-session lifecycle and suggestion decisions
  without a second service or duplicate store resolution.
- The server can no longer be described categorically as read-only; docs and
  security reviews must distinguish the small write allowlist from the analysis
  surface.
- Adding another write requires an explicit route decision and the stricter CORS
  path, not the open read policy.
- Localhost remains the trust boundary. Origin checks reduce browser-driven
  cross-origin risk but do not protect a remotely exposed port.

## Provenance

Native to `claude-proxy`, this repository's own corpus. It kept its number through the
`monorepo-fusion` merge because the claude block sorts first by timestamp and its numbering
was already dense. See [the legacy map](legacy-map.md) for how every inherited identifier
resolves.
