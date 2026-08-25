---
type: feature
title: Boat (ox-alpha) — opt-in body capture with redaction and retention
description: Explicitly opted-in request and response body capture, redacted before persistence, stored apart from sanitized sidecars under retention controls.
tags: [boat, capture, privacy, retention]
timestamp: 2026-08-22
scope: ox-alpha
provenance:
  - repo: ox-alpha-proxy
    file: docs/features/boat.md
---

# Boat — opt-in body capture with redaction and retention

Provenance: new Boat rung record, named deliberately in the four-rung ladder fixed by
[ADR 0021](../adrs/0021-outcome-ladder.md).

Boat adds inspection data without weakening Bike's privacy boundary: bodies are captured only when an operator
explicitly opts in, redacted before a single byte reaches disk, stored away from sanitized sidecars, and deleted on a
configurable schedule. This record covers capture, retention, and the inspection surfaces built on that data
(task 10).

## Product promise

- Capture is **off by default**. With `CAPTURE_BODIES` unset or false, proxy behavior is byte-identical to Bike/Car:
  no body bytes are buffered for capture and no capture file or directory is ever created.
- Captured bodies live in their own directory (`CAPTURE_DIR`, default `captures` beside the audit directory) with a
  `.capture.json` suffix. Sanitized sidecar v1 is untouched — no new fields — per [ADR 0019](../adrs/0019-sanitized-audit-sidecars.md).
- Redaction runs **before persistence**. Default rules remove authorization headers and schemes, cookies and
  CSRF/session-cookie assignments, API keys (`sk-…`), and credential-shaped JSON fields; operators add patterns via
  `CAPTURE_REDACT_PATTERNS`. Field names stay readable; values become `[redacted]`.
- Each capture envelope shares the sidecar's `recordId`, so an exchange can be joined later without embedding any
  body data in the sanitized record.
- Forwarding stays transparent even when capturing: upstream bytes reach the client verbatim; only persisted copies
  are redacted.
- The server honors its own `CAPTURE_BODIES` flag. A proxy capturing while the server has capture disabled cannot
  corrupt ingest, quarantine counts, or Bike/Car summaries; the server never reads or deletes capture files while
  disabled.
- Retention is enforced by deletion: captures older than `CAPTURE_RETENTION_MS` are removed, then oldest-first
  deletion enforces the `CAPTURE_MAX_BYTES` total-size cap.

## Configuration

| Variable | Read by | Default | Purpose |
|---|---|---|---|
| `CAPTURE_BODIES` | proxy + server | off | Shared explicit opt-in for body capture. |
| `CAPTURE_DIR` | proxy + server | `captures` beside `AUDIT_DIR` | Capture storage directory. |
| `CAPTURE_REDACT_PATTERNS` | proxy | empty | Comma-separated additional regex sources, applied case-insensitively. |
| `CAPTURE_RETENTION_MS` | server | 604800000 (7 days) | Age at which a capture file is deleted. |
| `CAPTURE_MAX_BYTES` | server | 268435456 (256 MiB) | Total size cap across capture files. |

## Maintenance

Retention runs periodically inside a started server and headlessly through a documented command:

```sh
pnpm --filter @agent-proxy/ox-server maintain
```

The command prints one JSON result line (`examined`, `deletedExpired`, `deletedOverCap`, `remainingFiles`,
`remainingBytes`) and exits. Retention semantics are specified in [Capture storage and retention](../specs/ox-alpha-capture-retention.md).

Bike and Car remain fully useful with zero inspection data present; nothing in this rung feeds the Overview,
history, or trends surfaces.

## Inspection surfaces

The server reads only its own capture directory (never the audit directory) and serves fourteen inspection
endpoints under `/api/inspection/`. Every endpoint is read-only, GET-only, and degrades to a **typed empty result**
— never an error — on a server where capture was never enabled or has no captures. Each payload carries
`captureEnabled` so a client can distinguish "off" from "empty"; `/errors` is the one exception, since it reports
ingest and capture-read faults rather than capture content.

