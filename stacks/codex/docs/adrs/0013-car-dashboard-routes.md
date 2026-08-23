---
type: adr
title: Give history and trends their own routes
description: The dashboard adds registered /history and /trends routes with URL-encoded filter state; Overview stays untouched.
tags: [architecture, dashboard, car]
timestamp: 2026-08-22
decided-by: /dev
ratified: false
wayfinder: car-release
grill-round: 5
needs-human: true
---

# Give history and trends their own routes

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

> “In Car's dashboard, are durable history/trend/filter views separate registered routes with their own URLs, or additional panels within the single existing Overview page?”

Nothing in Bike or Car scope names where these views live.

## Decision

Add separate registered routes — `/history` and `/trends` — each with date-range and model-filter state encoded in the URL query, so any view is shareable and reloadable. Keep the existing Overview page as the unchanged live Today view. Do not grow Overview with panels.

## Consequences

- Route-based structure follows the grain of the admin app's registry.
- A specific filtered range is reproducible from its URL, which supports historical-accuracy and filter verification.
- Route names are a user-facing commitment this run made without a human.
