---
type: feature
title: Ideas ledger
description: A store for invented proposals, kept separate from the suggestion flags because an idea has no source sessions behind it — only a recorded human sign-off makes one actionable, and a claim stamped at the start of work keeps two runs from building the same one.
tags: [advice, cli, ideas]
timestamp: 2026-08-07
dirty: true
---

# Ideas ledger

## Summary

`<logDir>/ideas.json` records features and commands somebody proposed building, and what a human
decided about each one. It is read and written by `pnpm --filter server ideas`, which needs no
running server, and adjudicated from the [dashboard's](admin-dashboard-for-claude-proxy-usage.md)
`/ideas` page — one tab per area, one detail page per idea — over `GET /api/ideas` and the
`POST /api/ideas/status`, `/api/ideas/area` and `/api/ideas/comment` writes.

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

- **The store** — `<logDir>/ideas.json`, beside the transcripts, so it travels with a `LOG_DIR`
  override and stays device-local (`logs/` is gitignored). Written through a temp file and a
  rename, so a reader never sees a half-written file and a crash mid-write leaves the previous
  ledger intact. Version 1.
- **The key is the slug alone**, not `(repo, slug)`. The store is device-wide and shared across
  every repo on the machine, so the repo an idea lands in is a *field*, carried as a git remote
  slug (`llevasseur/claude-proxy`). **An absolute checkout path is refused**, because it names a
  different thing — or nothing — on another machine.
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
- **A claim carrying a `pr` never goes stale**, however old. An open PR is live evidence the work
  exists, and expiring such a claim would invite exactly the duplicate implementation this state
  was added to stop. This is what makes a six-hour TTL safe: the long part of an idea's life is PR
  review, not writing, and `pr` covers that part.
- **`ideas mark -s accepted` is the explicit release**, for a run that gives up before the expiry.
  Every mark but `shipped` drops the claim; `shipped` keeps it as the record of who built the thing.
- **`ideas list --available` is what an implementation run should read** — `accepted` plus any
  `claimed` entry whose claim has expired. Plain `-s accepted` never recovers an idea abandoned by
  a dead run, and `-s accepted,claimed` would take one out from under a live holder.
- **The race is narrowed, not eliminated, and the residue is stated rather than papered over.** Like
  every other writer here, `claimIdeasInStore` is a read-modify-write and is not atomic against a
  second process in the same few milliseconds. The failure it was built for was eleven minutes wide;
  closing it absolutely would mean a lock file with an owner, a timeout and a recovery path — its
  own stuck states, on a ledger with one writer at a time and a duplicate PR as the worst outcome.

**The command prose that has to change lives outside this repo.** `/ideate` and `/improve` are
user-level command files on the device, not files in this checkout. The mechanism here is complete
and usable, but an implementing run only stops colliding once its command file calls
`ideas claim --by <branch>` as its first step and reads `list --available` in place of
`list -s accepted`.

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
  reading `counts` wants the five statuses. **`/api/ideas/stream`** shadows the list over SSE
  watching the log directory, so an idea `/ideate` writes from a terminal appears without a reload.
- **`POST /api/ideas/status`** takes `{ marks: [{ slug, status, note? }] }` through the same
  `parseIdeaMarks` / `applyIdeaMarks` the CLI uses. It is on the server's **write allowlist**, under
  the origin-checked CORS the chat routes use rather than the reads' open `*`: this ledger is
  device-wide, shared across every repo on the machine, and an `accepted` row is the sign-off
  `/improve` then acts on.
- **The browser may set `accepted`, `rejected` and `proposed` (the undo) only.** `shipped` stays
  CLI-only because it carries a PR url and is a claim made by whoever landed the change, not a
  button beside Accept. `claimed` is absent for a different reason: it is not a decision a person
  makes but a machine registering that it has started building, and it must carry a holder a second
  run can recognise — a button would park an idea for the whole expiry under a holder nobody can
  find. **Releasing** one is allowed, and is `accepted`: the card's Release button frees an idea
  from a run that hung without waiting the six hours out, and leaves the sign-off intact.
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
rather than by a stored flag, and the test is all-or-nothing: *every* non-empty line must open with a
bullet marker. A paragraph that happens to contain a dash therefore renders as the paragraph it is,
and a half-converted rationale never renders as a list with prose floating beside it. A leading
`**Label**` is split off so the labels can hang, which is what makes the fixed order scannable.

The card shows the **first three** bullets and the permalink shows all of them. The cut is by bullet
rather than by height because `-webkit-line-clamp` requires `display: -webkit-box`, which stops a
`<ul>` rendering as a list at all — and because the fixed order puts the three a scanning reader
wants at the top. A legacy paragraph keeps the old three-line clamp.

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
`countIdeaAreas`, `similarIdeaSlugs` and `similarAreas`. It sits beside `suggestion-status.ts` and
imports nothing from it. `server/src/ideas-store.ts` is the only code that reads or writes the file,
and `server/src/ideas-cli.ts` is the command line.

Over HTTP, `buildIdeas` is the read and `applyIdeaStatus`, `applyIdeaArea` and `applyIdeaComment` are
the writes, all in `server/src/api.ts`; `server/src/server.ts` dispatches `/api/ideas`,
`/api/ideas/stream`, `/api/ideas/status`, `/api/ideas/area` and `/api/ideas/comment`. No builder here
takes a `SidecarSource` and none is shadowed: the ledger is *authored* state with no derived half, so
there is nothing for the SQLite substrate to disagree about. In the dashboard,
`apps/admin/src/components/IdeaCard.tsx` is the card, `apps/admin/src/routes/ideas.tsx` is the tabbed
list, `apps/admin/src/routes/idea-detail.tsx` is one idea in full, and both are registered by hand in
`apps/admin/src/router.tsx`; the Ideas section of `apps/admin/src/routes/advice.tsx` is now a summary
line linking across.

The store is still **device-wide** while the page is about one proxy's logs, which is why the repo is
on the card: a reader has to be able to see that an idea belongs to another checkout. That is the
question a route was originally held back over, and putting the remote slug on the card is the whole
of the answer.

## Acceptance criteria

- [x] The ledger lives at `<logDir>/ideas.json`, is written through temp-file-plus-rename, and a
      missing file reads as empty.
- [x] A file that exists but does not parse throws rather than reading as empty, so a waterfall
      caller can tell an absent tier from a broken one.
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
- [x] Every verb works with no server running and takes `--json`.
- [x] `GET /api/ideas` returns the rows with per-status counts, narrows by status and repo, refuses
      a checkout path, and refuses any non-GET under the read routes' 405 gate.
- [x] `POST /api/ideas/status` round-trips accepted and rejected, refuses `shipped` and a
      note-less rejection with 400, writes nothing for an unknown slug, and sits on the write
      allowlist so a foreign origin is refused with 403.
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
- [x] `claimed` cannot be set from the dashboard, but a claim can be released there.
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
- [ ] `/ideate` and `/improve` claim before building and read `--available` instead of
      `-s accepted`. **Those command files live outside this repo**, so this one is not closed by
      anything in this checkout.
- [ ] `/ideate` chooses an area for every proposal it records and cites `command-gap` when the gap is
      a command that was never written. **That command file lives outside this repo**, at
      `~/.claude/commands/`, so nothing in this checkout closes it.
- [ ] `/improve` reads an accepted idea's `comment` as build criteria. **Same story**: the command
      file is outside this checkout, and the field is here waiting for it.

## Open questions

- The ledger is device-local, like the suggestion flags, so an idea accepted on one machine is
  invisible on another. That is consistent and it is also why the repo field is a remote slug
  rather than a path — the data is portable even though the file is not. Syncing it would need a
  home that is not `logs/`.
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
- Claiming is still a read-modify-write, so two processes writing within the same few milliseconds
  can both believe they won. Closing that would need a lock with an owner and a recovery path, and
  the failure it guards against is a duplicate PR rather than data loss.
- There is no `ideas defects` analogue. A rule can be systematically wrong and the dismissals prove
  it; an idea is a one-off, so there is no population to indict. If a *source* turns out to produce
  bad ideas repeatedly, nothing currently notices. The provenance envelope is the *precondition*
  rather than the answer: with `by` on the entry there is finally a population to group rejections
  by, but nothing reads it that way yet, and one thread id per entry is a thin basis for indicting a
  source until several runs have accumulated under it.

## Related

- [Session suggestions](session-suggestions.md) — the other store, and the evidence standard this
  one deliberately does not share.
