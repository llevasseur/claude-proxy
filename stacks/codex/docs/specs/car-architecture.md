---
type: spec
title: Car architecture
description: View schema, range and trend contracts, SSE data-version signal, dashboard routes, filter semantics, and the history listing as built.
tags: [car, architecture, sqlite, api, sse]
timestamp: 2026-08-22
---

# Car architecture

## Flow

```text
final sanitized sidecars
  -> server validator and idempotent ingest
  -> disposable SQLite view (schema version 2, per-record columns)
  -> /api/history + /api/trends beside unchanged Bike endpoints
  -> SSE snapshot/update frames + one data-version signal
  -> /history and /trends dashboard routes beside the unchanged Overview
```

The proxy is untouched by Car. Everything below happens in `@agent-proxy/codex-core`'s pure history functions, the server,
and the dashboard.

## Core range and aggregation functions

`packages/core/src/history.ts` owns the pure layer:

- `resolveCalendarRange(from, to, now, timeZone)` resolves optional inclusive `YYYY-MM-DD` calendar dates into
  half-open UTC instants against an explicit timezone. Omitted `from` means unbounded start; omitted `to` means the
  end of today in the report timezone; a start at or after the end throws. DST transitions are handled through the
  same day-boundary helpers Today uses, so a spring-forward or fall-back day resolves to its true UTC span.
- `aggregateDailyBuckets(events, from, to, now, timeZone)` filters events into the range, groups them by
  report-timezone day, and returns a COMPLETE daily series — empty days inside the window appear as zero buckets —
  each carrying its `date`, UTC `startInclusive`/`endExclusive` instants, and the aggregate summary.
- `aggregateRangeFromBuckets(buckets)` computes the range total from the buckets themselves, so bucket sums equal the
  range total through one shared path.
- `modelFilter(models)` / `selectByModels(records, models)` implement exact multi-select: an empty selection matches
  everything; otherwise membership in the selected set.

Aggregation keeps ADR 0003 cost semantics at every level: any unpriced record makes its day's cost unavailable with a
typed reason while token counts survive, and the range total is unavailable when any included bucket is.

## SQLite view — schema version 2

The view (`server/migrations/002-car-view.sql`, replacing `001-initial.sql`) stores per-record columns — record ID,
filename, event timestamp, UTC `day_key`, model, endpoint, response status, request ID, token figures, cost amount and
catalogue version or typed unavailable reason, and the full sidecar JSON — plus the Bike-era `ingest_watermarks` and
`rejected_sidecars` tables. Per ADR 0010 there is no migration chain: opening a database whose `PRAGMA user_version`
is not `2` deletes the file (and WAL/SHM sidecars), recreates it from the current migration, and lets startup backfill
re-ingest every final sidecar. Ingest stays transactional and idempotent: watermark check, insert-or-verify by record
ID, then watermark advancement in one `BEGIN IMMEDIATE` transaction.

## Local API

All parameters apply to both new endpoints identically:

| Parameter | Semantics |
|---|---|
| `from` | Optional inclusive report-timezone calendar date (`YYYY-MM-DD`). Anything else → `400 invalid_query`. |
| `to` | Optional inclusive report-timezone calendar date; defaults to end of today under `REPORT_TZ`. |
| `model` | Repeated exact-match values (`model=a&model=b`). Unmatched values yield ordinary empty results. |

Malformed dates, a start not before the end, or malformed pagination reject the request with `400 {error: "invalid_query"}`.

### `GET /api/history`

Paginated record listing ([ADR 0015](../adrs/0015-history-record-listing.md)). Extra pagination parameters:
`limit` (default 50, integer 1–200) and `offset` (non-negative). Records order newest first by timestamp with
`recordId` ascending as the deterministic tiebreaker. Response envelope:

```json
{
  "dataVersion": 7,
  "total": 1234,
  "limit": 50,
  "offset": 0,
  "records": [
    {
      "recordId": "...", "timestamp": "...", "model": "...", "endpoint": "...",
      "responseStatus": 200, "requestId": "..." ,
      "inputTokens": 0, "cachedInputTokens": 0, "outputTokens": 0,
      "reasoningOutputTokens": 0, "totalTokens": 0,
      "cost": {"currency": "USD", "amountUsd": "...", "catalogueVersion": "..."},
      "costUnavailableReason": null
    }
  ]
}
```

`cost` is `null` exactly when `costUnavailableReason` is set. Token figures sit flat on the record.

### `GET /api/trends`

Daily bucket series over the resolved range. Response envelope:

```json
{
  "dataVersion": 7,
  "reportTimezone": "America/New_York",
  "startInclusive": "2026-08-01T04:00:00.000Z",
  "endExclusive": "2026-08-22T04:00:00.000Z",
  "buckets": [
    {
      "reportTimezone": "America/New_York", "date": "2026-08-01",
      "startInclusive": "...", "endExclusive": "...",
      "requestCount": 0, "inputTokens": 0, "cachedInputTokens": 0,
      "outputTokens": 0, "reasoningOutputTokens": 0, "totalTokens": 0,
      "latestEventTimestamp": null, "cost": null, "costUnavailableReason": null
    }
  ],
  "total": {"requestCount": 0, "...": "range total aggregated from the buckets"}
}
```

Buckets are complete across the window including empty days; the range total rides on the same bucket path, so
per-day sums always reconcile with it.

## SSE data-version signal

The entire Bike `/api/events` contract stands: initial `snapshot` frame, monotonic event IDs, `update` frames only
when the health/summary snapshot actually changed, `retry: 2000` guidance, keepalives, and disconnect cleanup. Car
adds exactly one event kind ([ADR 0012](../adrs/0012-sse-data-version-signal.md)):

```text
id: <monotonic>
event: data-version
data: {"dataVersion": 7}
```

The server increments its in-memory data version whenever ingest changes the view — including backfill and
reconciliation of records outside today — publishes the signal immediately, and stamps the same value onto every
history and trends response. No history or trend payloads are ever streamed. The dashboard refetches a Car query only
when the signaled version differs from the version it rendered; the Overview keeps its existing 30-second refetch
backstop.

## Dashboard routes

Per [ADR 0013](../adrs/0013-car-dashboard-routes.md), `/history` and `/trends` are registered routes beside the
untouched Overview. Filter state is URL-encoded search params validated client-side by the same rules the server
enforces: `from`/`to` calendar dates, repeated `model` values via a custom search serializer, and page/pageSize on
history so any view reloads exactly where it was shared. Model options populate from records observed in responses.
Both pages keep last-known data through reconnecting and offline stream states, labeled explicitly.

## History listing

History exposes exactly the sanitized sidecar fields already stored — no new fields cross the privacy boundary —
paginated so no response grows unbounded with history length. The dashboard renders cost as an amount or an explicit
unavailable-with-reason cell, never `$0`.

## Cost resolution

Per [ADR 0016](../adrs/0016-retroactive-catalogue-pricing.md), the view resolves cost against the current catalogue
whenever it materializes a record whose only obstacle is `unknown-model`: at ingest into per-record columns, and when
stored sidecars feed Today and trend aggregates. Sidecar files stay untouched; derived cost is view state, so adding
models to `PRICING_CATALOGUE` reprices affected history through the version-bump rebuild path (ADR 0010). A model still
absent from the catalogue remains explicitly unavailable.

The view schema is at user_version 3 (`server/migrations/003-car-reprice.sql`).
