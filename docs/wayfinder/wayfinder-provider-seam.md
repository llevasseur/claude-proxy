---
type: note
title: Wayfinder — Provider Seam
description: Campaign map for extracting versioned ProviderAdapter and HarnessAdapter seams, routing every token calculation through the (provider, model) pair that produced it, and landing per-proxy storage.
tags: [wayfinder, providers, adapters, storage, campaign]
timestamp: 2026-08-25
scope: all
---

# Wayfinder — Provider Seam

**Slug:** `provider-seam`
**Integration branch:** `main` (the campaign pull request targets it)
**Base branch:** `wayfinder/provider-seam` (every ticket targets it)
**Unattended:** `yes` (fixed at start by whether `--unattended` was typed there; `yes` means the kickoff prompt resumes this campaign unattended)
**Plans directory:** `docs/wayfinder`
**Started:** 2026-08-25
**Goal:** Extract a versioned ProviderAdapter and HarnessAdapter from the three fused stacks, route every token calculation through the (provider, model) pair that produced it, and land per-proxy storage.

> Ephemeral scaffolding, on a schedule. Every `provider-seam-*.md` plan beside this file stays here for
> the campaign's life — marked done once its task lands — so any task can be restarted from what
> was asked. The final ticket `provider-seam-zz` deletes them all; this map goes when the wayfinder
> closes. The durable output is the merged code and the repository's feature and spec docs.

## Scope

**In scope.** Two adapter registries and their versioned contract; sidecar v2; per-store
migrations on all three stacks; a rate table with read-time cost resolution; the typed
store-absence envelope; the data side of the provider picker; four dashboard surfaces.

**Out of scope, and a ticket that touches them is rejected:** removing any existing
claude-proxy page, metric or capability. **Every capability survives.** What is
Anthropic-wire-specific gates on the ProviderAdapter and what is Claude-Code-specific
gates on the HarnessAdapter, so it answers false and does not render for a codex or ox
session. Gating is not deletion.

**Also out of scope:** rewriting Ox Alpha's usage normalizer (ADR 0063), any canonical
cross-provider token schema (ADR 0064), and any rebuild-or-drop path for any database
(ADRs 0047, 0048, 0065).

## Decisions governing this campaign

Six records written before any ticket was cut, from a five-round grill. **Read these
before executing anything — three of them correct the original brief.** All six are
`decided-by: /dev`, `ratified: false`, `needs-human: true`.

| ADR | Decision |
|---|---|
| [0060](../adrs/0060-a-stores-absence-is-typed.md) | A store's absence is **typed**, never a bare gap. Three states stay distinct: never created, present-but-unreadable, and genuinely-zero (a real measurement) |
| [0061](../adrs/0061-three-schemas-three-ladders-one-contract.md) | **Three schemas, three independent ladders, one adapter contract.** claude 22→23, codex 3→4, ox 1→2. Shared mechanism, never a shared schema |
| [0062](../adrs/0062-three-servers-and-one-moved-port.md) | **Three servers**, dashboard fans out over three origins, and ox's server default moves `8788`→`8808`. Amends one clause of the (also unratified) ADR 0050 |
| [0063](../adrs/0063-ox-alpha-keeps-its-nested-usage-buckets.md) | **Ox Alpha keeps its nested-bucket normalizer unchanged**; the disjoint-bucket claim is recorded as an open question |
| [0064](../adrs/0064-tokens-do-not-aggregate-across-providers.md) | **Tokens never aggregate across providers.** Side-by-side series; any all-provider scalar is money only |
| [0065](../adrs/0065-cost-is-resolved-at-read-time.md) | **`cost` and `pricing_source` are not stored**, resolved at read time. `provider`/`harness`/`model`/`adapter_version` are stored |

### Ratified records this campaign implements rather than re-decides

