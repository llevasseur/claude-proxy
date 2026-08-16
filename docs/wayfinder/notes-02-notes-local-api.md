---
type: ticket
id: "02"
title: Notes local API bridge
description: Proxy hosted Notes through the local server without exposing operator credentials to the browser.
timestamp: 2026-08-16
map: wayfinder-notes
labels: ["wayfinder:task"]
assignee: null
blockedBy: ["01"]
status: open
branch: task/notes-02-notes-local-api
lane: core-server
---

# Notes local API bridge

## Objective

Give the dashboard a typed, local-only bridge to the hosted operator Notes API without exposing operator credentials to browser JavaScript.

## Ownership

Own Notes DTO/domain additions and route declarations in `packages/core/src/api-routes.ts`, `server/src/notes-remote.ts`, `server/src/server.ts`, and server tests. Do not edit `apps/admin/**` or `services/concepts/**`.

## Dependencies

Blocked by task 01. Build against the landed operator REST contract rather than duplicating or predicting it.

## Criteria

- Add shared Notes DTOs and route types for metadata/excerpts, full note documents, cursors, archive state, save state, and structured version conflicts.
- Add a required remote Notes client using server-side operator URL and token configuration. Provide no local-file or local-database fallback.
- Expose typed local routes for list, search, get, create, update, archive, and restore.
- Keep the operator token and upstream authorization headers server-side. No response or client bundle may contain them.
- Require trusted origin checks on every local write route, following the repository's narrow-write policy.
- Preserve hosted status codes and structured conflict details in a form the dashboard can handle without parsing strings.
- Poll the hosted store, diff stable note metadata/version state, and reuse the server's SSE pattern so MCP writes live-update connected dashboards without emitting unchanged snapshots.
- Refresh clean selected notes when their version changes. Give dirty clients enough version information to preserve their draft and enter conflict state.
- Add server tests for configuration failures, auth isolation, routes, validation, origin checks, pagination, error mapping, polling dedupe, and SSE update behavior.

## Verification

- Run core and server typechecks and tests.
- Verify that browser-facing fixtures and responses never contain the operator token.
