---
type: note
title: Wayfinder — Monorepo Fusion
description: Campaign map for fusing codex-proxy and ox-alpha-proxy into this repository as one pnpm monorepo.
tags: [wayfinder, monorepo, campaign]
timestamp: 2026-08-23
scope: all
---

# Wayfinder — Monorepo Fusion

**Slug:** `monorepo-fusion`
**Integration branch:** `the-great-merge` (cut from it, merged back into it; the planning and campaign pull requests target it — resolved from `--integration`, not the repository default)
**Base branch:** `wayfinder/monorepo-fusion` (cut from the integration branch above; every ticket targets it)
**Unattended:** `yes` (fixed at start by whether `--unattended` was typed there; `yes` means the kickoff prompt resumes this campaign unattended)
**Plans directory:** `docs/wayfinder`
**Started:** 2026-08-23
**Goal:** Make three repositories one repository that verifies green, with zero behaviour change to any of the three stacks.

> Ephemeral scaffolding, on a schedule. Every `monorepo-fusion-*.md` plan beside this file stays here for
> the campaign's life — marked done once its task lands — so any task can be restarted from what
> was asked. The final ticket `monorepo-fusion-zz` deletes them all; this map goes when the wayfinder
> closes. The durable output is the merged code and the repository's feature and spec docs.

## Scope

**In scope.** One pnpm workspace, one toolchain, one docs bundle, one CI gate.

**Out of scope, and a ticket that touches them is rejected:** the wire contracts, the
storage model, the pricing catalogue, the dashboard. Those are campaigns 2 and 3.
Nothing any of the three stacks does today is deleted.

**The rejection rule and its boundary.** Any ticket that changes runtime behaviour is
rejected. The boundary that decides borderline cases, from ADR 0050:

> A fusion-caused regression is in scope to prevent. Pre-existing awkwardness is out of
> scope to fix.

## Decisions governing this campaign

Written before any ticket was cut. Read these before executing anything — several
correct errors in the original brief.

| ADR | Decision | needs-human |
|---|---|---|
| [0050](../adrs/0050-stack-scoped-environment-variables.md) | Port defaults stay verbatim; env-var names become stack-scoped with a per-package legacy fallback | **yes** |
| [0051](../adrs/0051-absorb-ox-into-the-shared-lint-gate.md) | ox absorbed at a warn tier; its biome delta splits by fixability; the GritQL plugin is rescoped | no |
| [0052](../adrs/0052-inherited-ratification-flags-survive-the-merge.md) | Inherited `needs-human`/`ratified` flags survive unchanged; the backfill covers only claude's 6 unflagged records | **yes** |
| [0053](../adrs/0053-the-merged-corpus-replaces-its-sources.md) | The merged ADR record replaces both sources: **38** inherited records, not 46; new records renumbered 0039–0056 | **yes** |
| [0054](../adrs/0054-each-stack-keeps-its-own-corpus-root.md) | Each stack keeps its corpus at its own stack root; resolvers untouched; migration carries its own evidence | **yes** |
| [0055](../adrs/0055-the-rename-covers-every-non-import-reference.md) | The rename covers every non-import reference, gated by a grep, because pnpm fails open | no |
| [0056](../adrs/0056-the-docs-gate-asserts-indexes-by-file.md) | The docs gate asserts section indexes by file and permits links out to source | no |

## Corrections to the brief, established by measurement

Each of these was verified against the three repositories before charting. A ticket
that follows the original brief instead of the correction will do the wrong work.

1. **Ports do not collide the way the brief said.** The three proxies already hold
   `8787`/`8026`/`8807` and both siblings carry comments saying they moved off `8787`
   deliberately. What actually collides: claude's and ox's **servers** (both `8788`),
   all three **admin dev servers** (Vite `5173`), and — created by fusion — the `PORT`
   **variable name** across roles. See ADR 0050.
2. **46 ADRs is a file count, not a record count.** Merging 16 paired records into 8
   yields **38**. See ADR 0053.
3. **"All caught by typecheck" is false for 29 of 184 rename sites.** 155 are
   `.ts`/`.tsx`; the rest are markdown, JSON, YAML and shell. See ADR 0055.
