---
type: adr
title: Order notes strictly by recent edit
description: Keep pinning out of scope so every active note follows one deterministic recency order.
tags: [architecture, notes, ordering, dashboard]
timestamp: 2026-08-16
scope: claude
provenance:
  - repo: claude-proxy
    number: "0015"
    file: docs/adrs/0015-order-notes-strictly-by-recent-edit.md
decided-by: /dev
ratified: false
wayfinder: notes
grill-round: 10
needs-human: true
---

# Order notes strictly by recent edit

## Status

Proposed by `/dev`. This decision has not been ratified by a human.

## Context

> Apple Notes supports pinned notes, but the request makes most-recently-edited ordering normative: is pinning explicitly out of scope for this release so every active note remains in one strict `updatedAt DESC, id DESC` sequence?

Pinning would introduce a second ordering rule and weaken the requested most-recently-edited invariant.

## Decision

Keep pinning out of scope. Order every active note strictly by `updatedAt DESC, id DESC`.

## Consequences

All clients expose one deterministic order. A future pinning feature requires a new explicit decision and contract change.

## Provenance

Native to `claude-proxy`, this repository's own corpus. It kept its number through the
`monorepo-fusion` merge because the claude block sorts first by timestamp and its numbering
was already dense. See [the legacy map](legacy-map.md) for how every inherited identifier
resolves.
