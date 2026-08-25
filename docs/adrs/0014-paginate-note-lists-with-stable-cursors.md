---
type: adr
title: Paginate note lists with stable cursors
description: Bound note listing and search with opaque cursors over a stable recency order.
tags: [architecture, notes, pagination, api]
timestamp: 2026-08-16
scope: claude
provenance:
  - repo: claude-proxy
    number: "0014"
    file: docs/adrs/0014-paginate-note-lists-with-stable-cursors.md
decided-by: /dev
ratified: false
wayfinder: notes
grill-round: 9
needs-human: true
---

# Paginate note lists with stable cursors

## Status

Proposed by `/dev`. This decision has not been ratified by a human.

## Context

> because the hosted authored dataset grows without a reconstructible local source, must `list_notes` and the sidebar use stable cursor pagination ordered by `updatedAt DESC, id DESC`, rather than an unbounded export whose latency and payload grow forever?

The hosted corpus grows indefinitely. An unbounded list would make ordinary navigation and agent discovery degrade with total history.

## Decision

Use opaque cursor pagination ordered by `updatedAt DESC, id DESC`. Default to 50 results, enforce a bounded maximum, and return `nextCursor` when more results remain.

## Consequences

REST, MCP, and the dashboard share stable pagination semantics. Clients must follow cursors instead of assuming one complete export.

## Provenance

Native to `claude-proxy`, this repository's own corpus. It kept its number through the
`monorepo-fusion` merge because the claude block sorts first by timestamp and its numbering
was already dense. See [the legacy map](legacy-map.md) for how every inherited identifier
resolves.