| Endpoint | Purpose |
|---|---|
| `GET /api/inspection/day` | Per-day context assembly: one summary row per capture (`date`, `limit`, `offset`; `date` defaults to today in the report timezone). |
| `GET /api/inspection/messages?recordId=` | Request and response turns of one capture, merged in order and paginated. Unknown `recordId` is 404 when capture is on, typed empty when off. |
| `GET /api/inspection/prompt?recordId=` | Prompt shape analysis (model, instructions presence, message count, tool count, ~4 chars/token estimate) without returning body text. |
| `GET /api/inspection/prompt-mix` | Prompt cohorts for a day, grouped by instructions hash (`date`, defaulting to today in the report timezone). |
| `GET /api/inspection/prompts` | Per-capture prompt listings for a day, paginated, optional `hash` filter to drill into one cohort. |
| `GET /api/inspection/prompt-sections?recordId=` | One capture's instructions split into sections, with the instructions hash. |
| `GET /api/inspection/tools` | Tool schemas declared across captures, paginated, optional `recordId` filter. |
| `GET /api/inspection/tool-calls` | Function calls extracted from captured responses (JSON or SSE frames), paginated, optional `recordId` filter. |
| `GET /api/inspection/tool-schema?name=` | One tool name across every capture: occurrence count, distinct schema variants, first/last seen, contributing `recordId`s. |
| `GET /api/inspection/sessions` | Captures grouped by session identity, paginated, newest activity first, each with its liveness. |
| `GET /api/inspection/sessions/detail?id=` | The captures belonging to one session, paginated. |
| `GET /api/inspection/sessions/breakdown?id=` | One session's counts by model and by report hour. |
| `GET /api/inspection/context?search=&sort=` | Context summaries across captures, optional substring search and `asc`/`desc` ordering by capture time, paginated. |
| `GET /api/inspection/errors` | Sidecars rejected at ingest and capture files that could not be read. |

Listing responses share the Bike history page contract (`total`, `offset`, `limit`, `nextOffset`, `records`) so the
dashboard reuses one pagination interaction. Malformed queries are rejected as `400 invalid_query`; sanitized
metrics endpoints (`/api/health`, `/api/summary`, `/api/history`, `/api/trends`, `/api/events`) are untouched.

Session grouping derives identity from explicit request attributes only — `session_id`, then
`metadata.session_id`, then `user`; the envelope v1 schema carries no session field by design. A capture with no
derivable identifier groups under its own `recordId`, so every capture stays attributable rather than collapsing
into one anonymous bucket. This derivation rule lives in core (`deriveSessionId`) next to the tolerant request,
response, and prompt parsers, all of which return typed unparsed results for bodies that fail to parse.

Per-day context assembly is memoized (the codex-proxy `context-day-memo` pattern): parsed captures are memoized
against a name/mtime/size directory signature, and each day's assembly against that signature plus a
retention-deletion epoch, so both new or changed capture files and retention deletions invalidate immediately.
Repeated requests between changes hit the cache instead of re-parsing bodies.

Dashboard routes under `#/boat`: Context (`#/boat`), Messages (`#/boat/messages?recordId=`),
Prompt analysis (`#/boat/prompt?recordId=`), Tool schemas (`#/boat/tools`), Tool calls (`#/boat/tool-calls`), and
Sessions (`#/boat/sessions`). Each route renders loading, empty, and no-capture states; when the server reports
`capture.enabled === false` the page explains that Boat capture is off instead of showing a bare empty table.

Verification at this surface runs in both modes: integration tests cover every endpoint on a repository where
capture was never enabled (typed empties, no capture directory ever created, disabled servers ignoring stray
capture files) and against fixture captures (assembly, pagination across pages, memoization hits, invalidation on
write and retention deletion, 404 versus degraded-empty behavior).
