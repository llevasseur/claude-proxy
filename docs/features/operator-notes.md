---
type: feature
title: Operator notes
description: Authored Markdown shared by humans and agents through one hosted revision-preserving store, a server-side bridge, and a responsive dashboard.
tags: [notes, operator, dashboard, mcp, rest]
timestamp: 2026-08-16
scope: claude
---

# Operator notes

## Summary and trust boundary

Operator Notes is one notebook across machines, people, and agents. The `operator` Cloudflare Worker
owns the D1 data and exposes authenticated REST and MCP. The local Node server proxies REST without
exposing the bearer token; the admin dashboard supplies `/notes`. There is no local fallback: an
unconfigured bridge returns `501`, while transport failure or malformed successful JSON returns `502`.

```
agent ──Bearer──▶ operator /mcp ─┐
                                ├──▶ D1 revision + current projection + FTS
browser ─▶ local Node server ────┘
              └──Bearer──▶ operator REST
```

The Worker checks `CONCEPTS_TOKEN` before opening D1. The local bridge reads `NOTES_URL` and
`NOTES_TOKEN`, falling back only to operator-wide `CONCEPTS_URL` and `CONCEPTS_TOKEN`. Credentials
stay server-side and are redacted from transport errors. The browser calls same-origin routes only;
writes also require a trusted local `Origin`.

## Storage, conflicts, and archive

Titles are plain text and bodies are Markdown, both stored byte-for-byte. Blank titles are valid;
only the dashboard renders **Untitled**. `note_revision` retains creates, content-changing updates,
and stale attempts as `committed`, `conflict`, or transient `pending`; a byte-identical no-op creates
no revision. `note_current` points to the committed revision and carries `version`, timestamps, and
reversible `archivedAt`. `note_fts` indexes revision content.

Every update carries the last observed `expectedVersion`. A match commits a revision, increments the
version, and moves the note to the top. A stale write is retained as a conflict revision while the
projection stays unchanged. Partial stale updates are reconstructed from the expected base revision,
not accidentally mixed with newer content. A byte-identical update is a no-op. Archive and restore
change neither version nor edit order, and no purge exists.

## Browse, search, selection, and autosave

Active and archived lists are separate and ordered by `(updatedAt DESC, id DESC)`. Pages default to 50
and cap at 100. `nextCursor` is opaque and must be returned unchanged. List and search contain metadata
and a plain-text excerpt of at most 200 characters; fetch by id for the full body. Search covers active
current titles and bodies only.

Dashboard selection lives in `?note=<id>` and archive mode in `?archived=true`. It selects the newest
row only on initial entry. Search, pagination, and live refresh do not silently replace selection.
Dirty or saving drafts block navigation, creation, and view changes; a changed or missing selected row
puts the preserved draft into conflict instead of overwriting it.

The editor serializes writes and autosaves 700 ms after the latest edit. It reports idle, saving,
saved, offline, error, and conflict. A conflict can accept the remote version or retry the local draft
against the latest version; the losing original remains in history.

Recent view with no search subscribes to `GET /api/notes/stream?limit=50&archived=false`. The local
server polls the hosted list every `NOTES_POLL_MS` (5 seconds by default), emits an SSE `snapshot`, and
sends `update` only when JSON changes. Comment heartbeats keep the stream open. Search, archive view,
and later pages remain request-driven.

## Hosted REST API

Every operator route requires `Authorization: Bearer $CONCEPTS_TOKEN`; a missing or invalid token is
`401` before D1 is opened. Validation and cursor failures are `400`, missing notes are `404`, and
stale updates are `409` with structured conflict fields.

| Route | Input | Success |
| --- | --- | --- |
| `GET /api/notes` | `cursor?`, `limit?`, `archived=true?` | `200` `{ notes, nextCursor }` |
| `GET /api/notes/search` | required `q`; `cursor?`, `limit?` | `200` active-note page |
| `GET /api/notes/note` | required `id` | `200` `{ note }` with full body |
| `POST /api/notes` | `{ title: string, body: string }` | `201` `{ note }`, version 1 |
| `POST /api/notes/update` | `{ id, expectedVersion, title?, body? }` | `200` `{ note, changed }` or `409` conflict |
| `POST /api/notes/archive` | `{ id }` | `200` `{ note }` with `archivedAt` |
| `POST /api/notes/restore` | `{ id }` | `200` `{ note }` with `archivedAt: null` |