Cite these; do not re-open them. [0040](../adrs/0040-three-providers-and-three-harnesses.md)
(two independent registries, no combined key, neither column inferred from the other),
[0041](../adrs/0041-provider-picker-drives-the-navigation.md) (the picker and the rail),
[0044](../adrs/0044-every-model-gets-a-price-row.md) (rate table, CRUD page, fallback
stamp, unknown/null, no effective dating), [0020](../adrs/0020-unavailable-incomplete-cost.md)
(typed unavailable reason, never zero), [0038](../adrs/0038-retroactive-catalogue-pricing.md)
(reprice at today's rates), [0046](../adrs/0046-narrowly-scoped-local-writes.md) (n stores,
n writers, no cross-provider join at the storage layer, `interrupted`/`resumed`/
`usage_complete: false`), [0047](../adrs/0047-sqlite-substrate-with-forward-only-migrations.md)
(forward-only ladder, per-database), [0048](../adrs/0048-deletion-policy-split-by-tier.md)
(the record tier is never deleted), [0042](../adrs/0042-claude-dashboard-is-the-design-baseline.md)
(claude's dashboard is the baseline and UI design is delegated to a Fable subagent).

## Corrections to the brief, established by measurement

A ticket that follows the original brief instead of the correction will do the wrong work.

1. **Per-proxy storage, reader-side fan-out and `interrupted`/`resumed` were NOT
   ungoverned.** ADR 0046 already ratifies all three, at lines 41, 72 and 56–64. Two
   planned `/dev` ADRs re-deciding them were **struck** — re-deciding a ratified decision
   creates a second authority for one question.
2. **"Columns on every record" does not hold for `cost` and `pricing_source`.** Both are
   functions of a table an operator may edit at any moment, and freezing them defeats the
   purpose ADR 0044 line 71 gives the stamp. See ADR 0065.
3. **The three stores share no schema and cannot.** ox's entire schema is three tables
   with the payload in a `sidecar_json` blob — no `model` column, no token columns, no
   request table. Convergence would be a rewrite of two servers, not an adapter
   extraction. See ADR 0061.
4. **`body_derived` is real.** It is a column on `request`, added in the `SCHEMA_V13`
   block of `stacks/claude/server/src/db/open.ts`, and the comment above it records why it
   is deliberately not `skim_text IS NOT NULL`. An earlier pass wrongly concluded it did
   not exist by grepping for a *table* of that name.
5. **The integration branch this campaign was cut from no longer exists.** `the-great-merge`
   was deleted at origin once PR #295 landed the fusion campaign on `main` — as a squash, so
   none of this campaign's own commits are ancestors of `main` either. The header above now
   names `main`, and `wayfinder/provider-seam` was resynced with it on 2026-09-10, 225
   commits behind at the time. Two conflict classes are worth knowing before the next
   resync: ox's ports resolve to **this campaign's** side (`8808`, ADR 0062), and claude's
   admin CSS resolves to **main's** side, because `scripts/check-css-flow-spacing.mjs`
   arrived on main and fails the older `margin-top` form.
6. **The claude/ox port collision changes category.** It was pre-existing awkwardness only
   while nothing required both servers up at once; ADR 0041's picker requires exactly that.
   See ADR 0062.

## Live measurements

Taken before charting; re-measure rather than trusting these if a ticket turns on one.

- `stacks/claude/server/src/db/open.ts:38` — `SCHEMA_VERSION = 22`, 27 tables.
- `stacks/codex/server/src/database.ts:22` — `SCHEMA_VERSION = 3`.
- `stacks/ox-alpha/server/src/database.ts:20` — `SCHEMA_VERSION = 1`, three tables.
- The live claude database is 2.1 GB at `user_version` 22: **60,834 requests**, 56,951
  `request_skim` rows, 57,623 at `body_derived = 1`, **3,211 at `blob_evicted = 1`**, and
  6 distinct models. Those 3,211 evicted-body rows are exactly why forward migration is
  mandatory and no rebuild path exists.
- Ports: claude server `8788`, ox server `8788` (collide), codex server `4319`.

## Residual risks

1. **The route-budget gate still measures nothing.** It resolves `stacks/claude/logs`,
   which exists in no checkout, while the store is at the repository root — inherited from
   the fusion campaign's ticket 09, which is still `paused`. **Do not read this gate's
   pass as a measurement.**
2. **The six distinct models are today's corpus, not a property of the design.** ADR 0044
   makes the price table "a row for every model the corpus contains", so it grows. The
   read-time join in ADR 0065 stays cheap because it is keyed on `model` against a small
   dimension table, **not** because six is small.
3. **No captured ox-alpha-proxy sidecar exists in this repository.** Every capture in
   `stacks/claude/logs` is `_anthropic.*`. ADR 0063's open question cannot be closed from
   anything currently here.
4. **codex's delete-on-mismatch and ox's missing ladder are live data hazards**, not
   cleanup. Tickets 04 and 05 each fix their own before bumping, which is why each is one
   ticket rather than two.
5. **Three admin dev servers still share `5173`.** ADR 0062 deliberately leaves them,
   because the picker does not require them bound simultaneously. If a later campaign runs
   two dashboards at once, that becomes in scope by the same test.

## Active tasks

| # | Task | Plan | Branch | Status | Note |
|---|------|------|--------|--------|------|
| 13 | cross-provider-token-series | [provider-seam-13-cross-provider-token-series](provider-seam-13-cross-provider-token-series.md) | `task/provider-seam-13-cross-provider-token-series` | todo | |
| 17 | ui-interrupted-resumed | [provider-seam-17-ui-interrupted-resumed](provider-seam-17-ui-interrupted-resumed.md) | `task/provider-seam-17-ui-interrupted-resumed` | in-progress | |
| 18 | docs-feature-and-spec | [provider-seam-18-docs-feature-and-spec](provider-seam-18-docs-feature-and-spec.md) | `task/provider-seam-18-docs-feature-and-spec` | todo | |
| zz | retire-done-plans | [provider-seam-zz-retire-done-plans](provider-seam-zz-retire-done-plans.md) | `task/provider-seam-zz-retire-done-plans` | todo | Final ticket — deletes every plan. Execute last. |

<!--
Status is exactly one of these six:
  todo          — never started; nothing to resume. Pick it up.
  in-progress   — a ticket run is executing it now. Leave it alone.
  paused        — deliberately stopped, resumable as-is. Pick it back up.
  blocked-limit — the usage window ran out mid-run; nothing is wrong with the
                  work. Resume it once the window resets.
  rejected      — a human reviewed it and turned it down. Do NOT retry it; it
                  needs a new human decision or a rewritten plan.
  redo          — the work landed but must be done again differently. Restart
                  it from the plan.
Note is required for blocked-limit, rejected, and redo; empty for the rest.

The `zz` row is this campaign's final ticket. It always sorts last, it is executed
after every other task, and it deletes every plan in this directory. Do not drop it:
nothing else removes them, so without it they outlive the campaign permanently.
-->

## Ordering

**01 is the spine and blocks almost everything** — it defines the contract every other
ticket codes against. **02 follows 01.**

- **01 → 02** sequential.
- **03, 04, 05** after 02, and **independent of each other by file scope** — one per stack,
  no shared files. They are the campaign's widest wave.
- **06** after 03. **07** after 03, 04 and 05, since it needs all three stores to fan out
  over. **08** after 07. **13** after 08.
- **09, 10, 12** are independent of the spine by file scope and may run in the first wave
  alongside 01: 09 touches only ox's server config, 10 only claude's admin route registry,
  12 only claude's core money and cost-reason modules.
- **11** after 01. **20** after 11 — it repairs a stand-in 11 could only document, because
  the file it has to widen was 01's and already merged.
- **14, 15, 16** after 06 (they render pricing state). **17** after 07. The four UI tickets
  are independent of **each other** by file scope once their data has landed.
- **18** after everything it documents. **zz** last, after every other ticket completes.

**Two orderings are internal to a ticket rather than between tickets, deliberately.**
Ticket 04 removes codex's delete-on-mismatch *before* bumping its ladder, and ticket 05
adds ox's forward ladder *before* bumping its version. Splitting either into two tickets
would let a wave run them out of order, and in 04's case that destroys codex's corpus. They
are one ticket each precisely so the ordering cannot be violated.

A gate is a commit on `wayfinder/provider-seam` with a green verify and an honest map.

## Agent kickoff prompt

> Read this repository's agent instructions, the wayfinder workflow, and the campaign map
> at `docs/wayfinder/wayfinder-provider-seam.md`. Inspect live git and worktree state
> rather than trusting any summary.
>
> Before choosing anything, repair stale rows: for each task marked in progress, check
> whether a run is really behind it — a live worktree, a branch pushed within that run's
> lifetime, an open pull request. Leave the ones that have one. For the rest, read the
> branch and rewrite the status: to stopped-by-usage-window where work is in hand, and to
> never-started where there is nothing worth resuming.
>
> Then execute the next unblocked active task by running the task workflow against its
> plan, with `wayfinder/provider-seam` as the base branch, and retarget the resulting pull
> request to that same branch. A task is eligible when it was never started, was
> deliberately paused, was stopped because a usage window ran out and that window has since
> reset, or is marked for redoing differently. Never re-execute a task a human rejected —
> report it and pick another. A task marked in progress belongs to a live run.
>
> The task numbered `zz` deletes this campaign's plan files. Execute it only once it is the
> last active task left; skip it while any other task is active, and never drop it from the
> map or treat it as already done.
>
> If you stop before the pull request is open, set the task's status to say why, with a
> short note, rather than leaving it marked in progress.
>
> This campaign's map records it as unattended, so type the wayfinder workflow's
> `--unattended` flag on the invocation you run. That routes the ticket through the
> merge-through runner, which resolves conflicts, waits for checks, retargets the pull
> request onto `wayfinder/provider-seam`, and merges it there. Do not stop at the open pull
> request — carry the ticket through to merged, never leave it targeting the repository
> default branch, and include the merge in what you report back.

## Completed

<!-- newest first; one entry appended per task completion -->

### 15 — ui-unknown-cost-treatment · 2026-09-10 · [#329](https://github.com/llevasseur/claude-proxy/pull/329)

An unknown cost now looks like one. The plan assumed the data was already flowing; it was
not — the read-time pricing path from tickets 06 and 12 was **built and entirely
unplugged**. No route returned a `CostUnavailableReason`, every money field the dashboard
consumed was a non-nullable `number`, and `$0.00` was therefore indistinguishable from "we
cannot price this". So this ticket wired the seam as well as rendering it, which is the
main deviation from what was written down.

`stacks/claude/core/src/unavailable-notice.ts` projects `CostUnavailableReason` and ADR
0060's `ProviderUnavailableReason` onto one record a surface renders, and
`describeCostUnavailable` in `pricing.ts` is the counterpart to ticket 07's
`describeProviderUnavailable`. The unions stay separate types — this is a projection for
rendering, not a merge — and **severity picks the colour while kind never does**, which is
what makes criterion 6's one vocabulary real rather than asserted. `unknown-model` splits
into two rendered codes: a named model with no row is a gap an operator closes by adding
one, while a record naming no model at all becomes `unattributed-record`, since
`rateRowFor` withholds even a declared fallback from it. That is the fourth case ticket 06
produced and the plan did not anticipate.

`GET /api/pricing/coverage` and `stacks/claude/server/src/db/pricing-coverage-store.ts`
answer what share of the corpus can be priced. Two scopes come from one pass: the corpus
figure for discoverability, the day figure for the aggregate, because one bad record in the
archive says nothing about today. The day is bucketed through `reportDay` rather than
`substr(timestamp, 1, 10)` — a reporting day is a day in the report timezone — and
availability is memoized by `(model, consumed-bucket pattern)`, which classifies exactly
where keying on the model alone would report a missing rate against records that never
consumed that bucket. A closed substrate answers with a typed reason instead of an empty
table.

On the dashboard: `Unavailable.tsx` (a hollow dashed pill, non-interactive at `size="lg"`
because `StatCard` wraps its body in a link), `PricingCoverageCard.tsx` on the Overview, a
new `styles/components/unavailable.css`, and all three money tiles going unavailable on a
day that holds an unpriced record per ADR 0044's propagation rule. Token counts are never
blanked.

**The plan's three-phase design protocol ran in full.** A design subagent produced the spec
against `tokens.css`, implementation followed it, and the same subagent verified in Chrome.
It found four misses — no gap below the card, a baseline line asserting a direction under
an unavailable headline, a `<button>` nested inside the tile's `<a>`, and an overhanging
bubble — and a second pass found the error branch hardcoding `store-unreadable` instead of
reading the server's typed reason, plus a card title that was a near-synonym of ticket 16's.
All six were fixed and re-verified green.

**Follow-ups this ticket deliberately did not take.** `RateCoverageCard` still renders a
bare `not priced` placeholder: its `PricingMixModel` payload carries only
`cost: string | null` and no typed reason, so constructing one client-side would invent the
very thing ADR 0020 forbids, and its store belongs to ticket 16. The Overview now carries
two pricing cards from two tickets that do not collide visually but overlap in purpose; the
design verifier's recommendation is that they eventually become one. Light-theme `--amber`
measures 4.34:1 on the bone card, just under 4.5:1, shared with every light-theme
`.usage-chip` and `.usage-partial` — a palette change no single ticket owns.

Verification was partly environmental: port 5173 was held, so the app ran on 5199, and this
worktree had no SQLite substrate, so the 503-with-typed-reason path was verified live while
the populated meter and the unavailable tiles were verified against mocked payloads in the
real page.

### 14 — ui-pricing-crud-page · 2026-09-10 · [#328](https://github.com/llevasseur/claude-proxy/pull/328)

`/pricing` is the operator's surface over ticket 06's rate table: four validated fields per
model, a visible save state, and no JSON on the page. `stacks/claude/admin/src/routes/pricing.tsx`
is the page, mounted by one line of `routes/registry.ts`; three new routes (`/api/pricing` and
two origin-checked writes) are served by `stacks/claude/server/src/rate-table-api.ts`.

**The validation rule went into core rather than into the page**, as `parseRateField`,
`checkRateValue` and `checkModelName` in `rate-table.ts`. The form and the handler ask the same
question, because a form that accepts what the server rejects tells an operator their correction
landed while the corpus reprices to something else. The parser is deliberately narrower than
`Number()`, which reads `0x10`, `1e5` and `Infinity` as numbers, and it holds the same
six-decimal ceiling `pricing.ts` already applies to the catalogue — a rate table is exactly where
a plausible-looking typo must not become a price.

**Blank is not configured and never zero**, kept apart in type face as well as text: `not set` is
dotted prose in the UI face, `0.00` a number in the mono face, with an amber marker on any row
carrying a hole. **A failed save cannot be mistaken for one that landed** — the states differ in
glyph, hue, tense and persistence, the green check decaying while the coral triangle stays until
the operator acts. The reprices-history consequence is the page's standing frame rather than a
modal, since ADR 0065 makes it true on every visit, and after a save the note names the bucket and
the move. No dates anywhere, per ADR 0044.

**Deviations.** The Fallback card is read-only — no edit, no withdraw, no fallback write routes —
because the criteria scope the form to the four rates per model and ticket 16 owns the fallback
surfaces; the declared fallback is still shown so a delete's consequence stays legible. The inline
row edit is not a `<form>`, since one cannot span table cells, so Enter and Escape ride a handler
on the row wrapper.

**The three-phase protocol ran in full and earned its keep.** The Fable design agent's review of
the implementation found four criterion failures the implementer had missed — inline validation
hidden by a stylesheet rule expecting a collector element that was never rendered, a `saved` state
unreachable because the success handler closed the row that held it, a silent failed delete, and a
post-save line that neither named what moved nor skipped no-op saves — plus focus-management gaps.
All are fixed in the branch's second commit.

**Missing evidence, recorded rather than glossed:** there is no browser pass. Port 5173 was held by
another process and `vite.config.ts` pins `strictPort`, so phase 3 was a source-level conformance
review. The API half was exercised against a live server: `GET /api/pricing` answers 503 with a
typed message when no substrate is open, and the writes refuse bad input at 400 naming the field.

**Merge note for later tickets:** 16 and 14 both created
`stacks/claude/admin/src/styles/components/pricing.css`. The conflict was textual only — 16's rules
are all `.rate-*`, 14's all `.pricing-*` — and both survive in one sheet behind a single import
placed after `skeleton.css` and `table.css`, which is what both halves need.

### 16 — ui-fallback-stamp · 2026-09-10 · [#327](https://github.com/llevasseur/claude-proxy/pull/327)

`GET /api/pricing/mix` folds the corpus to one row per model **in SQLite**, then resolves
each against the rate table at the moment of the call. Nothing is cached at any layer — the
store memoises nothing, the response carries no `immutable`, and the card holds its query at
`staleTime: 0` with refetch on mount and focus. That is ADR 0065 taken literally rather than
merely cited: an operator's rate edit moves the figure on the very next read.

**The stamp is dashed, squared and uncoloured, and that is the whole design problem solved.**
ADR 0044 makes a blanket rate a normal state, so a red badge or an alert icon would report an
incident on every page load; it borrows the sheet's existing "placed by rule rather than
observed" gesture and no hue at all. It names the proxy — `anthropic rate`, never the wire
form `fallback:anthropic`, which reads as a defect to anyone who has not read the ADR.

**A fallback price keeps its digits at full `--text` weight**, and that is what holds it apart
from an unpriced one: a fallback is spendable money, an unknown is an absence. Ticket 15's
unknown treatment was left untouched, and the design spec says explicitly what (c) may not
borrow so the two states cannot converge.

**Both shares take priced spend as the denominator, not all spend.** An unpriced model has no
cost to take a share of, so folding it into the denominator would shrink the fallback share by
counting an absence as published spend — the confidently-wrong figure ADR 0065 exists to stop.

Deviations worth knowing. The card's scope is the whole corpus rather than a day window. The
foot line names the Pricing page in **plain text**, because that route is ticket 14's and a
typed `<Link to>` to a route this branch did not declare would not compile — turn it into a
link once 14 lands. The three-phase design protocol ran in full and the reviewing subagent
found three misses, two real (a `@layer` precedence bug that left the empty legend row at full
weight, and a skeleton missing `.skeleton-text`) and one withdrawn on inspection; they are
fixed in `8c359b6`. **In-browser verification did not run** — `scripts/dev-boot.sh` pins Vite
to 5173, held by a concurrent sibling ticket — so the visual spec was verified statically and
the endpoint was exercised over HTTP instead.

### 08 — provider-scoped-routes-and-fanout · 2026-09-10 · [#326](https://github.com/llevasseur/claude-proxy/pull/326)

`ApiRouteDeclaration` gained a `provider` field, and the routes split 56 `anthropic` to 29
`agnostic`. **`agnostic` means no provider corpus, not every provider.** The device and repo
ledgers answer identically whichever provider is asked, so fanning them over three origins
would put one question to three servers and get one answer back three times. The split
follows the per-page judgement ticket 10 already made rather than inventing a second one
that could disagree with it.

**The dispatcher refuses another provider's route with 421, not 404.** The path exists —
this server is simply not the one entitled to answer it, and that is the distinction that
lets a client tell a wrong origin from an undeclared route. A provider-scoped route that
fails carries a typed `unavailableReason` with it, since only the server can see why its own
store failed.

`stacks/claude/admin/src/provider-fanout.ts` fans out over the three origins — claude 8788,
codex 4319, ox 8808 — and merges above the stores. Unreachable and unreadable are separated
by channel rather than by guesswork: a rejected fetch, a 421, a 5xx carrying a typed reason,
and everything else each arrive on their own path.

**The rule itself lives in `stacks/claude/core/src/provider-transport.ts` rather than in the
fetch wrapper**, because claude's admin has no test runner and the decision worth proving
went where it could be proved. `fanOutEnvelopes` is what catches a rejecting read: a bare
`Promise.all` discards the answers that settled beside a rejection, so one provider going
down would have blanked the other two. The redirect guard ticket 10 left unbuilt landed here
too, as `providerRedirectFor`, reading `MODULE_SUPPORT` with no second list.

`my-command-tools verify` was green on all nine gates, CI passed first try, and `/review`
found no defects. Browser verification came back `unverified`: port 5173 is held by another
process on this device, so the server half was exercised directly instead — agnostic routes
returned 200, an undeclared route 404, and a failing provider-scoped route
`{"code":"store-unreadable","provider":"anthropic","fault":"unknown"}`.

### 07 — typed-store-absence-envelope · 2026-09-10 · [#325](https://github.com/llevasseur/claude-proxy/pull/325)

A fan-out read can no longer return a bare gap. `stacks/claude/core/src/store-absence.ts`
holds the vocabulary and `stacks/claude/server/src/db/provider-fanout.ts` is the reader that
produces it, so every provider contributes either data or a typed reason in a per-provider
envelope (ADR 0060).

**The three states are three, and the third is the one the code works hardest to protect.**
A store that was never created is `store-absent` with `data: null` rather than zero, and
`requiresOperatorAttention` returns **false** for it — that is 0060's "a human should be able
to ignore it" made executable, because a dashboard showing two faults on a one-proxy device
teaches its reader to ignore faults. A store that exists and cannot be read is
`store-unreadable`, carrying a `StoreFault` of `locked`, `corrupt`, `migrating` or an honest
`unknown` rather than a guess at the nearest cause. A healthy store with no rows in range is
neither absence: it travels on the available branch as data, so a zero series means the
provider ran and served nothing.

**Two things the plan named that shaped the type's surface.** A fault outside the store gets
`provider-unreachable` carrying the origin, and the reader keeps it apart from a store fault
through a distinct error class rather than a naming convention, so ADR 0062's misattribution
is unreachable rather than merely discouraged. And the union mirrors `CostUnavailableReason`
without importing it — `pricing.ts` had already written down that a store's absence "gets its
own union, written this same way", so this ticket followed that instruction rather than
extending an unrelated enum.

**Three deviations from a literal reading of the plan, each deliberate.** The type is named
`ProviderUnavailableReason`, not `StoreUnavailableReason`, because one of its members is
about a server rather than a store and the name should answer what it actually answers: why
*this provider* has no data. The union carries a fourth member, `fanout-incomplete`, mirroring
`CostUnavailableReason`'s own `aggregate-incomplete`, so `aggregateFanout` propagates per ADR
0044 instead of totalling the providers that answered. And `pickerStatusFor` returns three
values rather than a boolean degraded flag: a provider that has never run is `absent`, not
`degraded`, because the picker's question is not the page's and collapsing the two would put
a steady state and a fault behind one indicator.

**One change the linter forced, which improved the code.** `sqliteFaultFrom` first took
`unknown` and reached for `Reflect.get` to find the driver code. Anti-slop refused both at
`error` severity, and the fix was the one the rule asks for rather than a suppression: the
catch clause parses whatever was thrown into a named `StoreReadFailure` once, and the
classifier takes that domain type.

The fan-out opens no sibling store. It takes a read function per provider and never a path of
its own, so ADR 0046's sole controller and its line 72 ban on a cross-provider join hold as
properties of the code — a test asserts one locked store still leaves the other two
providers' data intact, and another asserts an aggregate over that fan-out propagates rather
than dropping the provider.

**Left to ticket 08 on purpose:** the provider-scoped routes and the three-origin client that
consumes these envelopes. Nothing renders the envelope yet, which is why this ticket's app
verification came back `unverified` rather than green.

### 06 — pricing-table-and-read-time-cost · 2026-09-10 · [#324](https://github.com/llevasseur/claude-proxy/pull/324)

claude's store went to schema 24 with two rate tables — `model_rate` and
`proxy_fallback_rate` — and cost is resolved against them on every read, stored nowhere.
Neither table carries a `valid_from` or any rate history (ADR 0044, no effective dating),
and no `cost` or `pricing_source` column was added to the record or rate tables (ADR 0065).

**The split across core and server is what the deterministic-core rule forced, and it turned
out to be the right seam anyway.** `stacks/claude/core/src/rate-table.ts` holds the *rules*
— row selection, the stamp, the typed unknown — and the server holds the *rates*. The
arithmetic was not re-implemented: once a row is selected the module hands off to ticket
12's `resolveCost`, so ADR 0020's "only a consumed bucket needs a usable rate" lives in
exactly one place instead of two that drift.

**What the plan under-specified was the keying, and it is the load-bearing difference.**
`pricing.ts`'s `MODEL_PRICES` matches a model to a *family* by substring, which is right for
a hand-maintained constant and wrong for an operator-edited dimension table: under substring
matching, adding a row silently reprices its neighbours. So the rate table matches the model
exactly, and `claude-opus-5-20260101` deliberately does **not** hit a row keyed
`claude-opus-5`. A test pins that.

**Three states, kept distinct.** A model with its own row is stamped `table`; one without,
where the proxy declares a fallback, is priced and stamped `fallback:claude` — a normal
state, not an error; one without either is cost `null` with a typed `unknown-model`, never
`0`. A rate of `0` is a real price for a free bucket and stays priced, while a `null` rate on
a bucket that *consumed* tokens sinks the cost with `missing-category-price`.

**One judgement the plan did not cover.** A record with **no model recorded at all** resolves
unknown even where a fallback is declared. "Not in the table" and "this record does not say
what produced it" are different facts, and pricing the second would put a number on a record
nothing is known about.

The migration seeds a row per distinct model already in `request` at its family's catalogue
rate, reading the corpus rather than shipping a guessed list, with `INSERT OR IGNORE` so
re-reaching the rung never overwrites an operator edit. Every mutation touches one row of one
rate table and never opens `request` — a test edits a rate, watches a total move `1.000000` →
`7.000000`, and compares every column of every record against a prior snapshot. Deleting a
row leaves nothing dangling, which is why ADR 0065 chose it over a foreign key.

**Two deviations worth recording.** Two version assertions in
`migration-23-record-stamp.test.ts` named `23` as the ladder's destination and now read
`SCHEMA_VERSION`, since the ladder runs to 24. And a "no cost column anywhere" sweep was
narrowed to the record and rate tables after it caught `command_run_step.cost` — a per-step
analytics figure predating this campaign that ADR 0065 does not govern; widening the
assertion would have failed on another tier's design rather than enforcing 0065.

**App verification came back `unverified`, not green.** The server booted and answered
`/api/health`, so migration 24 does not break boot, but Vite could not bind `5173` (the
pre-existing three-admins collision) and the run contract's health URL is fixed there.
Nothing in this diff is reachable from a served surface yet — tickets 14, 15 and 16 render
it. All nine gates green.

### 03 — claude-migration-23 · 2026-09-10 · [#323](https://github.com/llevasseur/claude-proxy/pull/323)

claude's store went to schema 23, stamping each record with what produced it. **The plan
asked for four columns and the migration adds three**, because `model` is already one:
`request.model` has been `NOT NULL` since slice 1, so re-adding it would fail with
`duplicate column name` and a second model column would give one record two answers. The
other three — `provider`, `harness`, `adapter_version` — are new and nullable, since SQLite
cannot add a `NOT NULL` column to a populated table without a default and a default is
precisely the guess the plan refuses.

**`cost` and `pricing_source` needed no work, and that is the finding worth keeping.**
`request` has never carried a cost column, so ADR 0065 was already satisfied structurally
and ADR 0038's "reprice at today's rates" already holds with no repricing code at all:
nothing derived is frozen onto a row, so every read prices against today's catalogue. The
rebuild path 0038 originally leaned on stays unbuilt.

The backfill writes `anthropic` and `claude-code` as **two independent facts about the
capturing adapter**, never one derived from the other (ADR 0040) — the same v1 resolution
`readSidecar` performs, applied in bulk. **`adapter_version` is left null on purpose**:
those rows predate the adapter contract, so any number would claim a provenance they do not
have, which is the plan's "explicitly unknown rather than guessing a default".

`backUpBeforeMigration23` writes `logs/backups/pre-migration-23-<stamp>.jsonl` before the
ladder runs, aside-and-renamed, holding each row's id, `body_derived` and skim text. **It
has no reader anywhere in the repository, deliberately** — a restore path would make it
load-bearing and would be the forbidden rebuild path. It is skipped for a store already at
23 and for one with nothing to lose.

Ingest fills the three columns going forward. Review changed how: `resolveRecordStamp`
originally re-checked registry membership itself, and now calls `readSidecar` directly,
catching `SidecarValidationError` and discarding the placeholder version a v1 file never
stated. Ten tests cover it, including a column-by-column comparison against a
pre-migration snapshot and an assertion that the database file's **inode and birthtime are
unchanged** across the migration — the one claim a delete-and-rebuild cannot fake.

**Two follow-ups, deliberately not taken here.** Core's `AuditSidecar` in
`stacks/claude/core/src/types.ts` still does not carry v2's provenance header, which is why
ingest reads those fields off the raw parsed object; core was outside this ticket's lane.
And a pre-23 row ingested from a v2 sidecar keeps `adapter_version` null, because the
insert's `ON CONFLICT DO UPDATE` does not heal it.

**One environmental finding worth recording:** `stacks/claude/logs` does not exist in a
fresh worktree, so claude's server opens no database there and degrades to file-scan reads.
The stack's `.env` resolves `AUDIT_DIR` stack-relative under ADR 0054 while
`scripts/bootstrap-worktree.sh` links only `logs/` at the repository root. Pre-existing, and
it means closed-loop verification of any store change cannot run in a worktree.

### 05 — ox-store-repair-and-migration · 2026-09-10 · [#321](https://github.com/llevasseur/claude-proxy/pull/321)

Ox's store gained a forward-only ladder in `open.ts`'s shape before its version moved, in
that order because the plan forbids the reverse. A version the ladder cannot reach throws;
no delete-or-rebuild path exists, pinned by a test asserting the module names no deletion
API and no `-wal`/`-shm` path. `SCHEMA_VERSION` then went 1 to 2, adding `provider`,
`harness`, `model` and `adapter_version` to `usage_records`, stamped at ingest.

**The ladder's steps run in one transaction, which closes a real hazard rather than a
theoretical one.** Without it, a store whose `ADD COLUMN` landed but whose backfill did not
would keep its old `user_version` and re-run that `ADD COLUMN` on every open, forever.

**Ox's identity is written as literals — `ox-alpha`, `opencode`, `1` — not imported.** Ox's
server depends on `@agent-proxy/ox-core` alone and cannot reach claude-core's
`adapter-seam.ts`, so the seam carries data rather than a cross-stack dependency, the same
call ticket 04 made for codex.

**One judgement call and one honest gap.** The migration backfills pre-existing rows via
`json_extract` rather than leaving NULLs, so no row is ever half-stamped; a one-time read at
migration time is not a read path. And `history()` and `sidecarsInRange()` read `model` from
the column, pinned by a test where column and blob deliberately disagree — but
`allSidecars()` and `summary()` still pass whole sidecars to ox-core aggregation. Closing
that needs edits under `stacks/ox-alpha/packages/core/**`, outside this ticket's lane, so it
is documented in the module rather than widened into.

**The merge needed a hand, and the cause is worth recording.** `.gitattributes` gives
`CHANGELOG.md` a `merge=union` driver, but that driver is local: GitHub does not apply it
server-side. This branch and ticket 04's both prepended to the file, so `merge-tree` reported
clean locally while GitHub refused to create the merge commit. Merging the base into the
branch resolved it. Any two campaign tickets in flight together will hit this.

### 04 — codex-store-repair-and-migration · 2026-09-10 · [#322](https://github.com/llevasseur/claude-proxy/pull/322)

codex's store no longer deletes itself, and then it migrated 3 → 4. The two halves shipped
in that order in one commit range, because reversed they destroy the corpus.

**Part A.** `stacks/codex/server/src/database.ts` answered an unrecognised `user_version`
by closing the handle, `rmSync`-ing the database plus its `-wal` and `-shm`, and re-running
the whole schema — ADR 0028's rebuild-on-mismatch, which ADR 0047 supersedes and ADR 0048
forbids for the record tier. Replaced by a forward-only ladder shaped like claude's
`db/open.ts`. A version it cannot reach is a loud refusal that leaves the store untouched:
newer than the build, below `BASELINE_VERSION` (3), or tables present with no stamp. No 001
or 002 migration ever existed — deletion stood in for climbing out of those versions — so a
store at 1 or 2 is refused rather than migrated by a guess.

**Part B.** `migrations/004-record-stamp.sql` adds `provider`, `harness` and
`adapter_version`, populated at ingest. `cost` and `pricing_source` stay out (ADR 0065),
and codex keeps its own schema and ladder (ADR 0061).

**Deviations worth keeping.** The migration adds **three** columns, not the four the plan
names: `model` has been a column since 003, and adding it twice would have been wrong. The
three values are **restated** in a new `src/record-stamp.ts` rather than imported from
claude's core — importing would add a cross-stack runtime dependency and a `pnpm-lock.yaml`
change that collides with the two sibling tickets in flight, and claude's own
`oxAlphaProviderAdapter` already restates ox's rule for the same reason. `record-stamp.test.ts`
pins the version against `openAiProviderAdapter`'s declaration by reading that source, so
the restatement cannot drift. `PRAGMA journal_mode = WAL` moved to **after** the ladder: it
is persistent, so setting it first rewrote the header and created both journal sidecars for
a store about to be rejected — the byte-identical assertion is what caught that. Two
`car.test.ts` tests asserted the deletion behaviour and now assert the refusal, including
that the rows the old path would have destroyed survive.

Tests: a v3 fixture migrating to 4 with every row preserved and backfilled, three loud
refusals, a refused file asserted byte-identical with no `-wal`/`-shm` left behind, and an
anti-deletion guard that scans `src/**.ts` for any removal call or `node:fs` removal import.
`my-command-tools verify` green. CI needed one re-run for an unrelated
`stacks/claude/server` timeout flake (`ideas-pr.test.ts`), green on the re-run.

### 20 — harness-capability-union · 2026-09-10 · [#305](https://github.com/llevasseur/claude-proxy/pull/305)

`HarnessCapability` widened from three members to eight, so the device-config gates name
the harness state they read instead of borrowing `session-transcripts` as the nearest
established member. Six gates were repointed rather than the four the ticket chartered:
re-deriving each gate from its own module found `withheld-tools` reading the same
`~/.claude/settings.json` as `hooks-and-plugins`, and `proxy-filters` describing content
the harness itself shapes. `session-transcripts` now means transcripts alone, pinned by a
test to the three capabilities that parse `logs/sessions/<threadId>.md`.

**The pull request sat open for sixteen days and had never been gated once.** Its branch
recorded zero workflow runs despite `verify.yml` carrying a bare `pull_request:` trigger,
so the only evidence it passed was the body's own claim. It was merged after a real green
run at `5295feb`, and the push trigger now names this campaign's base branch — see the
correction above.

**Merged after the base was resynced, not before.** `wayfinder/provider-seam` was 225
commits behind `main` at the time and cut from a `the-great-merge` that no longer exists;
the resync landed first so this ticket's gate measured the tree the next ticket inherits.

### 02 — sidecar-v2-provider-discriminator · 2026-08-25 · [#298](https://github.com/llevasseur/claude-proxy/pull/298)

Sidecar v2 landed as a five-key provenance header — `schemaVersion`, `provider`, `harness`,
`model`, `adapterVersion` — defined in `stacks/claude/core/src/sidecar.ts` and written by
`stacks/claude/proxy/proxy.ts` on every `.audit.json`.

**The version is read from `schemaVersion` alone, and the absence of that field is defined
once to mean v1.** That is what satisfies "without guessing from which keys are present":
a payload wearing every v2 key but no `schemaVersion` still reads as v1, and a test pins
it. An unrecognised version throws rather than falling back, so a file from a future writer
is never read as an older one.

**Two review findings sat on the module's own headline claims, and both were real.** The
sanitizer matched keys exactly and case-sensitively, so `x-api-key` — the header this proxy
authenticates Anthropic with — passed straight through, along with `set-cookie` and the
canonical `Authorization`/`Cookie` casings, even though the list already carried their
lowercase forms. Keys are now folded to lowercase with `-`/`_` stripped on both sides.
Separately, a payload with no `schemaVersion` but with v2's other discriminators present
took the v1 branch and silently resolved a stated `openai` to the capturing adapter's
`anthropic` — the exact misattribution the v2 path refuses loudly. It is now refused on
both paths, as a consistency check on the result rather than a second version signal.

**The proxy writes the header as literals rather than importing the ids, and that was
forced.** `stacks/claude/proxy` declares no `dependencies` and is executed straight by node,
so importing claude-core's barrel would pull forty modules into its runtime. What crosses
the seam is data — three strings and a number — validated on the way back in by
`readSidecar`. The drift guard that was missing is now there: both sides assert the exact
adapter version, so a bump fails in two places and forces one diff.

**Deliberate follow-up, not done here.** The sanitizer is still never exercised against the
proxy's *real* output — the core round-trip test uses a hand-built body. Closing it needs a
test in `stacks/claude/server`, which can import core where the proxy cannot, so it was left
outside this ticket's lane rather than widening the diff.

### 19 — ox-8788-stragglers · 2026-08-25 · [#299](https://github.com/llevasseur/claude-proxy/pull/299)

Eleven `8788` hits under `stacks/ox-alpha/` before, five after, and each remaining one is a
comment or the `CLAUDE_SERVER_DEFAULT_PORT` constant — every survivor names **claude's**
port rather than configuring ox's, verified against the merged tree rather than taken from
the ticket's own report.

**The contamination this closes was a read-path one, not a collision.** Ox's shipped
dashboard proxied `/api` to claude's server, so it would have rendered claude's data as
ox's, silently and with no error anywhere.

**Two late catches by the ticket's reviewer are the part worth keeping.** The comment pass
run before the pull request **reintroduced** the numeral into a new test header *after* the
count had been taken — a sweep verified by counting can be undone by a later step in the
same run, which is an argument for re-counting last rather than first. And
`vite.config.ts` used `??`, which passes a present-but-empty `ADMIN_SERVER_URL=` straight
through as an empty proxy target; `??` guards absence, not emptiness, and an env var is
routinely present and empty. Both fixed in `1a916bd` before the squash.

### 11 — feature-flag-gating · 2026-08-25 · [#301](https://github.com/llevasseur/claude-proxy/pull/301)

A capability-gating module in `stacks/claude/core/src/` that imports ticket 01's three seam
files without editing any of them, so core stays dependency-free and deterministic.

**29 capabilities audited and classified** — 13 ungated, 11 Claude-Code-specific, 3
Anthropic-wire-specific, 2 both — recorded as a table in the module's doc comment and in
`docs/features/capability-gating.md`. Nothing was deleted, and a test pins that a claude
session still sees all 29.

**The audit reached all 39 route modules and edited none of them.** Ticket 10 owned that
directory, so gating sits at the capability layer instead — which also means a route module
and the classification table cannot drift into disagreeing about one page.

**One imprecision is recorded rather than hidden, and ticket 20 exists to repair it.** The
harness axis reuses ticket 01's closed three-member `HarnessCapability` union, and four
device-config capabilities (`hooks-and-plugins`, `slash-commands`, `cli-internals`,
`project-memory`) had to declare `session-transcripts` as the nearest established member
rather than a precise gate, because `harness-adapter.ts` was ticket 01's and already
merged. Both the module and the feature doc say so outright.

### 10 — route-registry-provider-declarations · 2026-08-25 · [#296](https://github.com/llevasseur/claude-proxy/pull/296)

All 39 route modules in `stacks/claude/admin/src/routes/` now export `providers` beside
their `route` and `nav`, and `registry.ts` collects them into one `MODULE_SUPPORT` list in
`ROUTES` order. A new `routes/providers.ts` holds `PROVIDER_IDS`, `ProviderId`,
`DEFAULT_PROVIDER`, `ProviderSupport` and `EVERY_PROVIDER`. 28 pages declare
`['anthropic']`; the 11 agnostic ones name `EVERY_PROVIDER` rather than spelling the list
out, so a fourth provider reaches all of them at once.

**The declaration is a field on the module, not a field inside `nav`.** A page in no rail
section exports no `nav` at all and still has to say which providers it belongs to, so
putting it inside `nav` would have left every detail route undeclarable.

**Only one of the three consumers exists yet, and that is the plan working as written.**
The rail reads `MODULE_SUPPORT` through `navRailFor`, which leaves an unsupported station
out rather than rendering it disabled. The redirect guard and the docs scope filter arrive
with the picker, which is a later campaign — the docs gate carries no provider vocabulary
today. Nothing keeps a second list, which is what that criterion actually forbids.

**`STATIONS` is now derived rather than its own `as const` literal**, filtered from
`MODULE_SUPPORT`, which is `as const`. Filtering a readonly tuple yields an array of the
element union, so `nav.to` survives as the union of path literals — the guarantee the
original `as const` protected — and it is now asserted rather than left to a reader.

**The type-level assertions were proven to fire, not merely written.** Widening
`skim.tsx`'s `nav` and `providers` to their documented wrong forms made `typecheck` fail at
`registry.ts(237,41)` and `(246,44)`. `typecheck` is claude admin's only gate, so an
assertion nobody had tested would have left the whole verification resting on an untested
line.

### 01 — adapter-contract-and-registries · 2026-08-25 · [#294](https://github.com/llevasseur/claude-proxy/pull/294)

The campaign's spine landed as **three** modules in `stacks/claude/core/src/`, not the two
the plan named: `provider-adapter.ts`, `harness-adapter.ts`, and `adapter-seam.ts`. 23 new
test cases.

**The third file is the deviation worth keeping.** ADR 0040 requires two independent
registries with neither column inferred from the other, and "one file each" would have made
one contract file import the other to reach the shared id unions — a file-level dependency
that contradicts the ADR whatever the types say. `adapter-seam.ts` holds the two id unions
and `RecordStamp`, so both contract files import from it and neither imports the other.

**The ox adapter deliberately does not import `@agent-proxy/ox-core`.** Doing so would need
`allowImportingTsExtensions` while claude's core is browser-bundled under `types: []`, and
every core must stay dependency-free. So `reconcileUsage` takes counters that are **already
parsed and validated** rather than raw payloads, which leaves ox's parser, its five
validations and its `UsageValidationError` untouched — exactly what ADR 0063 requires.

**ADR 0064 is enforced structurally rather than by convention.** Each reconciled type
carries a literal `provider` discriminant, so summing across providers does not typecheck.
Tokens cannot be aggregated across providers by accident.

### 09 — ox-server-port-move · 2026-08-25 · [#293](https://github.com/llevasseur/claude-proxy/pull/293)

`stacks/ox-alpha/server/src/config.ts:86` now defaults to `8808`, beside ox's own proxy on
`8807`. `.zellij/README.md` and the root `AGENTS.md` are updated in both their ports table
and their surrounding prose. Five tests, including a real dual-bind that brings claude's and
ox's servers up together.

**That dual-bind test skips explicitly rather than passing when a port is externally held.**
A bind test that silently succeeds because something else already owns the port asserts
nothing, so it says so instead.

**No `superseded-by` key was added to ADR 0050 or ADR 0062, and that is correct.** ADR 0058
holds that a partial supersession is not a supersession: 0050 still governs the other eight
ports and its whole scoped-variable scheme, so the relation is recorded in prose alone.

### 12 — fold-in-decimal-money-and-cost-reason · 2026-08-25 · [#292](https://github.com/llevasseur/claude-proxy/pull/292)

Both mechanics landed in `stacks/claude/core/src/pricing.ts`, additively: integer picoUSD
arithmetic carried as decimal strings (`resolveCost`, `addUsdAmounts`, `aggregateCost`,
`ExactCost`) and the typed `CostUnavailableReason` with codex's three codes. 16 new cases in
`stacks/claude/core/test/pricing.test.ts`; `my-command-tools verify` green across all eight
gates.

**The gap was real and is now pinned by a test.** `priceFor` answers *every* model, so an
unpriced model has always billed silently at the sonnet-shaped `FALLBACK_PRICE` and read as
a measurement rather than a guess. `resolveCost` refuses to guess instead — `unknown-model`
for an unmatched model, `missing-category-price` for an unusable rate on a **consumed**
bucket only (ADR 0020 says "any consumed usage category", so a broken rate on an unused
bucket does not sink the request), and `aggregate-incomplete` propagated by `aggregateCost`.

**Three deviations worth keeping.** The float API (`estimateCost`, `addCost`, `priceFor`,
`ZERO_COST`) is untouched, because its callers — `digest.ts`, `skim.ts`, `commands.ts` and
`stacks/claude/server/src/command-runs.ts` — sit outside this ticket's lane; the exact path
is a parallel addition rather than a replacement, and swapping the callers over belongs to
whichever ticket owns them. `cost-rate.ts` was deliberately left unchanged: its nulls mean a
day moved no tokens, which is ADR 0060's genuinely-zero — a real measurement, not an unpriced
cost — and typing it as cost-unavailable is precisely the drift criterion 4 forbids. And
`priceFor` now delegates to a new strict `priceRowFor`, leaving one family-matching
implementation rather than two that could drift.

**Refused under "fold in nothing else":** ox's per-entry rate provenance (ADR 0044 gives
claude no effective dating) and both siblings' `Object.freeze` habit — differences, not gaps.

**For ticket 07:** nothing is imported from it and nothing needs to be. The reusable part is
the *shape* — a `code` discriminant plus the context needed to act on it — and the type's doc
comment says so outright, so the store-absence union is written the same way rather than
drifting into an unrelated enum.

**One pre-existing flake observed, not caused here:**
`stacks/ox-alpha/apps/admin/src/css.test.ts` hits its 10s `beforeAll` timeout on a cold Vite
dep-optimization cache in a freshly bootstrapped worktree, and passes in ~1.0s once warm.
