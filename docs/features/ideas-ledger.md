---
type: feature
title: Ideas ledger
description: A store for invented proposals, kept separate from the suggestion flags because an idea has no source sessions behind it — only a recorded human sign-off makes one actionable.
tags: [advice, cli, ideas]
timestamp: 2026-08-05
dirty: true
---

# Ideas ledger

## Summary

`<logDir>/ideas.json` records features and commands somebody proposed building, and what a human
decided about each one. It is read and written by `pnpm --filter server ideas`, which needs no
running server, and adjudicated from the dashboard's [Advice page](admin-dashboard-for-claude-proxy-usage.md)
over `GET /api/ideas` and `POST /api/ideas/status`.

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
- **The statuses** — `proposed` (the default), `accepted` (a human signed it off), `rejected`
  (with the reason), `shipped` (with the PR url). Only `accepted` carries a sign-off, and it is
  the only status `/improve` may act on; a `proposed` or `rejected` idea is still invention.
- **`proposed` is persisted, unlike a `pending` suggestion.** The suggestion store drops a
  `pending` entry on read and deletes it on write, so that file holds only decisions. Here the
  ledger's whole job is to record **what was already considered** — an idea proposed and rejected
  must never be proposed again, and the rejection reason is the most valuable row in the file. A
  store that kept only the liked ideas would re-propose the rejected ones on every run.
- **Adding an existing slug is refused, never overwritten**, in any status including `rejected`.
  The refusal is reported rather than thrown, so a batch of three ideas with one collision still
  records the other two, and `add` exits non-zero when anything was refused.
- **Evidence is required, and enforced at the parse boundary.** Every entry must cite at least one
  of `open-question`, `judge-note`, `changelog` or `deferral`, each with a locator: a `path`, or a
  `bucket` + `id` for a judge note, which lives in the suggestion store rather than in a file. An
  entry citing nothing is a parse error rather than a lint — "I noticed the code could use X" is
  exactly the output the requirement exists to suppress.
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

### Adjudicating from the dashboard

The sign-off is a human decision, and requiring it at a terminal is what forced `/ideate` to stop
mid-run and ask in-session. The Advice page carries the ledger instead, so the run records its
proposals and ends, and the decision happens whenever somebody looks.

- **`GET /api/ideas`** lists the ledger with per-status counts, optionally narrowed by `?status=`
  (comma-separated) and `?repo=` (a remote slug — a checkout path is refused here exactly as it is
  on a write). `meta.total` always counts the whole ledger, so a filtered view still says how much
  it hid. **`/api/ideas/stream`** shadows it over SSE watching the log directory, so an idea
  `/ideate` writes from a terminal appears without a page reload.
- **`POST /api/ideas/status`** takes `{ marks: [{ slug, status, note? }] }` through the same
  `parseIdeaMarks` / `applyIdeaMarks` the CLI uses. It is on the server's **write allowlist**, under
  the origin-checked CORS the chat routes use rather than the reads' open `*`: this ledger is
  device-wide, shared across every repo on the machine, and an `accepted` row is the sign-off
  `/improve` then acts on.
- **The browser may set `accepted`, `rejected` and `proposed` (the undo) only.** `shipped` stays
  CLI-only because it carries a PR url and is a claim made by whoever landed the change, not a
  button beside Accept.
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
- A ledger that exists but does not parse **500s rather than rendering empty**, for the reason
  below: a page claiming a fresh ledger is how a rejected idea gets re-proposed.

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
ideas list  [-s|--status <flags>] [--repo <slug>] [--json]
ideas add    --json <entries>|-
ideas mark   --slug <slug> -s|--status <flag> [-n|--note <text>] [--json]
```

- `-s` / `--status` — comma-separated subset of `proposed`, `accepted`, `rejected`, `shipped`.
- `--repo` — a git remote slug, `owner/name`.
- `--json` — on `list` and `mark`, machine-readable output. **On `add` it carries the payload**: a
  JSON array of entries, or `-` to read stdin. `add`'s own output is always JSON, since its input
  is, which is also why the flag is not doing double duty on that verb.
- `--help` — the usage, including what each verb refuses.
- `LOG_DIR` selects the store, exactly as it does for `suggestions`.

An entry is `{ slug, title, rationale, evidence[], repo, status?, note? }`, and each evidence item
is `{ source, path?, bucket?, id?, quote? }`.

## Where the code lives

`packages/core/src/ideas.ts` is pure — no I/O, no clock (callers pass `now`) — holding the store
shape, the parse and apply functions, the slug and repo predicates, and `similarIdeaSlugs`. It sits
beside `suggestion-status.ts` and imports nothing from it. `server/src/ideas-store.ts` is the only
code that reads or writes the file, and `server/src/ideas-cli.ts` is the command line.

Over HTTP, `buildIdeas` and `applyIdeaStatus` in `server/src/api.ts` are the read and the write, and
`server/src/server.ts` dispatches `/api/ideas`, `/api/ideas/stream` and `/api/ideas/status`. Neither
builder takes a `SidecarSource` and neither is shadowed: the ledger is *authored* state with no
derived half, so there is nothing for the SQLite substrate to disagree about. In the dashboard,
`apps/admin/src/components/IdeaCard.tsx` is the card and the Ideas section of
`apps/admin/src/routes/advice.tsx` is the list.

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

## Open questions

- The ledger is device-local, like the suggestion flags, so an idea accepted on one machine is
  invisible on another. That is consistent and it is also why the repo field is a remote slug
  rather than a path — the data is portable even though the file is not. Syncing it would need a
  home that is not `logs/`.
- `similarIdeaSlugs` compares slug tokens, so it catches a rename and misses a genuine restatement
  under unrelated words. A comparison over the title and rationale would catch more, and would need
  a threshold nobody has evidence for yet.
- Nothing records *who* accepted an idea, only that the status changed and when. With one human on
  the device that is the same fact; it stops being so if the ledger is ever shared.
- A `shipped` idea keeps its PR url in the same single `note` a `rejected` one keeps its reason in,
  so an idea that was rejected and later revived and shipped keeps only the second. The suggestion
  store solved the equivalent problem by moving enrichment to bucket level; here it has not come up.
- There is no `ideas defects` analogue. A rule can be systematically wrong and the dismissals prove
  it; an idea is a one-off, so there is no population to indict. If a *source* turns out to produce
  bad ideas repeatedly, nothing currently notices.

## Related

- [Session suggestions](session-suggestions.md) — the other store, and the evidence standard this
  one deliberately does not share.
