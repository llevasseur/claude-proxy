---
type: ticket
id: "04"
title: Notes documentation and verification
description: Reconcile durable Notes documentation and complete end-to-end verification without expanding feature scope.
timestamp: 2026-08-16
map: wayfinder-notes
labels: ["wayfinder:task"]
assignee: null
blockedBy: ["01", "02", "03"]
status: open
branch: task/notes-04-notes-docs-and-verification
lane: docs-and-cross-layer-verification
---

# Notes documentation and verification

## Objective

Reconcile the complete Notes feature across durable documentation and cross-layer verification, fixing only defects needed to make the agreed contracts pass end to end.

## Ownership

Own the durable Notes feature/spec documentation, relevant README material, and cross-layer verification fixes. Avoid feature expansion and avoid refactoring unrelated code.

## Dependencies

Blocked by tasks 01, 02, and 03. Verify what landed rather than rewriting the earlier plans as claims.

## Criteria

- Add or update durable feature and design documentation for the operator data model, local bridge, dashboard interaction, REST contract, MCP tools, security boundary, expected-version concurrency, archive/restore, search, ordering, pagination, excerpts, polling/SSE, and backup/restore.
- Link the eleven Notes ADRs and state where the implementation follows or deviates from them.
- Document every operator Notes REST endpoint and MCP tool with authentication, input, output, errors, version semantics, cursor semantics, and examples.
- Document server-only credential configuration and the absence of a local fallback.
- Document backup recovery for immutable revisions and archived notes.
- Run end-to-end operator unit/integration coverage through REST and MCP, including auth and stale-version conflicts.
- Obtain dashboard browser proof for the complete human workflow and live agent-write behavior.
- Fix only cross-layer contract defects necessary for the agreed feature and verification gates. Record any larger follow-up instead of expanding scope.
- Run `my-command-tools verify` from the repository root and leave every gate green.

## Verification

- `okq validate` and generated documentation indexes are current.
- `my-command-tools verify` passes.
- The final report links operator tests and browser evidence for both desktop and responsive layouts.
