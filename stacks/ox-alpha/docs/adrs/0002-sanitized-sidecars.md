---
type: adr
title: Keep audit sidecars sanitized
description: Persist sanitized identifiers and usage metrics only; bodies have no schema slot.
tags: [architecture, privacy]
timestamp: 2026-08-22
decided-by: /dev
ratified: false
wayfinder: ox-alpha-proxy
grill-round: 4
---

# Keep audit sidecars sanitized

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Provenance

Adapted from `codex-proxy` `docs/adrs/0002-sanitized-bike-sidecars.md`.

## Decision

The proxy writes strict, versioned, sanitized JSON sidecars. The schema accepts
exactly its named fields — schema version, record identity, timestamp, model,
endpoint pathname, response status, request id, usage, cost, and cost
unavailability reason. Unknown fields fail validation. Request bodies, response
bodies, prompts, tool data, text output, credentials, cookies, arbitrary
headers, and query strings have no schema slot.

## Consequences

- Accidental schema expansion across the privacy boundary fails validation.
- Final sidecars are the source of truth; SQLite is a rebuildable view.
- Body capture begins only in Boat with explicit opt-in (see ADR 0004).
