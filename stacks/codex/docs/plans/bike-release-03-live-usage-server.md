---
type: plan
title: Bike release 03 — Live usage server
description: Materialize sanitized sidecars into SQLite and serve health, Today summary, and live SSE updates.
tags: [planning, server, sqlite, sse]
timestamp: 2026-08-19
wayfinder: bike-release
task: 03
status: todo
---

# Bike release 03 — Live usage server

## Outcome

Ship a local Node server that maintains a disposable, idempotent SQLite view of
sanitized audit sidecars and exposes the complete Bike API: health/live status,
today's usage summary, and server-sent summary updates.

## Dependencies

Task 01. This ticket may run in parallel with task 02 after task 01 lands.
Task 04 depends on this ticket.

## Owned paths

This ticket alone owns `server/src/**`, `server/test/**`, and
`server/migrations/**`. It may update `server/README.md`. It MUST NOT edit
workspace manifests, the lockfile, core, proxy, app, or durable cross-project
docs.

## Requirements

- Use Node 22+ and built-in `node:sqlite` with raw prepared SQL. Enable WAL mode
  and track schema version in `PRAGMA user_version`; add no ORM or query builder.
- Treat sanitized audit sidecars as the sole source of truth and SQLite as a
  disposable materialized view. The documented recovery path deletes the DB and
  re-ingests every final sidecar without data loss.
- Keep the database out of the proxy process. Default it to a documented local
  path such as `logs/codex-proxy.db`; never ingest temporary sidecar filenames.
- Make ingestion idempotent and transactional. Key each immutable sidecar by its
  stable filename/record ID, validate it through the core schema, upsert or skip
  it exactly once, and advance a durable watermark only in the same transaction
  as its rows. Restart and duplicate delivery must not double-count usage.
- Quarantine or report malformed/unsupported sidecars without blocking valid
  records. A missing or corrupt database is rebuildable; a corrupt sidecar is
  visible in health diagnostics rather than silently interpreted.
- Ingest existing files at startup, then observe new atomic renames and reconcile
  with periodic scans so filesystem watcher loss cannot make the view stale.
- Serve JSON health at `/api/health` with server readiness, proxy status,
  database state, last successful ingest, rejected-sidecar count, and SSE
  subscriber count. Never expose secrets or body data.
- Serve `/api/summary` with today's request count, input tokens, output tokens,
  total tokens, latest timestamp, report timezone, and cost as either a complete
  amount/currency or an explicit unavailable state.
- Define Today using `REPORT_TZ`, default `America/New_York`, and derive boundaries
  with the shared core logic rather than SQLite's host-local timezone.
- Serve `/api/events` as SSE. Send an initial snapshot, then a new monotonic event
  whenever ingestion changes the Today summary or observed proxy/server status.
  Include keepalives, retry guidance, disconnect cleanup, and event IDs so the UI
  can show live/reconnecting/stale state. Do not emit duplicate summary changes.
- Bind to localhost by default, validate configuration at startup, handle graceful
  shutdown, and close watchers/SSE clients/database handles deterministically.

## Acceptance criteria

- Ingestion tests cover empty startup, historical backfill, duplicate scans,
  restart, out-of-order filenames, interrupted transactions, temporary files,
  malformed/unknown schema versions, and delete/rebuild recovery.
- Re-running ingestion produces byte-equivalent summary JSON and unchanged
  aggregate counts.
- API tests cover healthy/degraded proxy states, empty Today, complete and
  unavailable costs, timezone midnight and daylight-saving boundaries, and
  sanitized error responses.
- SSE tests prove initial snapshot, exactly one update per aggregate change,
  status-only updates, keepalive framing, monotonic IDs, reconnect behavior, and
  subscriber cleanup.
- Deleting the database and re-ingesting the same sidecars reproduces the same
  API results.

## Verification

- Run server unit/integration tests against temporary directories and temporary
  SQLite files; do not reuse a developer database.
- Run the root typecheck, test, check, build, and aggregate verifier.
- Launch the server with a fixture log directory, verify health and empty
  summary, atomically add fixtures, observe live SSE changes, restart, and prove
  totals do not increase twice.
- Delete the fixture DB, rebuild it through the supported ingest path, and diff
  summary responses before and after recovery.
