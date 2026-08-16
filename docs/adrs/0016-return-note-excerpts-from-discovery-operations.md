---
type: adr
title: Return note excerpts from discovery operations
description: Keep list and search responses bounded by returning metadata and derived excerpts instead of full Markdown bodies.
tags: [architecture, notes, api, search]
timestamp: 2026-08-16
decided-by: /dev
ratified: false
wayfinder: notes
grill-round: 11
needs-human: true
---

# Return note excerpts from discovery operations

## Status

Proposed by `/dev`. This decision has not been ratified by a human.

## Context

> should paginated list/search results return only note metadata plus a bounded plain-text excerpt, with full Markdown available exclusively through `get_note`, so sidebar and agent discovery never transfer every matching body?

Pagination bounds item count but not response size if every result contains its full body.

## Decision

Return note metadata and an approximately 200-character derived plain-text excerpt from list and search. Return the full Markdown body only from get. Search ranking and highlights are optional.

## Consequences

Sidebar and agent discovery payloads remain bounded. Clients perform a second request when they need complete content.
