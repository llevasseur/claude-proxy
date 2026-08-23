---
type: feature
title: Car — durable history, trends, ranges, and model filters
description: The second codex-proxy outcome — durable usage history, daily trend views, calendar date ranges, and exact model filters on top of every Bike boundary.
tags: [car, history, trends, filters, timezone]
timestamp: 2026-08-22
---

# Car — durable history, trends, ranges, and model filters

Car keeps Bike's one safe loop running unchanged and adds memory: every sanitized request stays browsable, and past
usage becomes a daily trend over any calendar range, narrowed by the models the operator selects.

## Product promise

- Durable history is a paginated per-request record listing built from exactly the sanitized sidecar fields already
  stored — record ID, timestamp, model, endpoint, response status, request ID, token figures, and cost with its typed
  unavailability reason. Nothing new crosses the privacy boundary.
- Trend views render ONE total-usage series of complete daily aggregates over the selected range. There are no hourly,
  weekly, or monthly buckets and no per-model series.
- Date ranges are expressed as inclusive report-timezone calendar dates (`from`/`to`, both optional) that the server
  resolves into half-open UTC instants, DST-aware. The Today summary contract is untouched.
- Model filters are repeated exact-match parameters. A well-formed value matching nothing returns an ordinary empty
  result set with valid envelope metadata — never an error. No normalization or aliasing layer exists.
- Cost keeps its Bike semantics everywhere: an amount only when the whole aggregate is priced, otherwise an explicit
  typed unavailable reason — never zero, never a partial estimate labeled as total. Models that join the pricing
  catalogue are priced retroactively in the view ([ADR 0016](../adrs/0016-retroactive-catalogue-pricing.md)).
- Every Bike boundary holds: transparent forwarding, sanitized-only persistence, nullable complete cost, live Overview,
  process separation, and final sidecars as durable truth.

These choices are owned by [ADR 0009](../adrs/0009-daily-trend-granularity.md),
[ADR 0010](../adrs/0010-rebuild-view-on-schema-mismatch.md),
[ADR 0011](../adrs/0011-calendar-date-range-api.md),
[ADR 0012](../adrs/0012-sse-data-version-signal.md),
[ADR 0013](../adrs/0013-car-dashboard-routes.md),
[ADR 0014](../adrs/0014-model-filter-semantics.md), and
[ADR 0015](../adrs/0015-history-record-listing.md).

## Run shape

The proxy, server, and dashboard remain separate processes. The proxy still writes immutable sanitized sidecars and a
body-free status signal; it knows nothing about Car. The server validates final sidecars, maintains the SQLite view at
schema version 2, serves the Bike endpoints plus `/api/history` and `/api/trends`, and emits one additional SSE event
kind when ingest advances the view. The dashboard registers `/history` and `/trends` as routes beside the unchanged
Overview; filter state lives in each URL query so any view is shareable and reloadable.

Configuration is unchanged from Bike: environment variables documented in `.env.example`, with `REPORT_TZ` defaulting
to `America/New_York` at the server boundary. Pure core functions receive the timezone and clock explicitly.

## Data lifecycle and recovery

Final audit sidecars remain the source of truth. The SQLite view carries per-record columns so history pages do not
parse JSON per row, but it stays disposable: opening a database whose `user_version` is not the current schema version
discards it, recreates it empty, and lets startup backfill re-ingest every final sidecar. There is no migration chain.
Idempotent record IDs keep restarts, watcher duplicates, and reconciliation scans from double-counting.

The SSE stream gains exactly one signal — a monotonic data-version advancement emitted whenever ingest changes the
view, including records outside today. History and trend responses carry the same version, and the dashboard refetches
only when the signaled version differs from what it rendered.

Body capture remains a Boat concern. Car never persists request or response bodies, prompts, tool data, credentials,
cookies, or arbitrary headers, and remains fully useful without inspection data.

## Publication boundary

Car inherits Bike's fresh-history start ([ADR 0005](../adrs/0005-fresh-repository-history.md)) and private-repository
publication ([ADR 0006](../adrs/0006-private-github-publication.md)). Runtime secrets and data stay untracked
regardless of repository visibility. The delivery sequence is in the [Bike-to-Plane roadmap](../roadmap/bike-to-plane.md).
