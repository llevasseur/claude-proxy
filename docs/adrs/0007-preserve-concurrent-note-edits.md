---
type: adr
title: Preserve concurrent note edits with immutable revisions
description: Require an expected version for note writes and reject stale updates without destroying either edit.
tags: [architecture, notes, storage, concurrency, mcp]
timestamp: 2026-08-16
decided-by: /dev
ratified: false
wayfinder: notes
grill-round: 1
needs-human: true
---

# Preserve concurrent note edits with immutable revisions

## Status

Proposed by `/dev`. This decision has not been ratified by a human.

## Context

> ADR 0006 says a third operator dataset belongs there only when it is authored state with no reconstructible file, while ADR 0005 uses append-only versions and derived IDs to make retries idempotent: when a human editor and an MCP agent update the same note from the same prior version, must the second write be rejected as a version conflict (preserving both edits for reconciliation), or may last-write-wins silently replace the first edit?

Notes is authored state with concurrent human and agent writers. Silent last-write-wins would discard a valid edit and hide the collision.

## Decision

Store immutable note revisions and maintain a current-note projection. Every update MUST carry the expected current version. A stale REST update returns HTTP 409, and a stale MCP update returns a structured conflict. Preserve both attempted edits for reconciliation.

## Consequences

Clients must retain drafts until the expected version commits. History and conflict evidence remain recoverable, while updates require explicit conflict handling.
