---
type: adr
title: Express Car ranges as calendar dates on new endpoints
description: History and trends take inclusive report-timezone calendar dates; the Today summary contract stays untouched.
tags: [architecture, api, car]
timestamp: 2026-08-22
decided-by: /dev
ratified: false
wayfinder: car-release
grill-round: 3
needs-human: true
---

# Express Car ranges as calendar dates on new endpoints

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

> “For Car's date-range API, do clients pass report-timezone calendar dates (e.g., `from=2026-08-01&to=2026-08-21`) that the server resolves into half-open UTC boundaries using the current `REPORT_TZ`, or explicit UTC ISO instants — and does this ride as query parameters on an extended `/api/summary` or on new history/range endpoints?”

No document defines how a historical query expresses its window.

## Decision

History and trend queries accept `from` and `to` as report-timezone calendar dates (`YYYY-MM-DD`, both optional, inclusive), which core resolves into half-open UTC instants using the configured `REPORT_TZ`. They ride on NEW history and trends endpoints. Keep `/api/summary` exactly Today-shaped.

Both parameters are independently optional: omitted `from` means the earliest day with ingested records, omitted `to` means today in `REPORT_TZ`, both omitted means all durable history. No enforced maximum span exists; the deployment shape is one local SQLite view rebuilt at will.

Ranges are always resolved against the CURRENT `REPORT_TZ`. Changing it retroactively re-buckets historical days; shared URLs carry calendar dates, never a timezone, so they render against the server's configuration when opened. Sidecar UTC timestamps remain the only durable truth.

## Consequences

- DST-spanning ranges behave identically to how Today already behaves.
- The entire Bike regression surface stays stable because no existing endpoint changes.
- `from == to` degenerates to exactly one report-day window.