4. **24 colliding top-level paths is an overcount.** 18 collide between claude and
   codex; ox's 16 are a subset.
5. **`git filter-repo` is not installed** on this device. Available via Homebrew 2.47.0.
6. **`.git-blame-ignore-revs` does not exist** in any of the three repos. It must be
   created, and creating it is inert without `git config blame.ignoreRevsFile`, which
   cannot be committed.
7. **Blocker (d) is an anchor mismatch as well as a default mismatch.** codex's server
   resolves `AUDIT_DIR` from `cwd`, its proxy from `import.meta.dirname`.
8. **Blocker (f) needs both halves.** `deploy-concepts.yml` has a stale `paths` filter
   *and* a `pnpm --filter concepts` argument that the rename breaks.
9. **Blocker (h), measured:** codex's `check-docs.mjs` against claude's 62 docs fails
   with exactly 5 errors — 0 broken links, 1 containment violation, 4 index assertions
   that okq's generated format never satisfies. See ADR 0056.

## Residual risks

Noted, not yet ticketed into their own units; each is folded into the ticket named.

1. **ox has no `tsconfig.base.json`**, so blocker (g) does not reach it — four standalone
   configs with no `extends` to repoint, and no severity tier available since tsconfig
   has none. *(ticket 06)*
2. **The ADR timestamp sort is 29/38 tied** — codex's 16 are all `2026-08-19`, ox's 13 all
   `2026-08-22`. Ties break on the source repo's existing number. *(ticket 12, ADR 0053)*
3. **`.gitattributes` `CHANGELOG.md merge=union` silently widens** to `stacks/*/CHANGELOG.md`,
   whose shape was never checked against the justification. *(ticket 14)*
