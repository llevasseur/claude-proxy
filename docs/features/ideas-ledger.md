---
type: feature
title: Ideas ledger
description: A store for invented proposals, kept separate from the suggestion flags because an idea has no source sessions behind it — only a recorded human sign-off makes one actionable, and a claim stamped at the start of work keeps two runs from building the same one.
tags: [advice, cli, ideas]
timestamp: 2026-08-07
---

# Ideas ledger

## Summary

The ideas ledger records features and commands somebody proposed building, and what a human
decided about each one. **It is hosted** — an append-only event log on the `operator` Worker's D1
database, replayed through `packages/core` on read
([ADR 0006](../adrs/0006-host-the-ideas-ledger.md)) — so it is one ledger across every machine
rather than one per machine. It is read and written by `pnpm --filter server ideas`, which needs no
running local server, and adjudicated from the [dashboard's](admin-dashboard-for-claude-proxy-usage.md)
`/ideas` page — one tab per area, one detail page per idea — over `GET /api/ideas` and the
`POST /api/ideas/status`, `/api/ideas/area`, `/api/ideas/comment` and `/api/ideas/claim` writes.

It exists because [session suggestions](session-suggestions.md) cannot answer the question it
answers. A suggestion is produced by a rule counting what a transcript did, so it always traces
back to the sessions it fired on. That trace is what makes `/improve` safe to run without a human
in the loop, and it is also a hard ceiling on what the rules can see: they measure how work was
done, never that a capability is missing. Nothing counts a command that was never written.

An idea covers exactly that gap, and it is **invented**. No rule produced it and no session
supports it, so it carries none of a suggestion's evidence. What makes an idea actionable instead
is a recorded human sign-off — the `accepted` status.

## Motivation

`/improve` runs on a strict rule: never invent an improvement, because padding a run with the
agent's own ideas breaks the trace from every change back to the sessions that justified it. That
rule is load-bearing and this feature does not relax it. It gives invention a **different store
with a different evidence standard**, so both standards can stay honest at once.

The two stores therefore never merge. `suggestions list` never returns an idea and `ideas list`
never returns a suggestion; they are separate files, separate namespaces, and share no code beyond
the conventions they both follow. Merging them would let an invented idea inherit a suggestion's
trace, which is the one thing the separation buys.

## Behavior

- **The store** — the `operator` Worker over D1, reached with `IDEAS_URL` and `IDEAS_TOKEN`.
  Writes append events; reads replay them. Version 1, and the export is byte-for-byte the JSON
  shape `<logDir>/ideas.json` held, so the nightly backup is restorable and a reader of either
  is reading the same thing.
- **The key is the slug alone**, not `(repo, slug)`. The store is shared across every repo *and*
  every machine, so the repo an idea lands in is a *field*, carried as a git remote slug
  (`llevasseur/claude-proxy`). **An absolute checkout path is refused**, because it names a
  different thing — or nothing — on another machine. That refusal is what made the ledger portable
  enough to host.
- **The statuses** — `proposed` (the default), `accepted` (a human signed it off), `claimed` (a run
  is building it), `rejected` (with the reason), `shipped` (with the PR url). Only `accepted`
  carries a sign-off, and it is the only status `/improve` may act on; a `proposed` or `rejected`
  idea is still invention.
- **`proposed` is persisted, unlike a `pending` suggestion.** The suggestion store drops a
  `pending` entry on read and deletes it on write, so that file holds only decisions. Here the
  ledger's whole job is to record **what was already considered** — an idea proposed and rejected
  must never be proposed again, and the rejection reason is the most valuable row in the file. A
  store that kept only the liked ideas would re-propose the rejected ones on every run.
- **Adding an existing slug is refused, never overwritten**, in any status including `rejected`.
  The refusal is reported rather than thrown, so a batch of three ideas with one collision still
  records the other two, and `add` exits non-zero when anything was refused.
- **Evidence is required, and enforced at the parse boundary.** Every entry must cite at least one
  of `open-question`, `judge-note`, `changelog`, `deferral` or `command-gap`, each with a locator: a
  `path`, or a `bucket` + `id` for a judge note, which lives in the suggestion store rather than in a
  file. An entry citing nothing is a parse error rather than a lint — "I noticed the code could use
  X" is exactly the output the requirement exists to suppress.
- **An area is required too, and is the second thing every entry carries.** See below.
- **Near-duplicates are surfaced, not refused.** A near-duplicate under a different slug defeats
  the dedupe key, and only a reader can tell `rolling-window-view` from a genuine sibling.
  `similarIdeaSlugs` scores shared slug tokens (dropping stop-words) and `add` reports the hits
  under `similar` so the judgement is made against a short list rather than against the whole
  ledger from memory. A token overlap is a prompt to look, never a verdict.
- **A mark on an unknown slug writes nothing**, which is the opposite of a suggestion flag. There a
  flag for an id no rule currently produces is still written, because the rules are recomputed and
  the id may come back; an idea exists only in this file, so a mark on a slug that is not here is a
  typo. Inventing a titleless, evidence-free entry to hold the flag would write exactly the row
  `parseIdeasStore` drops.
- **`rejected` and `shipped` require a note** — the reason and the PR url respectively. A rejection
  with no reason is the row a later run most needs, and `shipped` is a claim about something that
  landed. `proposed` is the undo: it restores an idea to unsigned-off without erasing the entry or
  its note.

### Areas, so a batch of proposals is judged against comparable things

Every entry carries an **`area`** — a kebab-case word, shape-validated exactly as the slug is and
otherwise free text. A flat ledger mixed a UI polish item in with an infrastructure change, and "is
this worth building" reads differently for each; the area is what lets the two be adjudicated apart.

- **Required on the way in, tolerated absent on the way out.** `parseIdeaAdds` refuses an entry with
  no area, exactly as it refuses one citing nothing. `parseIdeasStore` does **not**: rows written
  before areas existed keep loading, because dropping them would lose their rejection reasons, which
  is the one thing the ledger is least able to afford to lose. Those rows read as **Unfiled** and are
  classified with `ideas file`.
- **The seed areas are a vocabulary, never a whitelist.** `SEED_IDEA_AREAS` names `ui-ux`,
  `infrastructure`, `code-quality`, `services` and `commands`, in that order, with display labels.
  They are **advisory only** — they order the tabs, label them, and appear in the CLI's help and in
  the refusal an unparseable area produces. Nothing anywhere enforces membership: an agent with a
  genuinely new area must be able to open one.
- **Fragmentation is surfaced, not refused**, on the same reasoning as near-duplicate slugs.
  `similarAreas` matches shared tokens *and* prefixes — the fragmentations worth catching are
  abbreviations (`infra` for `infrastructure`) rather than rewordings, and an abbreviation shares no
  whole token with what it abbreviates — and `ideas add` reports the hits under `similarAreas` while
  still landing the entry.
- **`commands` is the one area core knows the meaning of**, because of the fifth evidence source.
  `command-gap` is the citation for a command that was never written, and it is the **only source
  that carries no locator** — there is no file to point at, which is the entire condition it
  describes. Two rules contain it: a `command-gap` citation may appear only on an idea whose area
  *is* `commands`, and it is the only source that may stand alone. Both are enforced at the parse
  boundary, and re-filing is checked too — that is the only other way to reach the state the parse
  forbids, so `applyIdeaFilings` refuses over the **whole batch before writing anything**.
- **The trade-off is stated rather than hidden**: a locator-less `command-gap` is the one citation a
  reader cannot go and check. It is confined to `commands` for exactly that reason.
- **Filing is not deciding.** `ideas file` is its own verb, deliberately not folded into `mark`: a
  single verb doing both would let a status change move an idea between tabs as a side effect, or a
  re-file quietly reset a rejection. Re-filing leaves `status`, `note` and `claim` untouched.
- **`comment` is a separate field from `note`.** `note` keeps its exact meaning — the rejection
  reason, or the shipped PR url. `comment` is a person's own words about the proposal, the build
  criteria whoever implements it should read. Each save **replaces** it rather than appending, and an
  empty one clears it.

### Claiming, so two runs cannot build the same idea

`accepted` and `shipped` are far apart in wall-clock time, and for a while nothing filled the gap.
An implementation run stamped `shipped` when its PR opened, so from the moment it picked an idea up
to the moment that PR existed the entry still read `accepted` — the one status an implementing run
looks for, and therefore still on offer. On this ledger that window was **eleven minutes**, and two
runs walked into it: PRs #139 and #140 both implemented `archive-aware-window-reader` against the
same accepted entry.

`claimed` fills the gap, and the two halves of the fix are equally load-bearing:

- **The claim is stamped at the start of work**, not at PR-open time, which compresses the window
  from the length of an implementation to the width of a single read-modify-write.
- **`shipped` goes back to meaning the work landed**, rather than doubling as "somebody started".

- **The claim carries a holder.** `{ by, at, pr? }` on the entry: `by` is a branch, a run id, or a
  person — whatever a second run can read and recognise as not itself — and `at` is when work
  started. `pr` is attached later, by re-claiming as the same holder.
- **Only `accepted` may be claimed** (or a `claimed` entry that is stale or already yours).
  `proposed` is refused, so a claim cannot route around the human sign-off that is the whole point
  of `accepted`.
- **A stale claim expires after six hours, rather than requiring an explicit release.** A run that
  dies cannot release its own claim, and an idea locked forever by a crashed run is a worse failure
  than the duplicate work the claim prevents — nobody would go and unstick it by hand. Expiry needs
  no heartbeat, no liveness protocol and no sweeper: it is computed at read time from the `at`
  already on the entry, so a claim expires without anybody writing the file.
- **A claim carrying a `pr` never goes stale by age**, however old. An open PR is live evidence the
  work exists, and expiring such a claim would invite exactly the duplicate implementation this
  state was added to stop. This is what makes a six-hour TTL safe: the long part of an idea's life
  is PR review, not writing, and `pr` covers that part. What ends such a claim is the PR itself
  rather than the clock — `ideas sync` releases it once that PR is closed unmerged or has lost its
  head branch, which is [the section below](#the-linked-pr-moves-the-status-so-nobody-has-to-remember-to).
- **`ideas mark -s accepted` is the explicit release**, for a run that gives up before the expiry.
  Every mark but `shipped` drops the claim; `shipped` keeps it as the record of who built the thing.
- **`ideas list --available` is what an implementation run should read** — `accepted` plus any
  `claimed` entry whose claim has expired. Plain `-s accepted` never recovers an idea abandoned by
  a dead run, and `-s accepted,claimed` would take one out from under a live holder.
- **The race is closed, by an atomic conditional write.** It used to be narrowed rather than
  eliminated: `claimIdeasInStore` was a read-modify-write and was not atomic against a second
  process in the same few milliseconds. That residue was tolerable while one agent at a time wrote
  one file, and stopped being tolerable once the ledger became genuinely shared — then two racing
  writers are the normal case rather than the pathological one. Taking a claim is now a single
  `INSERT … ON CONFLICT DO UPDATE … WHERE` against D1 whose `changes` count decides the winner, so
  one run gets the idea and the other gets a refusal naming the holder. It needed no lock file, no
  owner and no recovery path — the database already arbitrates. **The status rule did not move into
  SQL**: `isIdeaTakeable` still decides whether an idea may be taken, in `packages/core`, and the
  `WHERE` covers only the lease — already yours, or expired with no PR pinning it open. The
  six-hour cutoff is computed from `IDEA_CLAIM_TTL_MS` rather than written out again, and the
  comparison is inclusive because `isIdeaClaimStale` expires at `>=`; a boundary the two disagreed
  about would be a claim the reader calls free and the writer refuses.

**The command prose that has to change lives outside this repo.** `/ideate` and `/improve` are
user-level command files on the device, not files in this checkout. The mechanism here is complete
and usable, but an implementing run only stops colliding once its command file calls
`ideas claim --by <branch>` as its first step and reads `list --available` in place of
`list -s accepted`.

### The ledger is hosted, so every device sees one ledger

The store was `<logDir>/ideas.json`, and `logs/` is gitignored, so it was one ledger *per machine*.
Two things followed, and the second is worse than the first.

An idea accepted on the laptop was invisible on the desktop, and `accepted` is the one status
`/improve` acts on. And **dedupe — the thing the store exists for — could only ever be as good as
one machine's memory**: `add` refuses a slug already present, and a rejection reason is the most
valuable row in the file, but a proposal made here was checked against *here*. An idea another
device had already rejected, with the reason written down, came back as new.

[ADR 0006](../adrs/0006-host-the-ideas-ledger.md) moves it onto the Worker that already hosts the
[concept store](concepts-page.md) — the same deploy, the same D1 database, the same token. Four
things about how are worth stating, because three of them deliberately depart from how concepts was
done.

- **An append-only event log, replayed through `packages/core`.** The database holds `add`, `mark`,
  `file` and `comment` events; a read replays them oldest-first through the same `applyIdeaAdds`,
  `applyIdeaMarks`, `applyIdeaFilings` and `applyIdeaComments` the CLI and the dashboard use.
  **No status rule, evidence rule or filing rule is restated in SQL.** That is what keeps the four
  surfaces from drifting into four dialects of one ledger, and it is also why two devices writing
  at once is not a conflict: appending two events never was one, where rewriting one JSON blob
  always is.
- **Ids are derived, as they are for concepts** — a ULID whose time half is the event's timestamp
  and whose remaining bits hash the event — so a replayed write lands on the row it already wrote.
  **Replay order is `at` then an insertion `seq`, not the id**, and that is a real difference from
  the concept store: the low bits of a derived ULID are a *hash*, so two events sharing a
  millisecond would otherwise replay in hash order, and a mark replayed before its own add applies
  to an idea that does not exist yet.
- **There is no local fallback, and that is the point.** `remoteConceptStore()` returns null and
  the local file answers; doing that here would recreate the exact failure the move was made to
  fix, since an unconfigured device would keep a second divergent ledger that looks complete. So a
  device without `IDEAS_URL` and `IDEAS_TOKEN` **refuses every read and every write**, with a
  message naming both. `CONCEPTS_URL`/`CONCEPTS_TOKEN` answer for the address when the ideas ones
  are unset, since both datasets are one Worker behind one token.
- **`/api/ideas/stream` polls instead of watching.** It watched the log directory, and there is no
  file to watch — and the writers that matter are on *other machines*, which a local watch could
  never have seen anyway. `server/` re-reads the ledger every five seconds and diffs, sending an
  `update` only when the payload changed, which is the same dedupe the watch source did. **The SSE
  contract is unchanged** and the dashboard is untouched. Durable Objects and WebSockets were
  rejected: they reintroduce the per-connection state ADR 0005 rejected, to serve a list.

The nightly cron commits the ideas export beside `concepts.jsonl` in the same private repo, which
is what keeps the ADR 0004 carve-out paid for rather than merely widened.

#### Landing the code is not the same as having the ledger

**The ledger does not exist until the migration is applied and the Worker is redeployed**, and both
are manual — they touch a billable remote database and a live deploy, so they are documented rather
than automated, exactly as the rest of
[`services/concepts/README.md`'s operator setup](../../services/concepts/README.md#operator-setup)
is. Merging the code changes nothing about what the Worker serves. The order is:

1. **Apply the remote D1 migration.** `pnpm --filter concepts schema:apply` runs
   `services/concepts/migrations/0002_ideas.sql` — the event log and the claim lease — against
   `operator-db`. `schema:apply:local` is the local-only sibling and does not touch the deployed
   database.
2. **Deploy the Worker.** `pnpm --filter concepts deploy`. **Until this lands there is no
   `/api/ideas/*` route at all**, whatever the migration did: the routes are code, and the deployed
   build is whatever was pushed last.
3. **Seed each device that still has a local ledger.** `pnpm --filter concepts seed:ideas`, run **on
   every machine holding a `logs/ideas.json`** rather than once — each accumulated its own while the
   ledger was per-device. It is safe to re-run and safe to run on two machines holding the same
   idea, because event ids are derived from event content. The README documents this half in full.

**A 404 here means a stale Worker build, not a misconfigured client**, and the distinction is worth
knowing because the failure reads backwards. A call against a Worker deployed before step 2 comes
back as

```json
{"error":"no route for GET /api/ideas/export"}
```

which looks like a wrong `IDEAS_URL` or a path typo, and sends a reader to check their environment.
It is not: **every `/api/ideas/*` route on a deployed build is authenticated**, so a request that
actually reaches one answers `401 {"error":"unauthorized"}` even with no token at all. So the two
answers separate the two faults cleanly — **401 means the route is deployed and the credentials are
the question; 404 means the route is not deployed and step 2 has not been run.** Diagnosing this the
other way round cost a real debugging session.

**Retiring `logs/ideas.json` is a later step, deliberately.** Nothing reads it now, but it is not
deleted, because the sequencing is a correctness requirement: the service ships, then `/ideate` and
`/improve` are repointed and synced to **every** device, and only then does the file go. Deleting
it first would silently drop the ideas on any device still running the old commands.
`pnpm --filter concepts seed:ideas` is the migration — run it **on every machine that has a local
ledger**, since each one accumulated its own. It decomposes each entry back into the events that
produced it, stamped with the entry's own timestamps, and because ids are derived it is safe to run
twice and safe to run on two machines holding the same idea. A **claim is not imported**: it is a
six-hour lease belonging to a run on one machine, and importing one would park a now-shared idea
under a holder nobody else can find, so a claimed idea arrives as `accepted`.

### The linked PR moves the status, so nobody has to remember to

The claim already carried the PR url. Nothing read it. So `shipped` was a thing a person asked an
agent for after noticing a merge, and the two failure modes either side of that were worse: a merged
idea sat `claimed` indefinitely, and a claim on a PR that was closed or whose branch went away held
the idea **forever**, because a claim carrying `pr` deliberately never expires. `ideas sync` closes
that loop — and `maintain --apply` runs it, which is what makes the status change without anyone
asking.

- **The decision is pure and the observation is not.** `planIdeaPrTransitions` in
  `packages/core/src/ideas.ts` takes the store plus a list of `{ pr, outcome }` and returns the
  transitions, the `IdeaMark[]` that performs them, and what it deliberately left alone.
  `server/src/ideas-pr.ts` supplies the outcomes from `readPullRequests` and writes the marks.
- **Four outcomes, and one of them is inferred.** `merged` and `closed` come off the PR row.
  `open` is the rest. `detached` is an **open** PR whose `headRefName` is no longer in
  `git ls-remote --heads origin` — not a PR state, but the shape an abandoned or already-cleaned-up
  branch leaves, and reading it as `open` is what left the claim stuck.
- **The moves.** `claimed` + merged → `shipped`, with the PR url as the note, which is byte for byte
  the row `mark -s shipped -n <url>` writes by hand, so the automatic and manual paths agree and the
  claim survives as the record of who built it. `claimed` + closed or detached → `accepted`: the
  documented release, human sign-off intact, idea back on offer. `claimed` + open → nothing.
- **`shipped` is terminal.** Its PR is still read, and no outcome moves it. Re-opening a merged PR or
  deleting its branch must not un-ship landed work; the entry comes back under `unchanged` so a
  reader can see it was checked rather than skipped.
- **An unobserved link is missing data, never evidence.** The listing reads one repo and is capped at
  `DEFAULT_PR_LIMIT`, while this ledger is device-wide, so a linked PR the listing does not cover is
  reported under `unobserved` and left exactly as it was. The same principle governs the branch
  check: an unreadable remote means *assume every branch is alive*, because the other reading would
  release every live claim the first time the scheduled job ran offline. **The branch check assumes
  the head branch is on `origin`**, which is the one place the refusal to guess does not reach:
  `PullRequestRow` carries `headRefName` and no head repository, so a PR opened from a fork names a
  branch `origin` never had and reads as `detached`. Every PR this repo's tooling serves is
  same-repo, and covering the other case means asking `gh pr list` for a field it is not asked for
  today.
- **Failure is never fatal to the job.** No `gh`, no auth, no origin — `maintain` logs that the PRs
  were unreadable and leaves the ledger untouched. That is distinct from a successful run with an
  empty plan, and the two do not print the same thing.
- `ideas sync --dry-run` prints the plan and writes nothing, which is the shape every other
  maintenance step here has.

### Adjudicating from the dashboard

The sign-off is a human decision, and requiring it at a terminal is what forced `/ideate` to stop
mid-run and ask in-session. The Advice page carries the ledger instead, so the run records its
proposals and ends, and the decision happens whenever somebody looks.

- **`GET /api/ideas`** lists the ledger with per-status counts, optionally narrowed by `?status=`
  (comma-separated), `?repo=` (a remote slug — a checkout path is refused here exactly as it is
  on a write) and `?area=`. `meta.total` always counts the whole ledger, so a filtered view still
  says how much it hid, and `meta.areas` counts per area **over the whole ledger too** — otherwise
  selecting one tab would rewrite the numbers on all the others. It is a sibling of `meta.counts`
  rather than a key inside it, because the two are counted over different vocabularies and a caller
  reading `counts` wants the five statuses. **`/api/ideas/stream`** shadows the list over SSE by
  **polling the Worker every five seconds and diffing**, emitting an `update` only when the payload
  changed — there is no local file to watch now the ledger is hosted, and the writers that matter are
  on other machines, which a local watch could never have seen. So an idea `/ideate` writes from a
  terminal on *any* device appears without a reload. See
  [The ledger is hosted](#the-ledger-is-hosted-so-every-device-sees-one-ledger).
- **`POST /api/ideas/status`** takes `{ marks: [{ slug, status, note? }] }` through the same
  `parseIdeaMarks` / `applyIdeaMarks` the CLI uses. It is on the server's **write allowlist**, under
  the origin-checked CORS the chat routes use rather than the reads' open `*`: this ledger is
  device-wide, shared across every repo on the machine, and an `accepted` row is the sign-off
  `/improve` then acts on.
- **A status mark from the browser may set `accepted`, `rejected`, `proposed` (the undo) and
  `shipped`.** `shipped` is on that list because a person reading the card is often the person who
  just watched the PR land, and it is held to the CLI's own contract rather than made a button
  beside Accept: it opens a form, the PR url is required as the note, and only an `accepted` or
  `claimed` idea may be shipped, checked over the whole batch against the stored status before
  anything writes. **`claimed` is the one status the route refuses**, and for a reason a status mark
  cannot satisfy: it is not a decision a person makes but a machine registering that it has started
  building, and it must carry a holder a second run can recognise, which a mark has nowhere to put.
  So claiming from the dashboard is its own write — **`POST /api/ideas/claim`**, behind the card's
  Re-claim control, which asks for the holder (and optionally the PR) rather than inventing one, and
  reports a live holder as a refusal in the body rather than as an error. **Releasing** a claim is
  allowed and is `accepted`: the card's Release button frees an idea from a run that hung without
  waiting the six hours out, and leaves the sign-off intact.
- **A `rejected` mark with no note is refused with 400**, matching the CLI contract. The reason is
  the ledger's dedupe record — it is what stops a rejected idea being re-proposed — and an empty one
  is worse than none, because it looks like a decision while carrying nothing a later reader can
  use. Both refusals live in `applyIdeaStatus` rather than in the route, so the HTTP contract and
  the CLI's cannot drift apart.
- **A card renders what it cites.** Evidence is what makes an idea approvable, so every path (and
  `bucket/id` for a judge note) is on the card; without it a card is just a title, and the reader
  would have to take the proposal on trust.
- **`accepted` rows stay visible** in a settled state, so it is clear what `/improve` picks up next.
  **`rejected` rows collapse behind a toggle rather than disappearing** — they are never deleted,
  because the reasons are the rows that stop an idea coming back.
- **The list lives at `/ideas`, tabbed by area**, and the Advice page keeps only a summary line
  linking to it. The page fetches the whole ledger once and filters **client-side**, so switching
  tabs costs no request, and stays live over the same SSE stream. The five seed tabs always render,
  dimmed at zero — the vocabulary is visible before anything is filed under it, which is what makes
  it a vocabulary — then invented areas alphabetically, then **Unfiled only while area-less rows
  exist**. The selected tab travels in the URL as `?area=`, and an area that was renamed, emptied or
  never existed **degrades to the default** rather than erroring, because answering a stale link with
  a crash is worse than answering it with the page the reader wanted.
- **There is no "All" tab**, and the trade-off is deliberate: a mixed batch of proposals is
  adjudicated tab by tab. What it buys is that every list on the page is a list of comparable things,
  which is the whole reason areas exist. Cards stay fully actionable — Accept, Reject-with-reason,
  Release and Undo are all still on them.
- **`/ideas/$slug` is the detail page**, carrying the full rationale, every citation with its quote,
  the claim holder and how long it has been held, the `by` provenance, **the same Accept /
  Reject-with-reason / Release / Undo controls the card carries**, the re-file picker and the comment
  editor. The decision was card-only at first, which meant a reader who followed the permalink to see
  the one thing the card clamps — the rationale in full — had to go back to the list to act on what
  they had just read. Both surfaces render one `IdeaDecisionControls`, so neither can disagree with
  the other about what a status may become — and the card is **absent for a `shipped` idea**, whose
  status the controls offer no move out of. **The area is deliberately absent from the permalink** —
  re-filing is a normal thing to do, and a link that breaks when somebody corrects a misfile is worse
  than a less descriptive url. There is no per-idea endpoint: the ledger is small and the list is
  already cached under the same query key, so a write from either surface moves both.
- **`POST /api/ideas/area`** and **`POST /api/ideas/comment`** are the two new writes, on the same
  write allowlist and origin-checked CORS as `/api/ideas/status`, with their refusals in the apply
  functions rather than in the routes for the same reason as before.
- A ledger that exists but does not parse **500s rather than rendering empty**, for the reason
  below: a page claiming a fresh ledger is how a rejected idea gets re-proposed.

### The rationale is a list, and both shapes are on the ledger

`/ideate` now writes a rationale as literal `- ` bullet lines in plain technical English, in a fixed
order — what it is, the problem, how it works, what it replaces, size, and an optional
`Depends on <slug>`. A reader deciding between two proposals compares them line for line instead of
reading two paragraphs to find the claim each one turns on.

**Nothing rewrites a row it did not write**, so every idea recorded before that shape existed is
still a paragraph. `ideaRationaleBullets` in `packages/core` tells them apart by reading the text
rather than by a stored flag, reading the **leading run**: every line up to the first one that is not
a bullet. The *first* non-empty line must still be a bullet, so a paragraph that happens to contain a
dash renders as the paragraph it is rather than as a list with an orphan. `/ideate` may close its
bullets with a paragraph of evidence, and the run is what keeps that rationale a list instead of
dropping the whole of it back to prose, where the newlines fold into one line. A leading `**Label**`
is split off so the labels can hang, which is what makes the fixed order scannable.

The card shows the **first three** bullets. The cut is by bullet rather than by height because
`-webkit-line-clamp` requires `display: -webkit-box`, which stops a `<ul>` rendering as a list at
all — and because the fixed order puts the three a scanning reader wants at the top. A legacy
paragraph keeps the old three-line clamp.

The permalink does not use that reading at all. It renders the rationale through the dashboard's
`Markdown` component, the same one behind the memory, command, concept and job-file views, so the
`- ` lines become a real `<ul>`, a `**Label**` lead-in is bold, inline code stays code, and a closing
paragraph of evidence keeps its own block instead of running on from the last bullet. The card cannot
share that renderer, because the clamp above unmakes a list.

### The `/task` prompt an idea produces, so nobody retypes the brief

Every idea already carried what a run needs to start: the title, the rationale in the fixed order
`/ideate` writes, the `comment` a human left as build criteria, every citation, and the claim
protocol above. Nothing assembled it. A person who accepted an idea then wrote the task out again by
hand, and `/improve` splitting accepted ideas across subagents had to re-derive the same brief once
per subagent — which is where two runs' briefs drift apart.

`ideaTaskPrompt` in `packages/core/src/ideas.ts` composes that brief, and both surfaces call it, so
the dashboard's copy button and `ideas prompt --slug <slug>` emit the **same bytes** rather than two
paraphrases of one idea.

- **Derived, never stored.** There is no `prompt` field on `IdeaEntry` and deliberately so. A stored
  copy goes stale the moment somebody re-files the idea or rewrites its comment, and the ledger would
  then hold two disagreeing statements of the same task with nothing to say which one is current. The
  entry is the single source and the prompt is a pure reading of it.
- **The comment is the human's half, quoted verbatim**, and the prompt says it overrides the
  rationale where the two disagree — it is the one part of an idea written *as build criteria*.
- **The claim lines are on every prompt**, not only on an unclaimed one. A prompt is copied once and
  pasted into a run that starts later, so what was free when it rendered may not be by then; the
  non-zero exit from `ideas claim` is a better refusal than a status snapshot taken minutes earlier.
- **A locator-less `command-gap` reads as what it is** rather than as a dangling path — the citation
  says the command was never written, which is the whole condition it describes.
- **`ideas prompt --slug <slug>`** prints it bare on stdout, so `| pbcopy` is the whole workflow, and
  `--json` wraps it as `{ slug, prompt }` for a caller that would rather not parse stdout. An unknown
  slug prints the same refusal every other verb makes and exits 1, inventing nothing to answer with.
- **On `/ideas/$slug` it is one editable field, and only one.** The card renders the prompt once, in a
  textarea it is read from, edited in and copied from — a second rendering of a pure function of the
  same entry would be a duplicate rather than a view, and would need a control for choosing between
  two copies of identical bytes. The edit that field takes is the one-off caveat that belongs in
  *this* copy of the prompt and not on the ledger.
- **The edit is local to the clipboard and is not persisted.** The durable instruction already has a
  field — `comment` — which the generated prompt quotes, so writing there changes what everyone
  generates next, including what an orchestrator reads, while editing in the card changes only what
  you paste now. The card says exactly that beside its Reset button. Storing a second freely-edited
  copy of the whole prompt beside the comment is the two-disagreeing-statements problem again.
- **The draft follows a live entry unless it has been edited.** The page streams over SSE, so a
  re-file or a new comment arrives while the card is open; regenerating over a reader's own words
  would be the worse surprise, so an edited draft stays put.
- **The copy button reports the one failure it has.** `navigator.clipboard` is absent outside a
  secure context — precisely the case when the dashboard is opened over plain HTTP from another
  machine — and saying so beats appearing to succeed.

### A corrupt ledger is an error, not an empty one

`readSuggestionStatusStore` reads a corrupt file as empty, and that is right there: the suggestions
underneath are recomputed from the transcripts on every load, so the flags are the only loss and
refusing to render the dashboard would be the worse failure.

`readIdeasStore` **throws instead**, and the divergence is deliberate. An idea exists nowhere else.
Reading a broken ledger as empty would let a caller conclude the ledger is fresh, re-propose
everything already rejected in it, and then overwrite the file with that conclusion. A missing file
still reads as empty, because that is the honest starting state.

The distinction matters to callers resolving a store through a waterfall of tiers: a **missing**
store is *absent* and they may fall through to a lower tier, while a **broken** one is a stop.
Falling through past a broken tier-1 store forks one ledger into two that each look complete.

## Flags / Parameters

```
ideas list  [-s|--status <flags>] [--repo <slug>] [--area <area>] [--available] [--json]
ideas add    --json <entries>|-
ideas claim  --slug <slug> --by <holder> [--pr <url>] [--json]
ideas mark   --slug <slug> -s|--status <flag> [-n|--note <text>] [--json]
ideas file   --slug <slug> --area <area> [--thread <id>] [--json]
ideas note   --slug <slug> --text <text> [--thread <id>] [--json]
ideas prompt --slug <slug> [--json]
```

- `-s` / `--status` — comma-separated subset of `proposed`, `accepted`, `claimed`, `rejected`,
  `shipped`.
- `--available` — on `list`, the rows an implementation run may take right now: `accepted` plus any
  `claimed` entry whose claim has expired.
- `--by` — on `claim`, the holder to record. `--pr` attaches the PR that pins the claim open.
  `claim` exits non-zero when the idea is held by somebody else, so a scripted run walks away
  rather than reading a zero exit as permission to build it.
- `--repo` — a git remote slug, `owner/name`.
- `--area` — on `list`, one area, matched exactly; an area-less row matches no area at all. On
  `file` it is the area to move the idea to, and `--help` lists the seed areas.
- `--text` — on `note`, the whole comment. It **replaces** any existing one rather than appending,
  and `--text ""` clears it.
- `--json` — on `list` and `mark`, machine-readable output. **On `add` it carries the payload**: a
  JSON array of entries, or `-` to read stdin. `add`'s own output is always JSON, since its input
  is, which is also why the flag is not doing double duty on that verb.
- `--help` — the usage, including what each verb refuses.
- `LOG_DIR` selects the store, exactly as it does for `suggestions`.

An entry is `{ slug, title, rationale, evidence[], repo, area, status?, note?, comment?, claim? }`,
each evidence item is `{ source, path?, bucket?, id?, quote? }` — `command-gap` carries no locator —
and a claim is `{ by, at, pr? }`.

## Where the code lives

`packages/core/src/ideas.ts` is pure — no I/O, no clock (callers pass `now`) — holding the store
shape, the parse and apply functions, the slug, repo and area predicates, `SEED_IDEA_AREAS`,
`countIdeaAreas`, `similarIdeaSlugs`, `similarAreas`, and `ideaTaskPrompt` with its `ideaCitation`
helper — the `/task` brief, derived from an entry and stored nowhere. It sits beside `suggestion-status.ts` and
imports nothing from it. The hosted half is `services/concepts/src/ideas.ts` — the event log, the
replay and the atomic claim — over `migrations/0002_ideas.sql`, exposed by `src/rest.ts` and as four
tools in `src/mcp.ts`, with `scripts/import-ideas.ts` as the per-device backfill.
`server/src/ideas-remote.ts` is the client and the place the refusal-without-fallback lives;
`server/src/ideas-store.ts` is the only code that reaches the ledger,
and `server/src/ideas-cli.ts` is the command line. `server/src/ideas-pr.ts` is the PR reconciler —
it observes through `server/src/github.ts` and writes through the store, and both `ideas sync` and
`server/src/maintain-cli.ts`' `--apply` path call it.

Over HTTP, `buildIdeas` is the read and `applyIdeaStatus`, `applyIdeaArea`, `applyIdeaComment` and
`applyIdeaClaim` are the writes, all in `server/src/api.ts`. The six routes — `/api/ideas`,
`/api/ideas/stream`, `/api/ideas/status`, `/api/ideas/area`, `/api/ideas/comment` and
`/api/ideas/claim` — are **declared in `packages/core/src/api-routes.ts`** along with every other
route the API answers, carrying their methods, CORS class and query parameters;
`server/src/server.ts` builds its dispatch table from that declaration and `apps/admin/src/api.ts`
derives its client functions from the same array, so a handler for an undeclared route and a
declared route with no handler each fail to compile. No builder here
takes a `SidecarSource` and none is shadowed: the ledger is *authored* state with no derived half, so
there is nothing for the SQLite substrate to disagree about. In the dashboard,
`apps/admin/src/components/IdeaCard.tsx` is the card, `apps/admin/src/routes/ideas.tsx` is the tabbed
list, `apps/admin/src/routes/idea-detail.tsx` is one idea in full — rendering its rationale through
`apps/admin/src/components/Markdown.tsx` rather than through the card's reading. **Each of those two
files declares the route it is reached by**, in its own `createRoute` call exported as `route` —
there is no route table to add a page to. `apps/admin/src/routes/registry.ts` is the hand-written
list of route modules both are named in, `apps/admin/src/router.tsx` is the ~20 lines that import
that list and call `addChildren`, and the root route and layout live in
`apps/admin/src/route-root.tsx`, which builds the side rail from the same list. `ideas.tsx` also
exports a `nav` station, so `/ideas` appears in the rail; `idea-detail.tsx` exports none, which is
how "in no section" is written. The Ideas section of `apps/admin/src/routes/advice.tsx` is now a
summary line linking across.

The store is still **device-wide** while the page is about one proxy's logs, which is why the repo is
on the card: a reader has to be able to see that an idea belongs to another checkout. That is the
question a route was originally held back over, and putting the remote slug on the card is the whole
of the answer.

## Acceptance criteria

- [x] The ledger is hosted on the `operator` Worker as an append-only event log, replayed through
      `packages/core` on read, and an empty database reads as an empty ledger.
- [x] A device with no `IDEAS_URL`/`IDEAS_TOKEN` refuses every read and every write, naming both,
      rather than falling back to `logs/ideas.json` and keeping a second divergent ledger.
- [x] An unreachable ledger throws rather than reading as empty, and the error names the route
      without carrying the token.
- [x] Two runs claiming one idea at the same instant produce exactly one holder and one refusal
      naming them, decided by the `changes` count of a single conditional write.
- [x] The claim gate agrees with `isIdeaClaimStale` at the exact TTL boundary, and never takes a
      claim carrying a PR however old it is.
- [x] Events sharing a millisecond replay in insertion order rather than in id order, so a mark
      never replays before the add it marks.
- [x] `ideas_list` (with `--available`), `ideas_add`, `ideas_claim` and `ideas_mark` are served
      over MCP, and `ideas_add` runs `similarIdeaSlugs` server-side over the whole corpus,
      rejected rows included.
- [x] `/api/ideas/stream` polls the Worker and diffs, emitting an `update` only on a real change,
      with the SSE contract and the dashboard unchanged.
- [x] The nightly backup commits the ideas export beside `concepts.jsonl`, and an unchanged day
      makes no commit.
- [x] `pnpm --filter concepts seed:ideas` imports a device's `logs/ideas.json` and is safe to
      re-run and to run on several devices, because event ids are derived from event content.
- [x] The two stores never merge: `suggestions list` returns no idea and `ideas list` no
      suggestion, verified by driving both against one log directory.
- [x] The key is a kebab-case slug, and the repo is a git remote slug with a checkout path refused.
- [x] `proposed` is persisted, so the ledger records what was considered rather than only what was
      liked.
- [x] Adding a slug already present in any status is refused without overwriting it, the rest of
      the batch still lands, and the collision is reported.
- [x] An entry citing no evidence is refused at the parse boundary.
- [x] A near-duplicate slug is surfaced under `similar` without being refused.
- [x] `rejected` and `shipped` require a note; a mark on an unknown slug writes nothing.
- [x] The pure half is unit-tested in `packages/core/test/ideas.test.ts` and the file handling in
      `server/test/ideas-store.test.ts`.
- [x] A `claimed` idea whose linked PR merged becomes `shipped` with the PR url as its note, and
      keeps the claim as the record of who built it.
- [x] A `claimed` idea whose linked PR was closed unmerged, or whose head branch is gone from the
      remote, is released to `accepted` with the claim dropped.
- [x] A `shipped` idea is terminal: no PR outcome moves it, and it is reported as checked rather
      than skipped.
- [x] A linked PR the listing does not cover is reported and left alone, and an unreadable remote
      is read as "every branch alive" rather than as "every branch deleted".
- [x] `ideas sync --dry-run` writes nothing, and `maintain --apply` runs the same reconciliation
      without failing the job when GitHub cannot be reached.
- [x] Every verb works with no server running and takes `--json`.
- [x] `GET /api/ideas` returns the rows with per-status counts, narrows by status and repo, refuses
      a checkout path, and refuses any non-GET under the read routes' 405 gate.
- [x] `POST /api/ideas/status` round-trips accepted and rejected, refuses `claimed`, a note-less
      rejection and a note-less ship with 400, writes nothing for an unknown slug, and sits on the
      write allowlist so a foreign origin is refused with 403.
- [x] The Advice page renders each idea's citations, keeps `accepted` visible, collapses `rejected`
      behind a toggle, and shows an empty state for a ledger with no rows.
- [x] A claim is stamped at the start of work and carries a holder and a start time, so a second
      run can tell who holds an idea and since when.
- [x] Only `accepted` — or a stale or already-yours `claimed` — may be claimed; `proposed` is
      refused, so a claim cannot route around the human sign-off.
- [x] An unevidenced claim expires after six hours and a claim carrying a `pr` never expires, both
      decided at read time with no sweeper writing the file.
- [x] `ideas mark -s accepted` releases a claim, every mark but `shipped` drops it, and `shipped`
      keeps it as the record of who built the thing.
- [x] `ideas list --available` returns `accepted` plus expired claims, and the test pins what the
      two obvious alternative queries each get wrong.
- [x] `claimed` cannot be set by a status mark from the dashboard — it is refused with a message
      naming the holder a mark has nowhere to carry — and is taken there only through
      `POST /api/ideas/claim` with a typed holder, which reports a live holder as a refusal rather
      than an error. A claim can be released from the dashboard, and releasing is `accepted`.
- [x] `shipped` can be set from the dashboard, but only with the PR url as its note and only on an
      idea the store already holds as `accepted` or `claimed`, checked against the stored status
      over the whole batch before anything is written.
- [x] Every entry carries a kebab-case `area`, required by `parseIdeaAdds` and tolerated absent by
      `parseIdeasStore`, so a legacy row survives the read with its rejection reason and renders as
      Unfiled.
- [x] The seed areas are advisory: they order and label the tabs and appear in the CLI help, and no
      code path refuses an area outside them.
- [x] `command-gap` stands alone with no locator, is refused on any idea not filed under `commands`,
      and cannot be re-filed out of `commands` — checked over the whole batch before anything writes.
- [x] `ideas file` changes the area without touching status, note or claim, and `ideas note` writes
      `comment` without touching `note`, with an empty text clearing it.
- [x] `GET /api/ideas` narrows by `?area=` and reports per-area counts over the whole ledger, and
      `POST /api/ideas/area` and `/api/ideas/comment` sit on the write allowlist behind the
      origin-checked CORS.
- [x] `/ideas` renders the five seed tabs even at zero, then invented areas alphabetically, then
      Unfiled only while area-less rows exist; the tab is in `?area=` and an unknown one degrades to
      the default rather than erroring.
- [x] `/ideas/$slug` carries the rationale, every citation, the claim, the provenance, the decision
      controls, the re-file picker and the comment editor, and the area is absent from the permalink.
- [x] A bulleted rationale renders as a list on both surfaces, a paragraph one renders as prose, and
      a rationale mixing the two renders as prose rather than as a broken list.
- [x] `ideaTaskPrompt` composes a `/task` invocation from the entry alone — slug, title, area, repo,
      rationale, every citation, and the claim lines — with no `prompt` field stored anywhere, so a
      re-file or a rewritten comment moves the prompt with it.
- [x] The comment is quoted as build criteria when there is one, and the prompt says nothing about
      build criteria when there is not.
- [x] A locator-less `command-gap` citation renders as the gap it describes rather than as a
      dangling path.
- [x] `ideas prompt --slug <slug>` prints that same string bare on stdout, wraps it as
      `{ slug, prompt }` under `--json`, and exits 1 on a slug the ledger lacks.
- [x] `/ideas/$slug` carries the prompt in a single editable field — no preview pane and no tab
      pair — with a copy button that reports a missing `navigator.clipboard` rather than appearing
      to succeed, an edit that is local to the clipboard and resettable, and a draft that follows a
      live entry unless it has been edited.
- [x] `/improve` claims before building and reads `--available` instead of `-s accepted`. The
      installed command claims with `ideas claim --by <branch>` before it dispatches the work, and
      reads the queue with `ideas list --available`. **The file lives outside this repo**, at
      `~/.claude/commands/`, so nothing in this checkout proves it and nothing here can regress it —
      this box records what the installed command does today.
- [ ] `/ideate` claims before building and reads `--available` instead of `-s accepted`. **Same
      story, and not yet verified**: the command file is outside this checkout, and no one has
      checked the installed copy against this criterion the way `/improve`'s was checked.
- [ ] `logs/ideas.json` is deleted, on every device, **after** every device has the repointed
      `/ideate` and `/improve` and has run `seed:ideas`. **Deliberately not done in the change that
      hosted the ledger**: nothing reads the file now, and retiring it before the out-of-repo
      command files are synced would silently drop whatever a lagging device recorded. What it waits
      on is the other out-of-repo command boxes in this list — the `/ideate` one above and the two
      below — rather than anything in this checkout.
- [ ] `/ideate` chooses an area for every proposal it records and cites `command-gap` when the gap is
      a command that was never written. **That command file lives outside this repo**, at
      `~/.claude/commands/`, so nothing in this checkout closes it.
- [ ] `/improve` reads an accepted idea's `comment` as build criteria. **Same story**: the command
      file is outside this checkout, and the field is here waiting for it.

## Open questions

- ~~The ledger is device-local, so an idea accepted on one machine is invisible on another.
  Syncing it would need a home that is not `logs/`.~~ **Closed by hosting it**, in
  [ADR 0006](../adrs/0006-host-the-ideas-ledger.md): the ledger is an append-only event log on
  the `operator` Worker's D1 database, replayed through `packages/core` on read. The repo field
  staying a remote slug rather than a path is what made the data portable enough for this to be a
  move rather than a migration. See [The ledger is hosted](#the-ledger-is-hosted-so-every-device-sees-one-ledger)
  below.
- `similarIdeaSlugs` compares slug tokens, so it catches a rename and misses a genuine restatement
  under unrelated words. A comparison over the title and rationale would catch more, and would need
  a threshold nobody has evidence for yet.
- ~~Nothing records *who* accepted an idea, only that the status changed and when.~~ **Closed by the
  provenance envelope**, the same `by` field a bucket verdict carries: `ideas mark --thread <id>`
  records the marking session's thread id on the entry, and the dashboard and `ideas list` show it
  beside the status date. It is the actor alone — an idea is invented rather than judged, so there
  is no window behind it to count reads against, and the `window`/`opened` half stays absent. The
  attribution belongs to the status now on the entry: a later mark that names a thread replaces it,
  and one that does not leaves it. Entries decided before this existed keep loading with no `by` at
  all and are never treated as unattributed-and-therefore-suspect.
- A `shipped` idea keeps its PR url in the same single `note` a `rejected` one keeps its reason in,
  so an idea that was rejected and later revived and shipped keeps only the second. The suggestion
  store solved the equivalent problem by moving enrichment to bucket level; here it has not come up.
- The six-hour claim TTL is a judgement, not a measurement — there is one observed collision to
  reason from, not a distribution of run durations. The `pr` escape hatch is what makes being
  wrong on the short side survivable; if runs start losing claims mid-flight, the honest fix is to
  record something the run refreshes rather than to keep raising the constant.
- A claim's `by` is free text, so nothing stops two runs picking the same holder string and each
  reading the other's claim as its own idempotent re-claim. With branch names as holders that does
  not happen; it would need a real run id if anything ever generated holders automatically.
- ~~Claiming is still a read-modify-write, so two processes writing within the same few
  milliseconds can both believe they won.~~ **Closed by the atomic claim** in
  [ADR 0006](../adrs/0006-host-the-ideas-ledger.md): a claim is one conditional `UPDATE` against
  D1 whose `changes` count decides the winner, so two runs claiming at once produce one holder and
  one refusal naming them. It needed no lock file, no owner and no recovery path — the database
  already arbitrates. What is *not* closed is the line below it: a holder is free text, so two runs
  choosing the same holder string still read each other's claim as their own re-claim.
- There is no `ideas defects` analogue. A rule can be systematically wrong and the dismissals prove
  it; an idea is a one-off, so there is no population to indict. If a *source* turns out to produce
  bad ideas repeatedly, nothing currently notices. The provenance envelope is the *precondition*
  rather than the answer: with `by` on the entry there is finally a population to group rejections
  by, but nothing reads it that way yet, and one thread id per entry is a thin basis for indicting a
  source until several runs have accumulated under it.

## Related

- [Session suggestions](session-suggestions.md) — the other store, and the evidence standard this
  one deliberately does not share.
