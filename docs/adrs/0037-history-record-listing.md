---
type: adr
title: Make durable history a paginated record listing
description: History exposes sanitized per-request records newest first with deterministic pagination.
tags: [architecture, api, history, car]
timestamp: 2026-08-22
scope: codex
provenance:
  - repo: codex-proxy
    number: "0015"
    file: docs/adrs/0015-history-record-listing.md
decided-by: /dev
ratified: false
wayfinder: car-release
grill-round: 10
needs-human: true
---

# Make durable history a paginated record listing

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

> “Must Car's durable-history surface expose a paginated, ordered per-request record listing (from the sanitized sidecar fields already stored), or is history satisfied entirely by aggregate queries over past date ranges with no per-record browsing?”

The roadmap gives Car two distinct surfaces — durable history AND trend views — without defining the history one.

## Decision

Build history as a browsable, paginated per-request record listing exposing exactly the sanitized sidecar fields already stored: `recordId`, `timestamp`, `model`, `endpoint`, `responseStatus`, `requestId`, token figures, and nullable cost with its typed reason. Order newest first by `timestamp` with `recordId` as deterministic tiebreaker. Paginate so no response grows unbounded with history length. Do not satisfy history with aggregates alone — trend views already own aggregates.

## Consequences

- Zero new data exposure: the listing re-renders fields the operator already holds on disk.
- The privacy boundary is untouched — bodies, prompts, tools, and headers have no schema slot to list.
- Deterministic ordering keeps pages stable across repeated fetches of the same range.

## Provenance

Inherited from `codex-proxy` `docs/adrs/0015-history-record-listing.md` (`codex#0015`) and
renumbered to 0037 when the three corpora were merged into this bundle during the
`monorepo-fusion` campaign. The decision itself is unchanged; its ratification fields are
carried over verbatim under ADR 0052, and references to sibling records were repointed at
their new numbers. The original persists in this repository's own git history, which is the
form ADR 0029 blessed.
