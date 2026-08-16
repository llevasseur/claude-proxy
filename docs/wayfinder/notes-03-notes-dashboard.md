---
type: ticket
id: "03"
title: Notes dashboard
description: Add an Activity Notes workspace with recency navigation, search, autosave, and conflict-safe live updates.
timestamp: 2026-08-16
map: wayfinder-notes
labels: ["wayfinder:task"]
assignee: null
blockedBy: ["02"]
status: open
branch: task/notes-03-notes-dashboard
lane: apps-admin
---

# Notes dashboard

## Objective

Add an Activity-station Notes page with a recent-notes list and a focused Markdown editor that remains safe under concurrent human and agent edits.

## Ownership

Own `apps/admin/**` only. Do not edit the operator Worker, local server, or shared core package.

## Dependencies

Blocked by task 02. Consume its typed local routes and SSE contract.

## Criteria

- Add a `/notes` route and registry entry under the Activity navigation station. Preserve the repository's route-local `createRoute`, literal `as const`, `satisfies NavEntry`, and registry-order invariants.
- Build a full-bleed two-pane notes workspace: searchable recent-note list/sidebar and title/Markdown-body editor. Preserve the dashboard token scale and component conventions.
- Order notes by `updatedAt DESC, id DESC`. Open the newest note only on initial entry without an explicit note id.
- Put the selected note id in the URL. Never steal selection when polling or SSE moves another note to the top.
- Support cursor pagination and full-text search without fetching full bodies for discovery results.
- Render a blank title as `Untitled` without writing that label into storage.
- Debounce autosave. Show idle, saving, saved, error, offline, and conflict states, and retain the local draft after every failed or stale save.
- Update list ordering only from a successful server commit. Do not optimistically reorder on typing.
- Refresh a clean selected note after an agent edit. Preserve a dirty draft and show a conflict/reconciliation banner if the remote version changes or the selected note disappears.
- Support reversible archive and restore. Provide no permanent-delete control and no pinning control.
- Make the layout responsive and keyboard accessible, with labelled controls, visible focus, practical empty/loading/error states, and reduced-motion behavior.
- Add browser-visible timestamps and excerpts that support scanning without presenting raw Markdown syntax as the summary.

## Verification

- Run the admin typecheck, build, and repository checks that cover CSS tokens and route types.
- Start the client, read its actual bound port, confirm the supported browser backend immediately, and collect visual browser proof for desktop and narrow layouts.
- Exercise initial newest selection, URL selection, search, pagination, create/edit autosave, stale conflict, live agent update without selection theft, archive, restore, errors, keyboard use, and reduced motion.
