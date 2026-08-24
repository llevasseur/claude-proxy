---
type: adr
title: Give history and trends their own routes
description: The dashboard adds registered /history and /trends routes with URL-encoded filter state; Overview stays untouched.
tags: [architecture, dashboard, car]
timestamp: 2026-08-22
scope: codex
provenance:
  - repo: codex-proxy
    number: "0013"
    file: docs/adrs/0013-car-dashboard-routes.md
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

## Provenance

Inherited from `codex-proxy` `docs/adrs/0013-car-dashboard-routes.md` (`codex#0013`) and
renumbered to 0034 when the three corpora were merged into this bundle during the
`monorepo-fusion` campaign. The decision itself is unchanged; its ratification fields are
carried over verbatim under ADR 0052, and references to sibling records were repointed at
their new numbers. The original persists in this repository's own git history, which is the
form ADR 0029 blessed.
