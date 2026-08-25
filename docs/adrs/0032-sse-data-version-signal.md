---
type: adr
title: Extend SSE with a data-version signal
description: The events stream gains one lightweight change signal; history and trend payloads are never streamed.
tags: [architecture, sse, car]
timestamp: 2026-08-22
scope: codex
provenance:
  - repo: codex-proxy
    number: "0012"
    file: docs/adrs/0012-sse-data-version-signal.md
decided-by: /dev
ratified: false
wayfinder: car-release
grill-round: 4
needs-human: true
---

# Extend SSE with a data-version signal

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

> “Must Car extend the existing `/api/events` stream to carry history/trend-affecting changes (new snapshots or change signals that trigger a history refetch), or does SSE remain exactly its Bike contract with history/trend data refreshed only by client-initiated fetches?”

The spec pins `/api/events` to Today-shaped snapshots only.

## Decision

Keep the entire Bike `/api/events` contract — initial snapshot, monotonic event IDs, retry guidance, keepalives, disconnect cleanup — and add exactly ONE additional event kind: a data-version advancement signal emitted whenever ingest advances the view, including backfill and reconciliation of records outside today. It carries no history or trend snapshot payloads. History and trend responses expose the same monotonic data version, and the dashboard refetches them only when the signaled version differs from what it rendered, retaining the documented periodic-refetch backstop.

## Consequences

- Old clients' behavior is unchanged; new events append after existing kinds.
- Late-arriving historical sidecars reach open views, which a "summary changed" heuristic would miss.
- No query-shaped data enters the live channel.

## Provenance

Inherited from `codex-proxy` `docs/adrs/0012-sse-data-version-signal.md` (`codex#0012`) and
renumbered to 0032 when the three corpora were merged into this bundle during the
`monorepo-fusion` campaign. The decision itself is unchanged; its ratification fields are
carried over verbatim under ADR 0052, and references to sibling records were repointed at
their new numbers. The original persists in this repository's own git history, which is the
form ADR 0029 blessed.
