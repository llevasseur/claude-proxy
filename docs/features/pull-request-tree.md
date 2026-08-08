---
type: feature
title: Pull request tree
description: A read-only page that draws the project's GitHub pull requests as the tree they formed — merged PRs as the trunk, unlanded ones as branches — with a detail drawer that links each PR to the sessions that worked on it.
tags: [dashboard, frontend, github]
timestamp: 2026-08-08
---

# Pull request tree

## Summary

A **Pull requests** page (`/pull-requests`) in the
[admin dashboard](admin-dashboard-for-claude-proxy-usage.md) that reads this repository's
own pull requests through the `gh` CLI and draws them as a tree: merged PRs form the
trunk in merge order, and everything that never landed hangs off the merge it was cut
from. Clicking a node opens the same detail drawer the
[live session graph](live-session-graph.md) uses, which also lists the sessions that
worked on that PR.

It is a **read**. There is no merge button, no comment box, and no write path — the
route answers `GET` only and the server never calls a mutating `gh` subcommand.

## Motivation

The dashboard could show every session the proxy captured and nothing about what those
sessions shipped. The two halves of the record lived apart: `logs/sessions/` knows what
was worked on, GitHub knows what landed, and answering "which run produced this PR" meant
reading a branch name out of a transcript by hand.

## How it connects to GitHub

Through the **`gh` CLI**, not the REST API. The device is already authenticated for `gh`,
so the dashboard needs no token of its own, no new secret in `.env`, and no write scope;
the whole integration is one `gh pr list --state all --json …` per cache miss, scoped to
the slug parsed off the checkout's `origin` remote.

A setup gap is the page's **empty state, not a 500**. No `gh` on `PATH`, not signed in, or
no GitHub remote each come back inside a 200 as an `error` string naming the command that
fixes it, because an error boundary would hide the one thing the visitor needs to read.

Results are cached for 60 s server-side and the page polls every 30 s, so a PR opened or
merged elsewhere appears on its own without hammering GitHub's rate limit. The session
index is keyed to the same fetch, so the transcript scan below happens once per `gh` read
rather than once per poll.

## The tree

`buildPrTree` in `packages/core/src/pull-requests.ts` — pure, no I/O and no clock:

- **Trunk**: merged PRs sorted by `mergedAt`. That is the order `main` actually grew in.
  The page draws it **newest-first**, so reading down the spine reads backwards through
  the project's history.
- **Branches**: an open or closed-unmerged PR hangs off the last merge that had already
  landed when it was opened. A PR older than every merge attaches to the root instead.
- Open branches are drawn live, closed ones as dead ends that never rejoined.

Parsing is deliberately defensive: `gh` gains fields between versions, so every field
degrades to an empty value and only a row with no usable number is dropped.

## Linking sessions to a PR

Nothing records which session produced which PR, so the link is **recovered** from the
transcripts, and the drawer says which signal it came from rather than asserting a fact:

- **branch** — the transcript names the PR's head branch. A session that built a PR names
  its own branch constantly, including the slash-flattened `feat-x` spelling a worktree
  directory uses. Branches shorter than four characters are too generic to match on, and
  a name that is only the head of a longer branch does not count — `feat/pr-tree-page` is
  not `feat/pr-tree`, the branch-side form of the `#14`/`#144` guard.
- **number** — a `/pull/123` url, or a `#123` that sits within about a sentence of a word
  meaning pull request. **The context requirement is load-bearing**: matching a bare `#n`
  tied PR #1 to four unrelated sessions and PR #10 to a transcript asking about "message
  #10". A url needs no such help and matches at any size.

Transcripts hold roughly today only, so an empty list means no transcript on record —
not that nobody worked on it. The drawer says so.

## Surfaces

- `GET /api/pull-requests` — `{repo, prs, error, sessions, meta}`; read-only, so it keeps
  the open `*` CORS and the 405 gate every other read route has.
- `apps/admin/src/routes/pull-requests.tsx` — the page and its drawer.
- `server/src/github.ts` — the `gh` reader and its cache.
- `server/src/pr-sessions.ts` — one pass over `logs/sessions/`, every transcript read once
  and tested against every PR.

## Open questions

- CRUD is out of scope by design. If a write path is ever added, it belongs on the
  origin-checked `WRITE_ROUTES` allowlist rather than under the read routes' open CORS.
- Checks and review state are not shown. `gh pr list` can return them, but the tree is
  about what landed, not about what is passing.
- The session link is textual evidence, not a record. Writing the PR url into a session's
  `.state.json` at `/pr` time would make it a fact.
