# codex-proxy server

The local server turns final sanitized audit sidecars into a disposable SQLite view and serves the Bike dashboard API.
It listens on `127.0.0.1:4319` by default.

## Run

```sh
pnpm --filter server start
```

Configuration:

- `HOST` and `PORT` select the listener.
- `AUDIT_DIR` selects the directory containing immutable `*.audit.json` files. It defaults to `logs`.
- `DATABASE_PATH` selects SQLite and defaults to `logs/codex-proxy.db`.
- `PROXY_STATUS_PATH` selects the body-free proxy status file and defaults to `logs/proxy-status.json`.
- `REPORT_TZ` defines Today and defaults to `America/New_York`.
- `RECONCILE_INTERVAL_MS` and `SSE_KEEPALIVE_MS` control the scan and keepalive intervals.

The server ingests existing files before listening, watches atomic renames for low-latency updates, and periodically
rescans so a missed filesystem event cannot make SQLite stale. Temporary filenames and anything other than
`*.audit.json` are ignored. Malformed or unsupported final sidecars are counted in `/api/health`; their contents are
never returned.

## API

- `GET /api/health` reports server, proxy, database, ingest, and SSE state.
- `GET /api/summary` reports Today's request and token totals plus complete USD cost or an explicit unavailable reason.
- `GET /api/events` sends an initial snapshot and monotonic live updates as server-sent events.

## Recovery

Final sidecars are the source of truth. Stop the server, delete only the file named by `DATABASE_PATH` (plus its
SQLite `-wal` and `-shm` companions if present), and restart. Startup recreates the schema and re-ingests every final
sidecar. Repeated scans and restarts do not increase totals.
