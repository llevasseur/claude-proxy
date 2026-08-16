---
type: map
title: "Wayfinder: Notes"
description: Campaign map for hosted Markdown notes shared by the dashboard, REST clients, and MCP agents.
label: wayfinder:map
slug: notes
timestamp: 2026-08-16
---

# Wayfinder — Notes

**Slug:** `notes`
**Base branch:** `wayfinder/notes` (cut from the default branch; every ticket targets it)
**Plans directory:** `docs/wayfinder/`
**Started:** 2026-08-16
**Goal:** Ship a hosted Markdown notes system that people edit in the Activity dashboard and agents access through the operator MCP.

> Ephemeral scaffolding, deleted when the wayfinder closes. The durable output is
> the merged code and the repository's feature, spec, and decision docs.

## Product direction

Apple Notes establishes the changed-most-recently-first list and the familiar sidebar/list/editor hierarchy. Notion establishes recent navigation, search by last edit, and agent create/edit access. Notes adopts those useful interaction patterns while keeping one deliberately smaller canonical model: a plain-text title and Markdown body.

Official references:

- [Sort and pin notes on Mac](https://support.apple.com/en-asia/guide/notes/apdb54e469b6/mac)
- [Change the Notes view on Mac](https://support.apple.com/en-gb/guide/notes/apd8b73d28be/mac)
- [Navigate with the sidebar](https://www.notion.com/help/navigate-with-the-sidebar)
- [Search in your workspace](https://www.notion.com/en-gb/help/search)
- [Notion Agent](https://www.notion.com/help/notion-agent)

## Standing decisions

- Store immutable revisions and require the expected current version on updates. Return HTTP 409 or a structured MCP conflict without destroying either edit.
- Archive and restore notes. Expose no permanent purge.
- Debounce autosaves, retain drafts on failure, and reorder only after a successful title or body commit.
- Keep the canonical document as a plain-text title plus Markdown body.
- Provide list, get, and full-text search in the dashboard, REST API, and MCP.
- Keep operator credentials in the local server. The browser calls only that server, and write routes check origin.
- Never let polling steal the selected note or unsaved draft. Open the newest note only on initial entry without an explicit note id.
- Reuse the existing poll, diff, and SSE pattern from ADR 0006. Refresh clean selected notes and surface conflicts for dirty drafts.
- Use opaque cursor pagination ordered by `updatedAt DESC, id DESC`, with a default page size of 50 and a bounded maximum.
- Keep pinning out of scope so all active notes follow strict recency order.
- Return metadata and an approximately 200-character derived plain-text excerpt in list and search results. Return full Markdown only from get.
- Persist blank titles and render `Untitled` as presentation-only fallback text.

## Active tasks

| # | Task | Plan | Branch | Status |
|---|------|------|--------|--------|
| 01 | operator-notes-store | [notes-01-operator-notes-store](notes-01-operator-notes-store.md) | `task/notes-01-operator-notes-store` | todo |
| 02 | notes-local-api | [notes-02-notes-local-api](notes-02-notes-local-api.md) | `task/notes-02-notes-local-api` | todo |
| 03 | notes-dashboard | [notes-03-notes-dashboard](notes-03-notes-dashboard.md) | `task/notes-03-notes-dashboard` | todo |
| 04 | notes-docs-and-verification | [notes-04-notes-docs-and-verification](notes-04-notes-docs-and-verification.md) | `task/notes-04-notes-docs-and-verification` | todo |

## Completed

<!-- newest first; one entry appended per task completion -->

## Agent kickoff prompt

Read the repository instructions, the installed wayfinder workflow, and `docs/wayfinder/wayfinder-notes.md`. Inspect live Git and worktree state. Execute the next unblocked active task by running the task workflow against its linked plan with `wayfinder/notes` as the base branch. Retarget the resulting pull request to `wayfinder/notes`. Stop after opening the pull request.
