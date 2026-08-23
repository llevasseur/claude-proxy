---
type: reference
title: Ideas ledger (tier 2)
description: The committed fallback ledger of proposed features and commands for this repo, used when the hosted claude-proxy ideas store is absent.
tags: [ideas, advice, process]
timestamp: 2026-08-05
---

# Ideas ledger (tier 2)

Proposals for features or commands worth building in **this repo**, and what a human decided about
each one. `/ideate` writes here; `/improve` reads the `accepted` rows.

## What this file is for

An idea is **invented**. Unlike a [session suggestion](features/session-suggestions.md), no rule
counted it and no transcript supports it, so it carries none of a suggestion's evidence. Two things
substitute for that, and both are required:

1. **Cited evidence authored by a person** — an `## Open questions` entry, a judge's enrichment note
   on a confirmed suggestion, a CHANGELOG entry, or an explicit `Out of scope` / `Non-goals` /
   `Deferred` / `Future work` statement. Every entry below names at least one, with paths. An idea
   citing none of these does not get written down.
2. **A recorded human sign-off** — the `accepted` status. That sign-off *is* an accepted idea's
   trace, which is why `/improve` may act on an `accepted` row and never on a `proposed` or
   `rejected` one.

## Why there are three tiers

The ledger resolves to the highest available store, and this file is the middle one:

1. **The hosted ledger**, through `pnpm --filter @agent-proxy/claude-server ideas` in claude-proxy. It was
   `<logDir>/ideas.json` and is now an append-only event log on the `operator` Worker's D1 database
   ([ADR 0006](adrs/0006-host-the-ideas-ledger.md)), so it is shared across every repo *and* every
   machine rather than being device-wide. The CLI is the same; only what answers it changed.
   **There is no local fallback**: a device without `IDEAS_URL`/`IDEAS_TOKEN` refuses every read and
   every write rather than quietly answering from a file, because a second complete-looking ledger
   is the exact failure hosting was meant to end.
2. **This file.** Committed markdown, so the ledger survives a machine without claude-proxy and is
   reviewable in a PR.
3. **`~/.claude/ideas/<repo-slug>.md`** — device-local, same shape as this file.

Three rules keep a waterfall safe for something used as a dedupe key:

- **Write to the highest available tier, and name the tier used.** A silently-different tier between
  two runs is how a rejected idea comes back.
- **Dedupe reads every tier that exists, not just the winning one.** A machine that gains
  claude-proxy later must not forget what this file already recorded.
- **Fall through on absence only, never on error.** An unset `CLAUDE_PROXY_STORE`, a checkout with
  no `server/package.json`, or an `ideas` CLI that is not installed all mean tier 1 is *absent*. A
  tier-1 store that exists and fails to read is a **stop** — writing here behind a broken tier 1
  forks one ledger into two that each look complete. **Hosting adds a case the original three did
  not cover**, and which tier-1 refusal it is has not been settled by anything in this repo: a
  device with the CLI installed but no `IDEAS_URL`/`IDEAS_TOKEN` now refuses rather than reading an
  empty file, and that refusal names the two variables. Read it as a stop until the resolving
  command says otherwise — the command doing the resolving lives outside this repo.

## The contract on these rows

- **The slug is the dedupe key** and is stable. Never propose a slug already present in any tier in
  any status — **including `rejected`**. A rejected idea returning on every run is the specific
  failure this key prevents, and the rejection reason is the most valuable row in the file.
- **Rejected rows are never deleted.** They are the record of what was already considered and turned
  down. A ledger holding only the accepted ideas cannot dedupe.
- **`shipped` carries the url of the PR that landed it.** On tier 1 nobody has to remember to set
  it: `ideas sync` reads the PR the claim recorded and moves the entry, and a PR closed unmerged or
  whose branch is gone releases the idea back to `accepted` instead. On this file it is still set by
  hand by whoever landed the PR. An idea whose PR did not land stays `accepted` and comes back next
  run.
- **Statuses** are `proposed` → `accepted` / `rejected`, `accepted` → `claimed` while a run is
  building it, and `claimed` → `shipped`. `claimed` is a tier-1 state: it carries a holder and a
  six-hour lease so two runs cannot build one idea, and this file has no mechanism for it.

## Ledger

One row per idea. `Evidence` cites the file paths behind it, or `bucket/id` for a judge note.

| Slug | Title | Repo | Status | Date | Evidence | Note |
| ---- | ----- | ---- | ------ | ---- | -------- | ---- |
| _(none yet)_ | | | | | | |

## Related

- [Session suggestions](features/session-suggestions.md) — the other evidence standard.
- [Ideas ledger](features/ideas-ledger.md) — the tier-1 store and its CLI.
