---
type: adr
title: Search notes in the first release
description: Provide full-text search over note titles and Markdown bodies to people and agents from the first release.
tags: [architecture, notes, search, mcp]
timestamp: 2026-08-16
scope: claude
provenance:
  - repo: claude-proxy
    number: "0011"
    file: docs/adrs/0011-search-notes-in-the-first-release.md
decided-by: /dev
ratified: false
wayfinder: notes
grill-round: 5
needs-human: true
---

# Search notes in the first release

## Status

Proposed by `/dev`. This decision has not been ratified by a human.

## Context

> ADR 0005 chose D1 partly because FTS5/BM25 makes agent retrieval useful: must the first Notes release provide full-text search over title and Markdown body to both REST and MCP, or is chronological listing plus get-by-id the complete retrieval contract for now?

Chronological discovery alone weakens the agent interface and wastes the search substrate already selected for the operator Worker.

## Decision

Provide full-text search over title and Markdown body in the first release. Expose list, search, and get through the dashboard, REST, and MCP.

## Consequences

The initial migration must maintain an FTS projection and test ranking and filtering. Both human and agent clients can retrieve older notes without scanning every body.

## Provenance

Native to `claude-proxy`, this repository's own corpus. It kept its number through the
`monorepo-fusion` merge because the claude block sorts first by timestamp and its numbering
was already dense. See [the legacy map](legacy-map.md) for how every inherited identifier
resolves.
