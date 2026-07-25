---
type: feature
title: Project memory browser
description: A dashboard section that browses Claude Code's own per-project auto-memory files on this device, read-only.
tags: [dashboard, backend, frontend]
timestamp: 2026-07-24
---

# Project memory browser

## Summary

A **Projects** section in the [admin dashboard](admin-dashboard-for-claude-proxy-usage.md)
that browses Claude Code's own per-project auto-memory files on this device: every project
that has written memories, that project's `*.md` memory files with size and mtime, and any
single file rendered in full. Three levels — `/projects`, `/projects/$project`,
`/projects/$project/memory/$name` — served by three read-only `GET` endpoints over
`~/.claude/projects`. It never writes.

## Motivation

Claude Code accumulates auto-memory as flat `*.md` files under its own state directory,
one `memory/` dir per project (with `MEMORY.md` as the index). Those files shape what
Claude recalls in later sessions, but they live in path-encoded directories like
`-Users-me-Documents-app` — unlistable by eye, easy to forget, and hard to compare across
projects. Reading them in one place answers the questions the filesystem hides: *which
projects have memory at all, how much, which files are stale, and what does a given memory
actually say* — before you wonder why Claude "remembers" something surprising.

Unlike the rest of the analytics, this reads **device config, not proxy traffic**: its data
comes from files Claude Code writes for itself, never from the proxy's audit logs. It shares
that property with **Hooks & Plugins** and **Proxy filters** (see [Config inventory](config-inventory.md)),
but it is the only part of the dashboard that reads Claude Code's per-project state
directory.

## Behavior

- **Where the data comes from** — `resolveProjectsDir()` in `server/src/projects.ts` uses
  the `CLAUDE_PROJECTS` env var when set (`path.resolve`d, so a relative value is anchored
  to the server's cwd), otherwise the default `~/.claude/projects` (`os.homedir()` +
  `.claude/projects`). It is resolved once at server start into `PROJECTS_DIR`.
- **Projects list** (`/projects`) — nav station **Projects** (hint `memory`), subtitled
  "Claude Code projects with saved memories", with the resolved projects directory printed
  above the table. Columns **Project** and **Memories** plus a proportional bar; default
  sort **Memories** descending, click a column to sort and again to flip direction. Rows are
  clickable (the name is also a keyboard-focusable link). `listProjects` counts `*.md` files
  in each `<project>/memory/` dir and **omits projects that have no `memory/` dir at all**,
  so the list is exactly "projects with saved memories"; server-side order is count desc,
  then name. Empty state: "No projects with memories found."
- **Per-project memory list** (`/projects/$project`) — heading **Project memories** with
  breadcrumbs **Projects › Project memories** and the encoded project directory name shown
  below. Columns **File**, **Size**, **Modified**; default sort **Size** descending, also
  sortable by file and modified. `MEMORY.md` is pinned first server-side (the rest
  alphabetical) and tagged **· index** in the row. A project directory that exists but has
  no `memory/` subdir yields an empty list ("This project has no memory files."), while a
  project that does not exist at all is a 404.
- **Single-memory viewer** (`/projects/$project/memory/$name`) — titled with the file name,
  stat tiles for **Size** and **Modified** (plus **Type** when the file's frontmatter
  carries a nested `type:`), then a **Memory** card with a segmented **Pretty** / **Raw**
  toggle. **Pretty** (the default) splits any leading `--- … ---` frontmatter into a
  definition list and renders the body through the dependency-free `Markdown` component —
  headings, fenced code, blockquotes, lists, inline code/bold/italic/links, and Obsidian
  `[[wikilinks]]` shown as code. **Raw** shows the file's exact bytes in a `<pre>`.
- **Endpoints** — `GET /api/projects` (no params) returns
  `{ projects: [{ name, memoryCount }], meta: { projectsDir, total } }`.
  `GET /api/projects/memories?project=<dir>` returns
  `{ project, files: [{ name, bytes, modified }], meta: { total } }` — **400** on a missing
  `?project=` (`missing ?project=`) or an invalid project name, **404** on `project not found`.
  `GET /api/projects/memory?project=<dir>&name=<file.md>` returns
  `{ memory: { project, name, content, bytes, modified } }` — **400** when either param is
  missing (`missing ?project= or ?name=`) or either name is invalid, **404** on
  `project not found` / `memory file not found`. `modified` is an ISO 8601 (UTC) mtime.
- **Path safety** — both names arrive from the URL, so both are validated before any disk
  access. A project name must match `/^[0-9A-Za-z._+-]+$/` (no separators; `+` is allowed
  because worktree dirs use it) *and* resolve to a direct child of the projects root
  (`path.dirname(resolved) === path.resolve(projectsDir)`). A memory name must match
  `/^[0-9A-Za-z._-]+\.md$/` *and* resolve directly inside that project's `memory/` dir.
  Traversal (`../`, absolute paths, nested paths) is rejected as **400**, not attempted.

Data path: `~/.claude/projects` → `server/src/projects.ts` (discovery, counting, validated
reads) → `server/src/api.ts` (`buildProjects` / `buildProjectMemories` / `buildMemory`) →
`server/src/server.ts` routes → `apps/admin` (`routes/projects.tsx`,
`routes/project-detail.tsx`, `routes/memory-detail.tsx`). No proxy involvement and no audit
sidecars are read anywhere along it.

## Acceptance criteria

- [x] The projects directory is `CLAUDE_PROJECTS` when set, else `~/.claude/projects`.
- [x] `/projects` lists every project with a `memory/` dir and its `*.md` memory count,
      sortable by project and count, each row opening that project's memories.
- [x] `/projects/$project` lists the project's memory files with size and mtime, `MEMORY.md`
      first and flagged as the index, sortable by file, size, and modified.
- [x] `/projects/$project/memory/$name` shows one memory file in full, with a **Pretty** /
      **Raw** toggle — rendered markdown plus parsed frontmatter, or the exact file bytes.
- [x] Project and memory names from the URL are regex-validated and confirmed to resolve
      inside the projects root / the project's `memory/` dir before any read; bad names are
      400 and missing ones 404.
- [x] Read-only: the three routes are `GET`-only JSON reads, there is no POST/PUT/DELETE
      route for memories and no write call anywhere in `server/src`, so the dashboard can
      never create, edit, or delete a memory file.
- [x] Reads device config only — no audit-log or sidecar data feeds this section.

## Open questions

- `server/src/projects.ts` has no unit tests (the repo's tests live under
  `packages/core/test/`), so the path-safety checks — the one security-relevant part of this
  feature — are unverified by CI.
- `CLAUDE_PROJECTS` is referenced nowhere but `server/src/projects.ts`: no README, env
  sample, or doc mentions it, so the override is effectively undiscoverable.
- Memory discovery is deliberately flat (`*.md` directly in `memory/`); whether nested
  subdirectories should be listed, and whether a cross-project memory search belongs here,
  are both open.

## Related

- [Admin dashboard for claude-proxy usage](admin-dashboard-for-claude-proxy-usage.md) — the
  dashboard this section lives in.
- [Config inventory](config-inventory.md) — the other config-derived views: proxy filters and
  hooks & plugins (pure config, like this one) and withheld tools (config joined with audit
  sidecars).
