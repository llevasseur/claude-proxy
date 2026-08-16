---
type: ticket
id: "01"
title: Operator notes store
description: Add immutable hosted notes with REST and MCP access to the existing operator Worker.
timestamp: 2026-08-16
map: wayfinder-notes
labels: ["wayfinder:task"]
assignee: null
blockedBy: []
status: open
branch: task/notes-01-operator-notes-store
lane: services-concepts
---

# Operator notes store

## Objective

Add Notes as a hosted authored dataset in the existing `services/concepts` operator Worker so REST and MCP clients share one canonical implementation.

## Ownership

Own `services/concepts/**` only. Do not edit the local server, dashboard, or shared package in this ticket.

## Criteria

- Add D1 migration `0003` for immutable note revisions, a current-note projection, archive state, and FTS over title and Markdown body.
- Implement shared domain semantics once and reuse them from REST and MCP handlers.
- Provide authenticated REST operations for cursor list, full-text search, get, create, expected-version update, archive, and restore.
- Provide discoverable, internally consistent MCP tools for the same operations. Name each tool and its input/output schema plainly enough that an agent can use it without repository knowledge.
- Require an expected version for update. Preserve both revisions when writers race, return HTTP 409 from REST, and return a structured stale-version conflict from MCP.
- Order active-note lists by `updatedAt DESC, id DESC`. Use an opaque cursor, default limit 50, bounded maximum, and `nextCursor`.
- Return metadata and an approximately 200-character derived plain-text excerpt from list/search. Return full Markdown from get only.
- Persist a separate plain-text title and Markdown body without transformations. Permit a blank stored title.
- Advance `updatedAt` only after a successful title/body change. Reads, no-op updates, failures, archive, and restore do not reorder a note.
- Implement reversible archive and restore. Expose no permanent purge through REST or MCP.
- Extend the nightly operator backup and restore/export coverage to include all note revisions and archive state.
- Enforce the existing operator token on every Notes REST and MCP operation.
- Add focused Worker, SQL, REST, MCP, auth, FTS, pagination, backup, archive, and concurrency tests.

## Verification

- Run the `services/concepts` typecheck and tests, including the production migration against the repository's SQLite test substrate.
- Demonstrate that two updates carrying the same expected version produce one commit and one structured conflict while retaining both attempted contents for reconciliation.
