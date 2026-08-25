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
**Integration branch:** `the-great-merge` (cut from it, merged back into it; the planning and campaign pull requests target it — resolved from `--integration`, not the repository default)
**Base branch:** `wayfinder/provider-seam` (cut from the integration branch above; every ticket targets it)
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
5. **The claude/ox port collision changes category.** It was pre-existing awkwardness only
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
| 02 | sidecar-v2-provider-discriminator | [provider-seam-02-sidecar-v2-provider-discriminator](provider-seam-02-sidecar-v2-provider-discriminator.md) | `task/provider-seam-02-sidecar-v2-provider-discriminator` | in-progress | |
| 03 | claude-migration-23 | [provider-seam-03-claude-migration-23](provider-seam-03-claude-migration-23.md) | `task/provider-seam-03-claude-migration-23` | todo | |
| 04 | codex-store-repair-and-migration | [provider-seam-04-codex-store-repair-and-migration](provider-seam-04-codex-store-repair-and-migration.md) | `task/provider-seam-04-codex-store-repair-and-migration` | todo | |
| 05 | ox-store-repair-and-migration | [provider-seam-05-ox-store-repair-and-migration](provider-seam-05-ox-store-repair-and-migration.md) | `task/provider-seam-05-ox-store-repair-and-migration` | todo | |
| 06 | pricing-table-and-read-time-cost | [provider-seam-06-pricing-table-and-read-time-cost](provider-seam-06-pricing-table-and-read-time-cost.md) | `task/provider-seam-06-pricing-table-and-read-time-cost` | todo | |
| 07 | typed-store-absence-envelope | [provider-seam-07-typed-store-absence-envelope](provider-seam-07-typed-store-absence-envelope.md) | `task/provider-seam-07-typed-store-absence-envelope` | todo | |
| 08 | provider-scoped-routes-and-fanout | [provider-seam-08-provider-scoped-routes-and-fanout](provider-seam-08-provider-scoped-routes-and-fanout.md) | `task/provider-seam-08-provider-scoped-routes-and-fanout` | todo | |
| 11 | feature-flag-gating | [provider-seam-11-feature-flag-gating](provider-seam-11-feature-flag-gating.md) | `task/provider-seam-11-feature-flag-gating` | todo | |
| 13 | cross-provider-token-series | [provider-seam-13-cross-provider-token-series](provider-seam-13-cross-provider-token-series.md) | `task/provider-seam-13-cross-provider-token-series` | todo | |
| 14 | ui-pricing-crud-page | [provider-seam-14-ui-pricing-crud-page](provider-seam-14-ui-pricing-crud-page.md) | `task/provider-seam-14-ui-pricing-crud-page` | todo | |
| 15 | ui-unknown-cost-treatment | [provider-seam-15-ui-unknown-cost-treatment](provider-seam-15-ui-unknown-cost-treatment.md) | `task/provider-seam-15-ui-unknown-cost-treatment` | todo | |
| 16 | ui-fallback-stamp | [provider-seam-16-ui-fallback-stamp](provider-seam-16-ui-fallback-stamp.md) | `task/provider-seam-16-ui-fallback-stamp` | todo | |
| 17 | ui-interrupted-resumed | [provider-seam-17-ui-interrupted-resumed](provider-seam-17-ui-interrupted-resumed.md) | `task/provider-seam-17-ui-interrupted-resumed` | todo | |
| 18 | docs-feature-and-spec | [provider-seam-18-docs-feature-and-spec](provider-seam-18-docs-feature-and-spec.md) | `task/provider-seam-18-docs-feature-and-spec` | todo | |
| 19 | ox-8788-stragglers | [provider-seam-19-ox-8788-stragglers](provider-seam-19-ox-8788-stragglers.md) | `task/provider-seam-19-ox-8788-stragglers` | in-progress | |
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
- **11** after 01.
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
