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
<!-- okq:index:end -->
