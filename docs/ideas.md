---
type: reference
title: Ideas ledger (tier 2)
description: The committed fallback ledger of proposed features and commands for this repo, used when the device-wide claude-proxy ideas store is absent.
tags: [ideas, advice, process]
timestamp: 2026-08-05
dirty: true
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

1. **`<logDir>/ideas.json`** in claude-proxy, through `pnpm --filter server ideas`. Device-wide,
   shared across every repo on the machine.
2. **This file.** Committed markdown, so the ledger survives a machine without claude-proxy and is
   reviewable in a PR.
3. **`~/.claude/ideas/<repo-slug>.md`** — device-local, same shape as this file.

Three rules keep a waterfall safe for something used as a dedupe key:

- **Write to the highest available tier, and name the tier used.** A silently-different tier between
  two runs is how a rejected idea comes back.
- **Dedupe reads every tier that exists, not just the winning one.** A machine that gains
  claude-proxy later must not forget what this file already recorded.
- **Fall through on absence only, never on error.** An unset `CLAUDE_PROXY_STORE`, a missing store,
  a checkout with no `server/package.json`, or an `ideas` CLI that is not installed all mean tier 1
  is *absent*. A tier-1 store that exists and fails to read is a **stop** — writing here behind a
  broken tier 1 forks one ledger into two that each look complete.

## The contract on these rows

- **The slug is the dedupe key** and is stable. Never propose a slug already present in any tier in
  any status — **including `rejected`**. A rejected idea returning on every run is the specific
  failure this key prevents, and the rejection reason is the most valuable row in the file.
- **Rejected rows are never deleted.** They are the record of what was already considered and turned
  down. A ledger holding only the accepted ideas cannot dedupe.
- **`shipped` is set by whoever landed the PR**, with the url. An idea whose PR did not land stays
  `accepted` and comes back next run.
- **Statuses** are `proposed` → `accepted` / `rejected`, and `accepted` → `shipped`.

## Ledger

One row per idea. `Evidence` cites the file paths behind it, or `bucket/id` for a judge note.

| Slug | Title | Repo | Status | Date | Evidence | Note |
| ---- | ----- | ---- | ------ | ---- | -------- | ---- |
| _(none yet)_ | | | | | | |

## Related

- [Session suggestions](features/session-suggestions.md) — the other evidence standard.
- [Ideas ledger](features/ideas-ledger.md) — the tier-1 store and its CLI.
