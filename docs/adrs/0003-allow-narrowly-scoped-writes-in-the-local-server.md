---
type: adr
title: Allow narrowly scoped writes in the local server
description: Keep log analysis read-only while allowing an explicit, origin-checked set of local chat and suggestion-status writes.
tags: [architecture, backend, security]
timestamp: 2026-07-28
dirty: true
---

# Allow narrowly scoped writes in the local server

## Status

Accepted. Supersedes the read-only `server/` constraint in
[ADR 0002](0002-monorepo-with-pnpm-tanstack-and-node.md); the rest of ADR 0002
remains in force.

## Context

ADR 0002 made `server/` a read-only API over captured logs. The dashboard later
grew two capabilities that require local writes: running and controlling a
Claude Code chat session, and persisting a pending/done/skipped flag for a
session suggestion. Keeping those operations outside the server would duplicate
its in-memory chat lifecycle and its knowledge of the `LOG_DIR`-scoped status
store.

One chat POST can start an agent that runs commands in the checkout, so treating
the expanded server as an unrestricted application backend would make a
localhost convenience into a much larger security boundary.

## Decision

Keep analysis, transcript, config, and project-memory endpoints read-only.
Permit writes only through an explicit route allowlist:

- start, continue, stop, or end a dashboard chat session;
- update the status of session suggestions.

These POST routes use origin-checked CORS instead of the read endpoints'
wildcard CORS, while the server continues to bind to localhost by default.
Config-inventory endpoints remain GET-only and never write Claude settings or
shell configuration. The origin check limits which browser pages can drive the
write surface; it is not authentication, and deployments must add a real access
control boundary before exposing the server.

## Consequences

- The dashboard can own a full local agent-session lifecycle and persist
  suggestion decisions without a second service or duplicate store resolution.
- The server can no longer be described categorically as read-only; docs and
  security reviews must distinguish the small write allowlist from the analysis
  surface.
- Adding another write requires an explicit route decision and the stricter CORS
  path instead of silently inheriting the open read policy.
- Localhost remains the supported trust boundary. Origin checks reduce
  browser-driven cross-origin risk but do not protect a remotely exposed port.