```sh
curl -H "Authorization: Bearer $CONCEPTS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Deploy","body":"## Checklist\n\n- Verify"}' "$CONCEPTS_URL/api/notes"
```

```json
{
  "conflict": true,
  "code": "stale_version",
  "noteId": "<note-id>",
  "expectedVersion": 1,
  "currentVersion": 2,
  "attemptedRevisionId": "<revision-id>"
}
```

The local bridge uses the same reads at `/api/notes`, `/search`, and `/note`; create is
`/api/notes/create`, followed by `/update`, `/archive`, and `/restore`. It preserves upstream status
and conflict bodies rather than translating them or switching stores.

## MCP tools

`POST /mcp` uses the operator's stateless modern MCP protocol and the same bearer token. Validation
and missing ids are tool errors. Stale updates return structured content so an agent can act on the
current version and retained attempt.

| Tool | Input | Output and errors |
| --- | --- | --- |
| `notes_list` | `{ cursor?, limit?, archived? }` | metadata/excerpt page; invalid paging is an error |
| `notes_search` | `{ query, cursor?, limit? }` | active metadata/excerpt page; blank query is an error |
| `notes_get` | `{ id }` | `{ note }` with full Markdown; unknown id is an error |
| `notes_create` | `{ title, body }` | `{ note }` at version 1; both strings required |
| `notes_update` | `{ id, expectedVersion, title?, body? }` | `{ note, changed }` or `stale_version` conflict |
| `notes_archive` | `{ id }` | `{ note }`; unknown id is an error |
| `notes_restore` | `{ id }` | `{ note }`; version and recency unchanged |

```json
{ "name": "notes_search", "arguments": { "query": "deployment checklist", "limit": 20 } }
```

```json
{ "name": "notes_update", "arguments": { "id": "<note-id>", "expectedVersion": 3, "title": "Deploy" } }
```

## Backup and recovery

The daily cron writes `notes.json` to the private backup repository. It contains the complete current
projection and every revision, including conflicts and archive state; unchanged bytes create no
commit, and the interval bounds unreplicated loss to one day.

There is no automated Notes importer. Recover into a clean migrated D1 database: insert every
`revisions` row into `note_revision`, then every `notes` row into `note_current`; rebuild `note_fts`
from every revision; verify that every pointer resolves and versions, archive timestamps, and active,
archived, revision, and conflict counts match. Use one controlled transaction or an offline replacement
database so no client observes a partial projection. Never restore current bodies alone, which would
discard immutable history and losing writes.

## Verification and visual evidence

Automated domain, REST, MCP, bridge, and dashboard gates cover ordering, cursors, excerpts, search,
archive/restore, no-op edits, retained conflicts, auth-before-D1, token redaction, status preservation,
polling dedupe, and backup completeness. The dashboard has typecheck/build coverage but no test suite.

When the dashboard shipped, Vite served `/notes` on its actual port, but the supported in-app browser
exposed no backend. Desktop, responsive, transition, live-selection, and draft-preservation proof could
not be captured. This is missing evidence, not a browser-verification claim, and must be retried when
the supported backend exists.

## Decisions

The implementation follows [0007 immutable revisions](../adrs/0007-preserve-concurrent-note-edits.md),
[0008 archive](../adrs/0008-archive-notes-instead-of-deleting.md), [0009 autosave and
ordering](../adrs/0009-autosave-notes-without-losing-drafts.md), [0010 plain title and
Markdown](../adrs/0010-use-markdown-for-note-content.md), [0011 search](../adrs/0011-search-notes-in-the-first-release.md),
[0012 local token boundary](../adrs/0012-keep-operator-credentials-out-of-the-browser.md), [0013 URL
identity](../adrs/0013-preserve-note-selection-during-live-updates.md), [0014 opaque cursors](../adrs/0014-paginate-note-lists-with-stable-cursors.md),
[0015 no pinning](../adrs/0015-order-notes-strictly-by-recent-edit.md), [0016 compact
results](../adrs/0016-return-note-excerpts-from-discovery-operations.md), and [0017 presentation-only
Untitled](../adrs/0017-allow-blank-note-titles.md), with no known deviation.
All remain `ratified: false` and `needs-human: true`; implementation conformance is not ratification.
