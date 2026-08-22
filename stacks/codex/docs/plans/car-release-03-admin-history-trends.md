---
type: plan
title: Car ticket 03 — Admin history and trends views
description: Registered /history and /trends routes with URL-encoded range and model filters refetched on data-version signals.
tags: [plan, car, admin]
timestamp: 2026-08-22
---

# Car ticket 03 — Admin history and trends views

Add the Car surfaces to `apps/admin/src`. The Overview page stays the unchanged live Today view.

## Criteria

1. Register two new routes — `/history` and `/trends` — following the app's existing registry/router patterns (ADR 0013).
2. History route renders the paginated per-request listing: timestamp, model, endpoint, response status, token figures, and cost rendered as either a computed amount or an explicit unavailable state per ADR 0003 — never `$0`. Pagination controls bound page size.
3. Trends route renders the daily total-usage series over the selected range; days with unavailable cost render their token counts plus an explicit unavailable state while fully-priced days show amounts. No hourly/weekly/monthly or per-model series.
4. Both routes encode date-range and model-filter state in the URL query so any view is shareable and reloadable. Filters offer multi-select model choice populated from observed models and inclusive calendar-date inputs; unmatched filter values render empty states, never errors.
5. Refetch history/trend data only when an SSE data-version signal reports a version newer than what is rendered, retaining the documented periodic-refetch backstop and last-known-state behavior through reconnecting/stale/degraded/unavailable states (ADR 0012).
6. The live Overview keeps its existing contract untouched; no panel additions to it.
7. `pnpm verify` passes, including the admin bundle build.

## Lane

Owns `apps/admin/**`. Must not touch `packages/core/**`, `server/**`, `proxy/**`, or `docs/**`. Build against the API contract pinned in ADRs 0011, 0012, 0014, 0015 and this plan; do not modify server code to make the UI fit.