4. **`packages/shared/` empty is a day-one install hazard** — ox's root script is `pnpm -r
   typecheck` with no `--if-present`. *(ticket 10)*
5. **`the-great-merge` divergence is bounded but not free.** 367 of 510 tracked files
   relocate, under git's 1000 rename limit, but every later `main` → `the-great-merge`
   integration is a rename-crossing merge over the two hottest trees.
6. **`~/Library/LaunchAgents/com.llevasseur.claude-proxy.plist` is already broken** — it runs
   `proxy/proxy.mjs`, a file that does not exist — and is not tracked in git, so no ticket
   reaches it. The human's to fix. *(recorded in ADR 0055)*

## Active tasks

| # | Task | Plan | Branch | Status | Note |
|---|------|------|--------|--------|------|
| 01 | rewrite-sibling-histories | [monorepo-fusion-01-rewrite-sibling-histories](monorepo-fusion-01-rewrite-sibling-histories.md) | `task/monorepo-fusion-01-rewrite-sibling-histories` | in-progress | |
| 02 | relocate-claude-stack | [monorepo-fusion-02-relocate-claude-stack](monorepo-fusion-02-relocate-claude-stack.md) | `task/monorepo-fusion-02-relocate-claude-stack` | todo | |
| 03 | scope-claude-packages | [monorepo-fusion-03-scope-claude-packages](monorepo-fusion-03-scope-claude-packages.md) | `task/monorepo-fusion-03-scope-claude-packages` | todo | |
| 04 | sweep-non-import-references | [monorepo-fusion-04-sweep-non-import-references](monorepo-fusion-04-sweep-non-import-references.md) | `task/monorepo-fusion-04-sweep-non-import-references` | todo | |
| 05 | absorb-codex | [monorepo-fusion-05-absorb-codex](monorepo-fusion-05-absorb-codex.md) | `task/monorepo-fusion-05-absorb-codex` | todo | |
| 06 | absorb-ox | [monorepo-fusion-06-absorb-ox](monorepo-fusion-06-absorb-ox.md) | `task/monorepo-fusion-06-absorb-ox` | todo | |
| 07 | reformat-ox | [monorepo-fusion-07-reformat-ox](monorepo-fusion-07-reformat-ox.md) | `task/monorepo-fusion-07-reformat-ox` | todo | |
| 08 | ox-lint-warn-tier | [monorepo-fusion-08-ox-lint-warn-tier](monorepo-fusion-08-ox-lint-warn-tier.md) | `task/monorepo-fusion-08-ox-lint-warn-tier` | todo | |
| 09 | migrate-corpora | [monorepo-fusion-09-migrate-corpora](monorepo-fusion-09-migrate-corpora.md) | `task/monorepo-fusion-09-migrate-corpora` | todo | |
| 10 | unify-toolchain-and-ci | [monorepo-fusion-10-unify-toolchain-and-ci](monorepo-fusion-10-unify-toolchain-and-ci.md) | `task/monorepo-fusion-10-unify-toolchain-and-ci` | todo | |
| 11 | repair-and-wire-docs-gate | [monorepo-fusion-11-repair-and-wire-docs-gate](monorepo-fusion-11-repair-and-wire-docs-gate.md) | `task/monorepo-fusion-11-repair-and-wire-docs-gate` | todo | |
| 12 | merge-adr-corpus | [monorepo-fusion-12-merge-adr-corpus](monorepo-fusion-12-merge-adr-corpus.md) | `task/monorepo-fusion-12-merge-adr-corpus` | todo | |
| 13 | write-campaign-adrs | [monorepo-fusion-13-write-campaign-adrs](monorepo-fusion-13-write-campaign-adrs.md) | `task/monorepo-fusion-13-write-campaign-adrs` | todo | |
| 14 | ports-zellij-and-agents-md | [monorepo-fusion-14-ports-zellij-and-agents-md](monorepo-fusion-14-ports-zellij-and-agents-md.md) | `task/monorepo-fusion-14-ports-zellij-and-agents-md` | todo | |
| zz | retire-done-plans | [monorepo-fusion-zz-retire-done-plans](monorepo-fusion-zz-retire-done-plans.md) | `task/monorepo-fusion-zz-retire-done-plans` | todo | Final ticket — deletes every plan. Execute last. |

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

Tickets 01–06 are strictly ordered and cannot be parallelised: the rename must land
before anything installs (pnpm rejects duplicate unscoped names), and relocation must
strictly precede absorption (read-tree refuses to overwrite existing index entries).

- **01 → 02 → 03 → 04** sequential.
- **05 → 06** sequential, both after 04.
- **07, 08** after 06. 07 before 08 (reformat, then measure the residual).
- **09, 10, 11** after 06; independent of each other by file scope.
- **12, 13, 14** touch only `docs/` and `.zellij/`; independent of 07–11.
- **zz** last, after every other ticket completes.

A gate is a commit on `wayfinder/monorepo-fusion` with a green verify and an honest
map. Every wave boundary above is one.

## Agent kickoff prompt

> Read this repository's agent instructions, the wayfinder workflow, and the campaign
> map at `docs/wayfinder/wayfinder-monorepo-fusion.md`. Inspect live git and worktree
> state rather than trusting any summary.
>
> Before choosing anything, repair stale rows: for each task marked in progress, check
> whether a run is really behind it — a live worktree, a branch pushed within that run's
> lifetime, an open pull request. Leave the ones that have one. For the rest, read the
> branch and rewrite the status: to stopped-by-usage-window where work is in hand, and
> to never-started where there is nothing worth resuming.
>
> Then execute the next unblocked active task by running the task workflow against its
> plan, with `wayfinder/monorepo-fusion` as the base branch, and retarget the resulting
> pull request to that same branch. A task is eligible when it was never started, was
> deliberately paused, was stopped because a usage window ran out and that window has
> since reset, or is marked for redoing differently. Never re-execute a task a human
> rejected — report it and pick another. A task marked in progress belongs to a live run.
>
> The task numbered `zz` deletes this campaign's plan files. Execute it only once it is
> the last active task left; skip it while any other task is active, and never drop it
> from the map or treat it as already done.
>
> If you stop before the pull request is open, set the task's status to say why, with a
> short note, rather than leaving it marked in progress.
>
> This campaign's map records it as unattended, so type the wayfinder workflow's
> `--unattended` flag on the invocation you run. That routes the ticket through the
> merge-through runner, which resolves conflicts, waits for checks, retargets the pull
> request onto `wayfinder/monorepo-fusion`, and merges it there. Do not stop at the open
> pull request — carry the ticket through to merged, never leave it targeting the
> repository default branch, and include the merge in what you report back.

## Completed

<!-- newest first; one entry appended per task completion -->
