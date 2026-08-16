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
the whole integration is one `gh pr list --state all --json …`, scoped to the
`owner/name` slug of the checkout's `origin` remote.

**That call does not happen on the request path.** The page is answered from the
`pull_request` table and the call runs behind the response — see
[answering from the substrate](#answering-from-the-substrate).

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

### Answering from the substrate

**The route answers from the database, and refreshes GitHub behind the response.** A
`pull_request` table in `logs/claude-proxy.db` holds one row per pull request, keyed on the
checkout and its number, and `/api/pull-requests` reads it with one indexed query. Nothing
on the request path shells out.

What that replaced was a single 60-second slot in memory in `server/src/github.ts`. Every
miss — the first load after a restart, or any load 60 s after the last one — paid a full
200-pull-request `gh pr list` while the page held a "Reading pull requests from GitHub"
skeleton. Measured against this repository on 2026-08-16: **1345 ms cold, 23 ms warm.**

The refresh runs behind the served response, the same build-now-reconcile-behind shape
`withCommandReconcile` already uses for `/api/commands` — one pass in flight at a time,
with a 60 s floor under how often a new one starts. It fires from inside
`servePullRequests` rather than at the route, so every caller of the route gets it without
the route knowing.

**The refresh asks GitHub only for new work.** It reads `MAX(updated_at)` out of the table
and passes it as `gh pr list --search "updated:>=<that day>"`, then upserts each row that
comes back. The list read already asks for `updatedAt`, so the watermark needed no new
field. Rows are never deleted: an incremental pass returns only what changed, so a pull
request the search window moved past must stay on the page. The window is day-granular,
which re-fetches at most one day of overlap and cannot miss an edit inside the hour.

A row is derived and disposable in exactly the sense
[ADR 0004](../adrs/0004-adopt-sqlite-as-the-query-substrate.md) means: GitHub owns the
truth, these rows are a copy of what `gh` last said, and `rm logs/claude-proxy.db` costs
one full refetch and loses nothing. When the table has no row for this checkout — a cold
install, or right after that delete — the route awaits one forced pass rather than serving
an empty tree as though it were the answer.

The page still polls every 30 s, so a PR opened or merged elsewhere appears on its own
without hammering GitHub's rate limit; the poll now lands on the table and the refresh
behind it is what reaches GitHub. The transcript scan below is stored too, so it no longer
rides that fetch — see [the scan is stored](#the-scan-is-stored).

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

**A session records the pull request it opened**, so the usual answer is a join. The proxy
watches for a `tool_result` that came back from a PR-opening command — `gh pr create`,
`gh pr edit`, `my-command-tools pr`, or the `gh api …/pulls` REST fallback — and writes the
url it printed into that thread's `.state.json` sidecar. Ingest carries it into
`session.pr_url`, beside the `root_prompt` it already takes from the same file, and
`readPrSessions` reads that column first.

Three things about the recording are deliberate:

- **The call is paired to its result**, never matched as loose text. A run that merely reads
  or reviews a PR quotes the url just as often, so a url counts only when it came back from
  a command that opens one. A failed open records nothing.
- **It goes to the sidecar, not the transcript.** The record is a derived *pointer* — ADR
  0004's rule that `logs/` is the source of truth is untouched, and
  `rm logs/claude-proxy.db && pnpm --filter server ingest` refills the column from the
  sidecars.
- **A recorded url is compared by `owner/name#number`**, so a run that opened
  `other/repo#14` is not read as this checkout's #14. Host is excluded from that key,
  because the same repository is reachable as `github.com` and as a device's ssh alias.

The **text scan stays**, unchanged, for a pull request no column names — everything opened
before the record existed, and anything opened outside a captured run. Each match still
says which signal found it, and the drawer prints all three:

- **recorded** — the session's own record of the PR it opened. A fact, not evidence, which
  is why it never appears beside the other two: a PR some session recorded is not scanned
  for text at all.
- **branch** — the transcript names the PR's head branch. A session that built a PR names
  its own branch constantly, including the slash-flattened `feat-x` spelling a worktree
  directory uses. Branches shorter than four characters are too generic to match on, and
  a name that is only the head of a longer branch does not count — `feat/pr-tree-page` is
  not `feat/pr-tree`, the branch-side form of the `#14`/`#144` guard.
- **number** — a `/pull/123` url, or a `#123` that sits within about a sentence of a word
  meaning pull request. **The context requirement is load-bearing**: matching a bare `#n`
  tied PR #1 to four unrelated sessions and PR #10 to a transcript asking about "message
  #10". A url needs no such help and matches at any size.

Transcripts hold roughly today only, so an empty list means nothing on record — no session
recorded the PR and no surviving transcript mentions it — not that nobody worked on it. The
drawer says so.

### What the record costs, and what it does not yet buy

The scan measured **14.67s** against this device's corpus, answering again in 14.31s and
only then 0.44s once the single-slot cache key held; the page re-requests the 677 KB payload
every 30 seconds, and the server is single-threaded, so a cold `/api/health` beside it
answered in 7.0–9.1s against 37ms warm. Two consequences follow from replacing the *primary*
path rather than the whole path:

- **The record is forward-only and nothing backfills it.** Deriving a record from the
  textual evidence it replaces would be exactly the conflation this change exists to end, so
  a repository's older pull requests keep the scan alive. The scan disappears entirely —
  and the measured 14s with it — only once every displayed PR is named. What carries the
  cost in the meantime is the stored scan below, no longer a slot in memory.
- **A recorded PR lists the session that opened it, not every session that mentioned it.**
  That is the point of a record, and it is also a loss: a review or follow-up run that only
  quoted the number stops appearing once the opener is on file.

### The scan is stored

**A pull request is scanned once, not once a minute.** What the scan finds is written to
`pr_scan_link` in `logs/claude-proxy.db`, one row per link, keyed on the checkout and the
number as `pull_request` is. Beside it `pr_scan` holds one mark per pull request: the mtime
of the newest transcript that existed when it was scanned.

What that replaced was a single slot in memory in `server/src/pr-sessions.ts`, keyed on
`fetchedAt`. That value moves on every GitHub refresh, so the scan repeated roughly every
60 seconds, and a restart dropped it outright. On this device 155 of 200 pull requests are
named by the record and 45 are not, so every one of those passes had real work to do.

Three properties are deliberate:

- **A mark with no links is the useful case.** "Scanned, matched nothing" is most of those
  45, and storing it is what takes them off the request path. A table of links alone would
  rescan them forever.
- **A stored link stays a `scanned` link.** `via` holds `branch` and `number` only, and
  both the write and the read drop anything else, so the separation above — `recorded` is a
  fact, `branch` and `number` are recovered evidence — is a column constraint rather than a
  convention. A recorded link is still re-read from `session.pr_url` on every request,
  because that read is cheap and a run that just opened a PR should appear beside it at once.
- **New transcripts still land.** A pull request whose mark is behind the newest transcript
  on disk is rescanned, and only against the transcripts past the oldest such mark. So the
  cost of a poll after a session ends is that one new transcript, not the directory.

What is left on the request path is one `stat` per transcript, which is how the pass knows
what is newer than a mark. That is bounded by the number of transcripts rather than their
size — the 14s the scan measured was reading megabytes of markdown, not listing them. A
link whose transcript has rotated away is dropped and its row deleted, as a recorded link
is; the mark stays, so losing the transcript does not buy back the scan.

The rows are derived and disposable like every other table here: `logs/sessions/` owns the
truth, and `rm logs/claude-proxy.db` costs one scan pass and no information. A log
directory with no database still works — the scan simply runs in full every time, as it did
before this table existed.

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
  read route has. Fetching `main` and its pins rides the same background refresh as
  `gh pr list`, and writes refs only — no index, no worktree.
- `POST /api/main-history/slide`, `/sync-local`, `/hide` — the writes, on the
  origin-checked `WRITE_ROUTES` allowlist.
- `apps/admin/src/routes/pull-requests.tsx` — the page and its drawer.
- `packages/core/src/main-history.ts` — lanes, divergence points and the pin rule, pure.
- `server/src/main-history.ts` — every `git` and `gh` call behind the above.
- `server/src/github.ts` — the `gh` reader, the refresh behind the response, and the
  served answer that comes off the table.
- `server/src/db/pull-request-store.ts` — the `pull_request` rows: the read, the
  `MAX(updated_at)` watermark, and the transactional upsert.
- `server/src/pr-sessions.ts` — the recorded column first, then, for whatever it did not
  name, the stored scan and a pass over the transcripts newer than it.
- `server/src/db/pr-scan-store.ts` — the `pr_scan` mark and the `pr_scan_link` rows: what
  the scan found, and how far it got.
- `proxy/session.ts` — `openedPullRequest`, which reads the url off a PR-opening command's
  own result, and the `pr` field of the `.state.json` sidecar it lands in.
- `server/src/sessions.ts` / `server/src/db/source.ts` — `readPrLinks`, the recorded links
  read off the sidecars on one backing and out of `session.pr_url` on the other.

## Open questions

- Checks and review state are not shown. `gh pr list` can return them, but the tree is
  about what landed, not about what is passing.
- Hidden lines accumulate. Nothing prunes `refs/main-history/*`, by design — but a
  repository slid back and forth often will grow a long list of pins.
- Every PR opened before the record existed still costs the transcript scan once, and
  nothing backfills them — see
  [what the record costs](#what-the-record-costs-and-what-it-does-not-yet-buy). What is
  left on the request path is the stat pass the stored scan needs, which grows with the
  number of transcripts on disk rather than with their size.
- The scan is stored per checkout and per number, and nothing prunes it. A pull request
  that leaves the page keeps its mark and its links.
