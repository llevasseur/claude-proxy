# ox-alpha-proxy

A transparent OpenAI Responses proxy with sanitized usage observability, rebuilt
clean-room from the recorded decisions of `codex-proxy`.

Four independently useful outcomes, delivered in order:

1. **Bike** — transparent forwarding plus one live Overview of today's tokens and cost.
2. **Car** — durable history, trends, date ranges, and model/range filters.
3. **Boat** — explicit opt-in body capture with redaction and retention, then inspection.
4. **Plane** — parity with the pinned `claude-proxy` commit.

Read [the roadmap](docs/roadmap/four-rungs-to-plane.md) and
[the decision records](docs/adrs/index.md) before changing anything.

## Running

| Process | Command |
| --- | --- |
| Proxy | `pnpm proxy` |
| Server API | `pnpm server` |
| Dashboard | `pnpm admin` |
| All three in one zellij session | `pnpm zellij` |

Configuration comes from `.env`, `proxy/.env`, `server/.env`, and
`apps/admin/.env`; see each package's `.env.example`.

## Headless operation and recoveryEverything durable lives in final sanitized audit sidecars under `AUDIT_DIR`
(see [ADR 0002](docs/adrs/0002-sanitized-sidecars.md)). The SQLite database is
rebuildable state and can be deleted at any time.

**Ingest / rebuild.** The server reconciles the sidecar directory on start,
on directory changes, and every `RECONCILE_INTERVAL_MS`. To rebuild a corrupt
or stale store, stop nothing — delete the database files and let the next
reconcile backfill:

```sh
rm "$DATABASE_PATH" "$DATABASE_PATH"-wal "$DATABASE_PATH"-shm
pnpm --filter @ox-alpha-proxy/server start   # or just wait for reconcile
```

Ingest is watermarked per filename and idempotent; re-running never double
counts, and out-of-order or late-arriving sidecars are backfilled exactly once.
Malformed sidecars are quarantined in `rejected_sidecars` without blocking
valid files, visible on `GET /api/inspection/errors`.

**Retention and consistency.** One headless pass expires captured bodies past
`CAPTURE_RETENTION_MS`, caps the capture directory at `CAPTURE_MAX_BYTES`, then
audits store/source consistency (sidecar files versus records, watermarks, and
orphaned watermarks):

```sh
pnpm --filter @ox-alpha-proxy/server maintain
```

Output is one JSON line combining the retention result with the consistency
report (`consistent: false` names the drifted axis). A running server also runs
the retention pass periodically. Capture stays off entirely unless
`CAPTURE_BODIES=true`; with it off, `maintain` reports and deletes nothing.

**Usage limits.** Rolling 5-hour and weekly token meters appear at
`GET /api/limits` once ceilings are configured via `USAGE_LIMIT_5H` and
`USAGE_LIMIT_WEEK`; windows without a configured ceiling are omitted rather
than shown against an invented denominator.

