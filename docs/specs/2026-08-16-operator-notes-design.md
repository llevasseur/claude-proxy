---
type: design
title: Operator Notes — Design Spec
description: The shipped design for a hosted immutable Notes store, server-held credentials, MCP and REST access, live delivery, and a conflict-aware dashboard.
tags: [notes, operator, cloudflare, dashboard, design]
timestamp: 2026-08-16
scope: claude
---

# Operator Notes — Design Spec

**Date:** 2026-08-16  
**Status:** Shipped  
**Feature:** [Operator notes](../features/operator-notes.md)

## Problem and architecture

Operator knowledge needs a durable authored surface a human can edit visually and an agent can update
directly. Device-local files do not provide one identity across machines, while a mutable row would
erase one writer when concurrent saves race.

The existing `operator` Worker is authoritative because it already supplies one authenticated D1,
REST/MCP dispatch, and nightly private-repository backup. Notes add immutable `note_revision`, mutable
`note_current`, and current-content `note_fts`. `services/concepts/src/notes.ts` is the common domain
layer used by both hosted transports.

The local server is a credential boundary, not a second store. `server/src/notes-remote.ts` attaches
and redacts the token and preserves hosted statuses. `server/src/server.ts` validates same-origin
writes and adapts polling to deduplicated SSE. Shared DTOs and parsers live in `packages/core`; the
`/notes` admin route owns selection, pagination, serialized autosave, conflicts, archive/restore, and
responsive presentation.

## Invariants

- Full title and Markdown live in immutable revisions; the projection selects one.
- Only a successful content edit advances `version` and `updatedAt`.
- Every writer supplies `expectedVersion`; every stale attempt remains a conflict revision.
- Archive is reversible metadata. No delete or purge surface exists.
- Lists and search are compact and deterministic; get returns the full body.
- The bearer token terminates at the Worker and local server, never browser code.
- Missing or failed hosted configuration never changes the source of truth.
- A complete backup reconstructs revisions, projection, archive state, and FTS.

## ADR conformance

| ADR | Shipped mechanism | Deviation |
| --- | --- | --- |
| [0007](../adrs/0007-preserve-concurrent-note-edits.md) | revision log, compare-and-swap projection, retained losers, REST/MCP conflicts | None |
| [0008](../adrs/0008-archive-notes-instead-of-deleting.md) | archive/restore everywhere; no purge | None |
| [0009](../adrs/0009-autosave-notes-without-losing-drafts.md) | 700 ms serialized autosave; successful-edit order | None |
| [0010](../adrs/0010-use-markdown-for-note-content.md) | lossless strings and textarea editor | None |
| [0011](../adrs/0011-search-notes-in-the-first-release.md) | active current-revision FTS | None |
| [0012](../adrs/0012-keep-operator-credentials-out-of-the-browser.md) | required remote bridge, server token, trusted-origin writes | None |
| [0013](../adrs/0013-preserve-note-selection-during-live-updates.md) | `?note=` identity and dirty-draft preservation | None |
| [0014](../adrs/0014-paginate-note-lists-with-stable-cursors.md) | opaque `(updatedAt,id)` cursor; 50 default, 100 maximum | None |
| [0015](../adrs/0015-order-notes-strictly-by-recent-edit.md) | no pin field, route, or control | None |
| [0016](../adrs/0016-return-note-excerpts-from-discovery-operations.md) | metadata plus ≤200-character excerpt; get for body | None |
| [0017](../adrs/0017-allow-blank-note-titles.md) | blank stored; `Untitled` only in dashboard | None |

All eleven ADRs remain unratified and require human review. This records implementation conformance,
not ratification, and leaves the ADR files immutable.

## Failure and recovery

Malformed input and cursors fail without writing; missing notes are 404. Stale versions are 409 on
REST and structured tool output on MCP. Missing bridge configuration is 501; remote transport failure
or malformed success JSON is 502; a valid upstream non-2xx passes through. Live poll failure does not
substitute local data, and offline or failed dashboard saves retain the draft.

Nightly `notes.json` includes the projection and every revision. Recovery rebuilds both tables and
derives FTS from every revision. No automated importer ships, so the feature reference documents the
controlled manual sequence and validation counts.

## Evidence and limits

Automated tests cover the store, authenticated REST/MCP, backup, bridge, and DTOs; dashboard typecheck
and production build are gates. Supported in-app browser proof was attempted when the dashboard
shipped, but no backend was exposed, so no unsupported substitute was used. Desktop, responsive,
transition, live-selection, and draft-preservation evidence remains explicitly unavailable.

Rich-text storage, collaboration cursors, pinning, permanent deletion, attachments, automatic conflict
merging, browser-held operator credentials, a local Notes store, and an automated backup importer are
out of scope.
