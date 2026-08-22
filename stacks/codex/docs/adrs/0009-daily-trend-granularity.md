---
type: adr
title: Bucket Car trends by report-timezone day
description: Trend views render one total series of complete daily aggregates over the selected range.
tags: [architecture, trends, car]
timestamp: 2026-08-22
decided-by: /dev
ratified: false
wayfinder: car-release
grill-round: 1
needs-human: true
---

# Bucket Car trends by report-timezone day

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

> “What granularity must Car's trend views support — daily buckets only, or also hourly/weekly/monthly — and is the trend a single total-usage series over time, or multiple series broken down per model within the selected range?”

The roadmap names trend views only outcome-level
([Bike-to-Plane roadmap](../roadmap/bike-to-plane.md)); richer trends are pinned to Plane. No document pins Car's granularity.

## Decision

Car trend views use daily buckets only, rendered as ONE total-usage series over the selected range, narrowed by the applied model filter. Do not build hourly, weekly, or monthly buckets. Do not build per-model series.

Each bucket carries the complete aggregate shape Today exposes — request count, all token categories, latest timestamp, and nullable cost with its typed reason — plus the bucket resolved half-open UTC window boundaries. Cost nullability is evaluated PER BUCKET: a day containing an unpriced request reports `cost: null` with its reason while fully-priced days still show computed amounts. This applies [ADR 0003](0003-unavailable-incomplete-cost.md) at each aggregation boundary; the range total separately propagates unavailability across every included request.

## Consequences

- Daily buckets reuse the timezone-aware half-open day-boundary machinery Bike already has; no new boundary math.
- Summing daily buckets MUST reproduce the range aggregate exactly; both come from one shared core aggregation path.
- Hourly, weekly, monthly, and per-model series remain deferred to Plane.
