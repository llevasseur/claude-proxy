# Architecture Decision Records

Numbered records of significant, hard-to-reverse decisions. The convention itself is
recorded in [0001 — Record architecture decisions](0001-record-architecture-decisions.md):
decisions are append-only, so a reversal is a new ADR that supersedes the old one rather
than an edit. List them:

    okq find --type adr

Add one with `okq new adr "<title>"`.

<!-- okq:index:begin -->
### Concepts

| Title | File |
|-------|------|
| Record architecture decisions | [0001-record-architecture-decisions.md](0001-record-architecture-decisions.md) |
| Monorepo with pnpm, TanStack, and Node | [0002-monorepo-with-pnpm-tanstack-and-node.md](0002-monorepo-with-pnpm-tanstack-and-node.md) |
| Allow narrowly scoped writes in the local server | [0003-allow-narrowly-scoped-writes-in-the-local-server.md](0003-allow-narrowly-scoped-writes-in-the-local-server.md) |
| Adopt SQLite as the query substrate over the log files | [0004-adopt-sqlite-as-the-query-substrate.md](0004-adopt-sqlite-as-the-query-substrate.md) |
| Host the concept store as a Cloudflare Worker over D1 | [0005-host-the-concept-store.md](0005-host-the-concept-store.md) |
| Host the ideas ledger on the existing operator Worker | [0006-host-the-ideas-ledger.md](0006-host-the-ideas-ledger.md) |
| Preserve concurrent note edits with immutable revisions | [0007-preserve-concurrent-note-edits.md](0007-preserve-concurrent-note-edits.md) |
| Archive notes instead of deleting them | [0008-archive-notes-instead-of-deleting.md](0008-archive-notes-instead-of-deleting.md) |
| Autosave notes without losing drafts | [0009-autosave-notes-without-losing-drafts.md](0009-autosave-notes-without-losing-drafts.md) |
| Use Markdown for note content | [0010-use-markdown-for-note-content.md](0010-use-markdown-for-note-content.md) |
| Search notes in the first release | [0011-search-notes-in-the-first-release.md](0011-search-notes-in-the-first-release.md) |
| Keep operator credentials out of the browser | [0012-keep-operator-credentials-out-of-the-browser.md](0012-keep-operator-credentials-out-of-the-browser.md) |
| Preserve note selection during live updates | [0013-preserve-note-selection-during-live-updates.md](0013-preserve-note-selection-during-live-updates.md) |
| Paginate note lists with stable cursors | [0014-paginate-note-lists-with-stable-cursors.md](0014-paginate-note-lists-with-stable-cursors.md) |
| Order notes strictly by recent edit | [0015-order-notes-strictly-by-recent-edit.md](0015-order-notes-strictly-by-recent-edit.md) |
| Return note excerpts from discovery operations | [0016-return-note-excerpts-from-discovery-operations.md](0016-return-note-excerpts-from-discovery-operations.md) |
| Allow blank note titles | [0017-allow-blank-note-titles.md](0017-allow-blank-note-titles.md) |
| Keep port defaults verbatim and scope environment variable names per stack | [0050-stack-scoped-environment-variables.md](0050-stack-scoped-environment-variables.md) |
| Absorb ox into the shared lint gate at a warn tier, and split its delta by fixability | [0051-absorb-ox-into-the-shared-lint-gate.md](0051-absorb-ox-into-the-shared-lint-gate.md) |
| Inherited ratification flags survive the merge unchanged | [0052-inherited-ratification-flags-survive-the-merge.md](0052-inherited-ratification-flags-survive-the-merge.md) |
| The merged ADR record replaces both sources rather than joining them | [0053-the-merged-corpus-replaces-its-sources.md](0053-the-merged-corpus-replaces-its-sources.md) |
| Each stack keeps its own corpus at its own stack root | [0054-each-stack-keeps-its-own-corpus-root.md](0054-each-stack-keeps-its-own-corpus-root.md) |
| The package rename covers every non-import reference, gated by a grep | [0055-the-rename-covers-every-non-import-reference.md](0055-the-rename-covers-every-non-import-reference.md) |
| The docs gate asserts section indexes by file, and permits links out to source | [0056-the-docs-gate-asserts-indexes-by-file.md](0056-the-docs-gate-asserts-indexes-by-file.md) |
| The filter gate covers invocations, not records | [0057-the-filter-gate-covers-invocations-not-records.md](0057-the-filter-gate-covers-invocations-not-records.md) |
<!-- okq:index:end -->
