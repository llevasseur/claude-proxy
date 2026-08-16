---
type: adr
title: Archive notes instead of deleting them
description: Expose reversible archive and restore operations while withholding permanent purge from agents and the dashboard.
tags: [architecture, notes, lifecycle, mcp]
timestamp: 2026-08-16
decided-by: /dev
ratified: false
wayfinder: notes
grill-round: 2
needs-human: true
---

# Archive notes instead of deleting them

## Status

Proposed by `/dev`. This decision has not been ratified by a human.

## Context

> ADR 0005 deliberately gives every operator client one write-capable token, and ADR 0006 reuses that same trust boundary; should the Notes MCP expose deletion to agents at all, and if so must “delete” be a reversible archive/tombstone that disappears from the default list but remains recoverable, rather than a permanent row/revision purge?

Every authenticated agent can write. A destructive tool would turn an ordinary agent error into unrecoverable data loss.

## Decision

Expose archive and restore operations to the dashboard, REST, and MCP. Archived notes disappear from the default list but remain recoverable. Expose no permanent purge operation.

## Consequences

Storage grows with retained history. Operators gain a reversible lifecycle and agents cannot permanently erase note revisions.
