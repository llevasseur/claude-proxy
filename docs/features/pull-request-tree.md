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

It is a read of GitHub — there is no merge button and no comment box, and the server never
calls a mutating `gh` subcommand. It does have **one** write, and it is about this
repository rather than about GitHub's records: [moving `main`](#moving-main) across the
commits merged PRs landed. That path is separate, origin-checked, and allowlisted.

## Motivation

The dashboard could show every session the proxy captured and nothing about what those
sessions shipped. The two halves of the record lived apart: `logs/sessions/` knows what
was worked on, GitHub knows what landed, and answering "which run produced this PR" meant
reading a branch name out of a transcript by hand.

## How it connects to GitHub

Through the **`gh` CLI**, not the REST API. The device is already authenticated for `gh`,
so the dashboard needs no token of its own, no new secret in `.env`, and no write scope;
the whole integration is one `gh pr list --state all --json …` per cache miss, scoped to
the `owner/name` slug of the checkout's `origin` remote.

### Resolving the slug is device-agnostic, in four layers

A remote's *spelling* is a property of the machine, not the project: one device writes
`https://github.com/o/r.git`, the next uses a per-account ssh identity
(`git@github-personal:o/r.git`, a host that exists only in that device's `~/.ssh/config`),
a third rewrites urls with `url.<base>.insteadOf`. Matching the literal string `github.com`
recognizes the first and rejects the other two, so `resolveSlug` in `server/src/github.ts`
tries four things in order and takes the first that answers:

1. **`REPO_SLUG`**, when it is `owner/name` — for a checkout whose remote cannot speak for
   itself at all.
2. **`git ls-remote --get-url origin`**, parsed by `parseRemoteUrl` for *any* host rather
   than a hardcoded one, and accepted when `isGitHubHost` passes. It is `ls-remote
   --get-url` rather than `remote get-url` because only that spelling applies
   `insteadOf` rewrites, and it talks to no network.
3. **`ssh -G <host>`** for an unrecognized ssh host, whose reported `hostname` is what
   turns an alias into a real host. Config files only; no connection is opened.
4. **`gh repo view --json nameWithOwner`** in the checkout, which resolves the remote on
   `gh`'s own terms.

`parseRemoteUrl` and `isGitHubHost` live in `packages/core` and stay pure — they read no
env and run no subprocess, which is exactly why an alias is the *server's* to resolve and
is handed back as an `extraHosts` entry. `isGitHubHost` accepts `github.com`,
`*.github.com`, `*.ghe.com` (Enterprise Cloud with data residency) and whatever `GH_HOST`
names. **No token or account is read anywhere in this path**: which identity `gh` and
`git` authenticate with is theirs to hold, so swapping it changes nothing here.

A setup gap is the page's **empty state, not a 500**. No `gh` on `PATH`, not signed in, or
no slug to be found each come back inside a 200 as an `error` string naming the command
that fixes it, because an error boundary would hide the one thing the visitor needs to
read. The no-slug message names what was tried — ``(`origin` is `git@gitlab.com:o/r.git`)``
— so the reader can see which layer fell through.

### The two env vars, and where each belongs

Neither is needed for the normal case, which resolves on its own. When one is, the scope
differs, and that is the part worth getting right:

- **`REPO_SLUG` is per-repository.** A slug is meaningless outside its checkout, so it
  belongs in the project's own env — the repo `.env` the server already reads, or a
  project `.claude/settings.json` `env` — and **never** device-wide, where it would claim
  every other repository is this one.
- **`GH_HOST` is per-device.** A GitHub Enterprise install is a property of the machine and
  its `gh` auth, so it belongs in device-wide `~/.claude/settings.json` `env` (or the shell
  profile), where every project and every session inherits the same one. It is the same
  variable `gh` itself reads, deliberately, rather than a second name for it.

**The limit on either:** a `.claude/settings.json` `env` only reaches processes Claude Code
spawns. A server started from a plain terminal never sees it, so for that case the variable
has to be in the repo `.env` or the shell profile instead.

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

## Moving `main`

A merged PR's landing commit — `gh`'s `mergeCommit`, a squash commit here and a true merge
commit in the early history — is a **position**. Sliding `main` means force-pushing
`refs/heads/main` to one of them, forwards or back, from the page.

**Nothing is ever destroyed.** The whole safety property is one rule, checked at slide
time: before `main` leaves a commit, that commit must be reachable from some
`refs/main-history/*` ref, and if it is not, it is **pinned first** and that push is
confirmed before `main` moves. GitHub's own merges only ever append to `main`, so a slide
from this page is the only thing that can strand a commit — which is why the rule needs no
journal and no bookkeeping to be sufficient.

- **Pins are content-addressed**: `refs/main-history/<short-sha>`. Two devices pinning the
  same commit write the same ref with the same value, so pinning is idempotent and
  race-free, and the namespace keeps them out of GitHub's branch and tag lists.
- **All shared state is refs on `origin`, never SQLite** — the database is per-device, and
  the several machines this runs on would disagree about where `main` has been.
- **Pins are never deleted.** Deleting the last ref to a line is exactly what would let
  GitHub collect those commits, so a line is *hidden* instead, by a separate
  `refs/main-history/hidden/<short-sha>` marker — a ref, so hiding reaches every device.
  The marker is named for the line's pin, so hiding from any row on a line hides the line.
- **The pin decision reads `origin`'s refs**, via `git ls-remote`, not the local ref store:
  a sync leaves local-only refs behind that would otherwise vouch for a commit `origin`
  reaches from nothing.
- **Authorization** is the device's `gh` identity: `gh api user` (REST, because `gh`'s
  GraphQL-backed calls resolve to an account that is not a collaborator on these repos)
  must return a login in an allowlist, `MAIN_HISTORY_ALLOWED_LOGINS`. The accepted
  limitation is that a local process sharing this device's token passes.
