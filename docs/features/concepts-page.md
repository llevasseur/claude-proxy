---
type: feature
title: Concepts page
description: A page over logs/concepts.jsonl — every term /teach has explained, with its one Simplified Technical English sentence, field, skills and date, indexed into the substrate and served newest first.
tags: [dashboard, teach, sqlite, architecture]
timestamp: 2026-08-03
---

# Concepts page

## Summary

A page in the [admin dashboard](admin-dashboard-for-claude-proxy-usage.md) over
`logs/concepts.jsonl`, the store the `/teach` command appends to. **Concepts** (`/concepts`) lists
every term that has been looked up with its one Simplified Technical English sentence, the field it
belongs to, the skills consulted while pinning it down, and when it was saved — newest first, and
live, because `/teach` writes from outside the server.

## Motivation

The store was **write-only**. `/teach` had been appending one JSON object per line since it
shipped, and nothing in the repo ever read the file back: the only way to see what had been taught
was to open the JSONL by hand. Vocabulary you cannot re-read is vocabulary you will look up twice.

It is also the smallest possible test of the claim ADR 0004 leaves standing — that the substrate is
a disposable view over the files. A new append-only store should reach a page through the existing
[`SidecarSource`](../adrs/0004-adopt-sqlite-as-the-query-substrate.md) seam without a new
mechanism, and this one does.

## Behavior

- `/api/concepts` returns the whole list. The store is one small file per device and nothing
  retracts a line, so there is no filter and no paging.
- **A term taught twice appears twice.** The file has no key and no supersede, unlike the command
  store; two rows for one term is the file's own reading of itself, and is itself worth seeing.
- `/api/concepts/stream` watches the log directory the store sits in, so a `/teach` run in another
  terminal lands on an open page without a reload.
- A device where `/teach` has never run shows an empty state, not an error. A line that will not
  parse — a torn final line from an interrupted append is the normal case — is skipped, and a
  record from a writer this code does not know is kept and rendered from the fields it has.

### Substrate

`server/src/db/ingest-concepts.ts` indexes the store into a `concept` table (plus `concept_skill`
for the array facet) at schema version 5, following the `command_run` precedent exactly:

- One `file_watermark` row keyed on `bytes` + `modified`. An unchanged store is not opened.
- A changed store is re-parsed whole and **every row replaced in one transaction**. That wholesale
  rebuild is the point — it is what keeps `rm logs/claude-proxy.db && pnpm --filter server ingest` a
  total recovery rather than a resync.
- The primary key is the line's position in the file, because the store has no natural key.
- The record round-trips through a `document` column, so a read answers with what the file said
  rather than something rebuilt from the columns beside it.

The read goes through the `SidecarSource` seam, so both backings answer identically and
`/api/concepts` is registered in the parity harness. The DB side re-checks its watermark against
`stat` and falls back to the file whenever a record landed between two ingest passes — the case
that is normal here, since `/teach` appends from outside the server.

## Acceptance criteria

- [x] `/concepts` lists every saved term with sentence, field, skills and local date, newest first.
- [x] The page follows the store live through `/api/concepts/stream`.
- [x] An absent store renders an empty state; a blank line, a torn final line, and a record that is
      not a concept are each skipped without emptying the page.
- [x] `rm logs/claude-proxy.db && pnpm --filter server ingest` reproduces the table exactly.
- [x] An unchanged store is skipped on its watermark; a changed one replaces every row rather than
      appending to them, `concept_skill` included.
- [x] Both backings answer `/api/concepts` identically, including when a record landed after the
      last ingest pass.

## Open questions

- Nothing groups by `field` or `skill` yet. Both are indexed columns and `concept_skill` exists
  precisely so a listing can group without unpacking every `document`, but no view uses them.
- Nothing links a concept to the session that taught it. The record carries no thread id, so the
  join would have to come from the store's writer rather than from here.

## Related

- [Admin dashboard for claude-proxy usage](admin-dashboard-for-claude-proxy-usage.md) — the shell
  this page is a station in.
- [Commands eval](commands-eval.md) — the other append-only JSONL store under `logs/`, and the
  precedent this ingester follows.
- [ADR 0004](../adrs/0004-adopt-sqlite-as-the-query-substrate.md) — why the table is a disposable
  view and the file is the source of truth.
