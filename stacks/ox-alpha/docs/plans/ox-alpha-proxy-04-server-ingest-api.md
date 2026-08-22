# Task 04 — Server ingest, SQLite view, health/summary/SSE APIs

## Goal

Build `@ox-alpha-proxy/server`: validate sidecars, ingest into a disposable
SQLite view, serve health, Today summary, and live SSE. Blocked by task 02.

## Criteria

1. Validates every final sidecar file with core's strict validator; ignores temporary names; quarantines and reports corrupt files without blocking other records.
2. Idempotent ingest: record insert plus watermark advancement in one SQLite transaction (`node:sqlite`, raw prepared SQL, WAL, `PRAGMA user_version`); restarts, watcher duplicates, and reconciliation scans never double-count.
3. Startup backfill plus periodic reconciliation make the filesystem watcher an acceleration, not a correctness dependency; deleting the database and re-ingesting reproduces the same summary.
4. `GET /api/health`: readiness, body-free proxy status, database health, ingest progress, rejects, SSE subscriber count.
5. `GET /api/summary`: Today's request count, input/output/total tokens, latest timestamp, timezone, complete-or-unavailable cost — computed by core with server-supplied clock and `REPORT_TZ`.
6. `GET /api/events`: initial snapshot then monotonic status/summary changes with event IDs, retry guidance, keepalives, disconnect cleanup.
7. Server owns env/clock access; no secrets, bodies, prompts, or arbitrary headers persisted anywhere.
8. Vitest coverage including rebuild-from-sidecars equivalence, corrupt-file quarantine, DST day boundaries, SSE continuity.
9. `pnpm verify` green.

## Out of scope

History/trends endpoints (task 07); admin code (task 05).