- **The move itself** is `--force-with-lease=refs/heads/main:<sha the page displayed>`, so
  a page that had gone stale is rejected by GitHub atomically rather than by a check here
  that could race.

The rail is drawn from real commit ancestry, which only the ref store has, so the lane
layout is computed **server-side** and shipped with the rows; `packages/core`'s
`main-history.ts` stays a pure function of a graph, a set of positions and a set of refs.
`main` is a straight vertical rail that runs off the top of the frame, and each pinned line
kinks off at its divergence point exactly once and then runs vertically in its own lane.

### Syncing this checkout

A plain `git pull` **will not** follow `main` backwards: the older commit is an ancestor of
the local branch, so pull reports "Already up to date" and quietly keeps the newer one. The
page detects the divergence and offers a button, with every refusal computed before it is
drawn rather than discovered on the press. It hard-refuses on an in-progress
merge/rebase/cherry-pick/revert/bisect, on `main` being checked out in another worktree
(named), and on unpushed local commits no pin reaches — the last of which offers an
explicit "preserve and proceed" that saves them to `refs/main-history/local-orphan/<ts>`
first. The pre-reset position is always recorded as a **local** ref — a way back on this
device, not a pin `origin` knows about — and when `main` is the checked
out branch the work in progress is stashed (`--include-untracked`, deliberately not
`--all`) with the stash commit surfaced in the response, so a fumbled `stash drop` is not
fatal.

## Surfaces

- `GET /api/pull-requests` — `{repo, prs, error, sessions, mainHistory, localMain,
  refError, meta}`; read-only, so it keeps the open `*` CORS and the 405 gate every other
  read route has. Fetching `main` and its pins rides the same 60 s cache as `gh pr list`,
  and writes refs only — no index, no worktree.
- `POST /api/main-history/slide`, `/sync-local`, `/hide` — the writes, on the
  origin-checked `WRITE_ROUTES` allowlist.
- `apps/admin/src/routes/pull-requests.tsx` — the page and its drawer.
- `packages/core/src/main-history.ts` — lanes, divergence points and the pin rule, pure.
- `server/src/main-history.ts` — every `git` and `gh` call behind the above.
- `server/src/github.ts` — the `gh` reader and its cache.
- `server/src/pr-sessions.ts` — one pass over `logs/sessions/`, every transcript read once
  and tested against every PR.

## Open questions

- Checks and review state are not shown. `gh pr list` can return them, but the tree is
  about what landed, not about what is passing.
- Hidden lines accumulate. Nothing prunes `refs/main-history/*`, by design — but a
  repository slid back and forth often will grow a long list of pins.
- The session link is textual evidence, not a record. Writing the PR url into a session's
  `.state.json` at `/pr` time would make it a fact.
