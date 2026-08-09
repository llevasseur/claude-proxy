---
type: feature
title: Concepts page
description: A page over logs/concepts.jsonl — every term /teach has explained, with its one Simplified Technical English sentence, field, skills and date, sortable, indexed into the substrate, and each row opening a detail page of the research behind it.
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

- `/api/concepts` returns the whole list. The store is small and nothing retracts a record, so
  there is no filter and no paging.
- **Which store answers depends on two environment variables.** With `CONCEPTS_URL` and
  `CONCEPTS_TOKEN` both set, the list and the detail route read the hosted store — the
  [Worker over D1](../adrs/0005-host-the-concept-store.md) that `/teach` posts to from every
  device — so a concept taught on another machine is on the page. With either unset,
  `logs/concepts.jsonl` answers exactly as it did before, which is what keeps a checkout with no
  credentials rendering the page rather than erroring.
- **The answer names the store it came from**, in `meta.storePath`, which the page already
  prints: the Worker's read URL when it answered, and the local file's path *with the reason*
  (`CONCEPTS_URL/CONCEPTS_TOKEN unset`) when it did not. A page reading the local file on a
  device whose concepts live in the hosted store looks empty and correct, and that ambiguity —
  not the read itself — is what made a saved concept look lost.
- **A configured store that will not answer is a 502, never a quiet fallback**, on the stream
  routes as well as the two request routes. Falling back to the local file on a failed remote read
  would reproduce the same wrong-store-looks-fine page the labelling exists to prevent, so the read
  fails and the page shows an error.
- The hosted read goes to `GET /api/concepts/export` rather than the compact listing route: the
  export carries the optional detail fields the detail page renders and every version of a term,
  which is the local file's own reading of itself. One request answers both routes.
- **A term taught twice appears twice.** The file has no key and no supersede, unlike the command
  store; two rows for one term is the file's own reading of itself, and is itself worth seeing.
- `/api/concepts/stream` watches the log directory the store sits in, so a `/teach` run in another
  terminal lands on an open page without a reload.
- A device where `/teach` has never run shows an empty state, not an error. A line that will not
  parse — a torn final line from an interrupted append is the normal case — is skipped, and a
  record from a writer this code does not know is kept and rendered from the fields it has.
- **Term, Field and Saved sort**, client-side over the list already in hand. Saved descending is the
  default, so an untouched page reads exactly as it did before sorting existed. Ties fall back to
  file position, newest first, so equal values keep a stable order between renders.
- The **Term** column is sized to its own longest value and does not wrap; **Explanation** takes
  whatever is left and wraps inside it. A term is a short label that reads worse broken across
  lines, and a sentence does not.
- **Meta-skills are never listed.** `find-skills` is the skill that finds skills — its presence says
  the run looked for skills, not that the concept relates to it. `withoutMetaSkills` in
  `packages/core/src/concepts.ts` drops it, applied once in `buildConcepts`/`buildConcept` rather
  than in the store or the table: the file keeps every word `/teach` wrote, and only the served
  answer is trimmed.

### Detail page

- **Clicking a row opens `/concepts/$ord`**, served by `/api/concepts/concept?ord=N` and following
  the store live like the list does. A missing line is a 404, which is what a stale link looks like
  after the store is rebuilt from a shorter file.
- `ord` is the **line the record sits on in the file**, assigned before the list is sorted. The term
  cannot be the address precisely because a term can be taught twice, and the store has no other key.
- The page renders the sentence and skills, then four fields that are all **optional**: `notes` (the
  research, as Markdown), `tips`, `sources`, and `surfacedSkills` — the skills a run turned up while
  researching, as against those it applied.
- **Absent is not empty.** `/teach` learned to record research detail after the first concepts were
  already saved, so older records simply do not carry it. `normalizeConcept` leaves an unrecorded
  field off the object rather than defaulting it, the page renders no section for it, and a record
  with none of them says so once instead of showing four empty cards.

### Substrate

`server/src/db/ingest-concepts.ts` indexes the store into a `concept` table (plus `concept_skill`
for the array facet, and `concept_item` for the detail lists) at schema version 6, following the
`command_run` precedent exactly:

- One `file_watermark` row keyed on `bytes` + `modified`. An unchanged store is not opened.
- A changed store is re-parsed whole and **every row replaced in one transaction**. That wholesale
  rebuild is the point — it is what keeps `rm logs/claude-proxy.db && pnpm --filter server ingest` a
  total recovery rather than a resync.
- The primary key is the line's position in the file, because the store has no natural key.
- The record round-trips through a `document` column, so a read answers with what the file said
  rather than something rebuilt from the columns beside it. That is also what preserves the
  absent-versus-empty distinction the detail page depends on — the columns cannot express it.
- `tips`, `sources` and `surfacedSkills` share one `concept_item(ord, kind, item_ord, item)` table
  rather than three near-identical ones, because only `skill` is a real grouping question and only
  it earned its own table.
- Version 6 deletes the `concepts.jsonl` watermark row as part of the migration. Adding columns does
  not change the file, so without that the watermark would match on the next pass and the new
  columns would stay empty on an existing database.

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
- [x] Term, Field and Saved sort in both directions; Saved descending is the default.
- [x] The Term column fits its longest value without wrapping and Explanation absorbs the rest.
- [x] `find-skills` never appears in either skill list on the page, while the store keeps it.
- [x] A row click opens `/concepts/$ord`; an `ord` the store does not hold returns 404.
- [x] The detail page renders `notes`, `tips`, `sources` and `surfacedSkills` when recorded and
      nothing at all when not; a record predating them still renders.
- [x] Both backings answer `/api/concepts/concept` identically for every `ord` the list returns.

## Open questions

- Nothing groups by `field` or `skill` yet. Both are indexed columns and `concept_skill` exists
  precisely so a listing can group without unpacking every `document`, but no view uses them.
- Nothing links a concept to the session that taught it. The record carries no thread id, so the
  join would have to come from the store's writer rather than from here.
- **`/teach` does not yet write the detail fields.** The contract accepts `notes`, `tips`, `sources`
  and `surfacedSkills`, the table carries them, and the detail page renders them — but the command
  lives outside this repo and still writes only the original five fields, so today every record
  takes the absent path. Teaching it to write them (and to stop recording `find-skills` at the
  source, rather than relying on the read-side filter) is a change in the command's own repo.

## Related

- [Admin dashboard for claude-proxy usage](admin-dashboard-for-claude-proxy-usage.md) — the shell
  this page is a station in.
- [Commands eval](commands-eval.md) — the other append-only JSONL store under `logs/`, and the
  precedent this ingester follows.
- [ADR 0004](../adrs/0004-adopt-sqlite-as-the-query-substrate.md) — why the table is a disposable
  view and the file is the source of truth.
