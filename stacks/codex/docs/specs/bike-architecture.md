---
type: spec
title: Bike architecture
description: Process, contract, storage, API, privacy, and recovery design for the Bike outcome.
tags: [bike, architecture, responses-api, sqlite, sse]
timestamp: 2026-08-19
---

# Bike architecture

## Flow

```text
Codex client
  -> transparent proxy
  -> configured OpenAI-compatible upstream

transparent proxy
  -> atomic sanitized sidecar + body-free live status
  -> server validator and idempotent ingest
  -> disposable SQLite materialized view
  -> REST health/Today summary + SSE snapshots
  -> one Overview page
```

The forwarding stream is the primary path. Observation taps recognized OpenAI Responses JSON or final Responses
SSE usage without becoming a gate for arbitrary traffic. The proxy has zero runtime dependencies, runs TypeScript
source directly on Node 22+, writes files only, and never opens SQLite or calls the server.

## Shared domain contract

`@agent-proxy/codex-core` exports TypeScript source and has no runtime dependencies or build output. Its functions import
no Node modules and receive every external input explicitly.

The normalized immutable usage value contains required input, output, and total headline tokens plus cached-input
and reasoning-output detail. Detail is a subset of its headline category and never increases totals. Streaming and
non-streaming adapters feed the same normalizer after selecting the final authoritative Responses usage object.

Pricing uses explicit USD-per-million-token decimal strings by model and input, cached-input, output, and reasoning
output category. Calculation converts those strings to integer pico-dollars before multiplication. A model or any
consumed category without a configured rate returns `cost: null` with a typed reason. Aggregation propagates that
unavailability across the whole Today estimate while retaining token counts.

## Sanitized sidecar v1

The strict boundary accepts exactly these fields:

| Field | Purpose |
|---|---|
| `schemaVersion` | Selects the validator; Bike writes version `1`. |
| `recordId` | Stable immutable ingest identity. |
| `timestamp` | UTC completion time. |
| `model` | Exact model identifier used for pricing. |
| `endpoint` | Request pathname only; no query or body. |
| `responseStatus` | Upstream HTTP status. |
| `requestId` | Upstream request ID when present, otherwise `null`. |
| `usage` | Input, cached input, output, reasoning output, and total tokens. |
| `cost` | Complete USD estimate and catalogue version, otherwise `null`. |
| `costUnavailableReason` | Typed reason when `cost` is `null`, otherwise `null`. |

Unknown fields fail validation, which prevents accidental schema expansion across the privacy boundary. Request
bodies, response bodies, prompts, tools, text, credentials, cookies, arbitrary headers, and query strings have no
schema slot.

## Filesystem and database boundary

The proxy writes sidecar contents to a same-directory temporary file, flushes and closes it, then atomically renames
it to an immutable final filename. The server ignores temporary names, validates every final file, and performs the
record insert plus watermark advancement in one SQLite transaction. Startup backfill and periodic reconciliation
make filesystem watchers an acceleration rather than a correctness dependency.

SQLite uses Node's built-in `node:sqlite`, raw prepared SQL, WAL mode, and `PRAGMA user_version`. It is not the source
of truth. Deleting the database and re-ingesting all final sidecars must reproduce the same summary.

## Local API and liveness

- `GET /api/health` reports server readiness, body-free proxy status, database health, ingest progress, rejects, and
  SSE subscriber count.
- `GET /api/summary` reports Today's request count, input tokens, output tokens, total tokens, latest timestamp,
  timezone, and complete or unavailable cost.
- `GET /api/events` sends an initial snapshot and monotonic status/summary changes with event IDs, retry guidance,
  keepalives, and disconnect cleanup.

The server owns environment and clock access. It reads `REPORT_TZ`, defaulting to `America/New_York`, and passes the
timezone and current instant into core. Core computes timezone-aware half-open day boundaries, including daylight-
saving transitions.

The dashboard bootstraps from health and summary, subscribes to SSE, and periodically refetches as a backstop. It
retains the shell and last known summary through reconnecting, stale, degraded, and unavailable states.

## Failure domains and recovery

- Upstream availability controls proxy responses; observation failure does not.
- Proxy status and sanitized sidecars cross the process boundary through files only.
- Server or database failure never blocks proxy forwarding.
- Dashboard failure never blocks server ingest.
- A corrupt sidecar is reported and quarantined without preventing other records.
- A corrupt or missing database is deleted and rebuilt from final sidecars.

The product and privacy choices are linked from the [Bike feature](../features/bike.md). The delivery sequence and
final parity contract are in the [Bike-to-Plane roadmap](../roadmap/bike-to-plane.md).
