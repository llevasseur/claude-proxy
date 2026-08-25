---
type: adr
title: The package rename covers every non-import reference, gated by a grep
description: pnpm answers a filter matching nothing with a warning and exit 0, so every consumer of a package name outside an import specifier fails open.
tags: [monorepo, naming, tooling, verification]
timestamp: 2026-08-23
scope: all
decided-by: /dev
ratified: false
wayfinder: monorepo-fusion
grill-round: 5
needs-human: false
---

# The package rename covers every non-import reference, gated by a grep

## Status

Proposed by `/dev` during the `monorepo-fusion` campaign. A human has not ratified it.
Not flagged `needs-human`: it widens the scope of a rename the brief already ordered and
adds a check, rather than choosing between products.

## Context

The brief characterised the rename as "165 import sites, all mechanical, **all caught by
typecheck**." Import specifiers may be. The package name is not confined to them, and the
places it lives outside them are the places no gate looks. The griller asked:

> "Does the campaign treat the package rename as complete only when every non-import
> reference is migrated too — the launchd plist, the workflow's `--filter` argument, the
> runtime-printed operator commands, `AGENTS.md`, and the wayfinder maps — with an
> explicit sweep and its own evidence, or is the rename scoped to code and the rest
> deferred, in which case what stops the retention job from reporting green while doing
> nothing?"

Measured in claude-proxy alone, **before the rename**: **104** occurrences of the unscoped
`--filter server` and 26 of `--filter concepts`. Only 155 of the 184 rename sites across the three repos are
`.ts`/`.tsx`; the other 29 are markdown, JSON, YAML and shell, and typecheck sees none
of them.

The decisive one is not a document. `scripts/com.llevasseur.claude-proxy.maintain.plist`
invoked `pnpm --filter server maintain --apply` with `WorkingDirectory` set to the repo,
and **`launchctl list` confirms it is loaded on this device right now**, alongside
`com.llevasseur.claude-proxy`, both last exit 0.

The property that makes this a class rather than an incident: **pnpm answers a filter
matching nothing with a warning and exit 0.** The job keeps running, keeps reporting
success, and does nothing. Under the campaign's deletion decision, that job is what keeps
the corpus bounded.

## Decision

**The rename is complete only when every non-import reference is migrated. Nothing is
deferred.**

1. **A `verify` gate makes the class checkable rather than the sweep trusted.** After the
   rename, no `--filter` argument anywhere in the tree may name an unscoped package. It
   is a grep, it is cheap, and it catches documents, plists, workflows and
   runtime-printed strings under one rule — including files nobody thought to list.
   **This is the positive assertion the rename was missing**: absence of failure could
   never have proved anything against a tool that fails open.
2. **The launchd plists are updated and reloaded, and the evidence is work performed.**
   The ticket unloads, edits, reloads, triggers a run, and asserts the maintain job
   actually did something — a log line, a byte count, a row count. **Exit 0 is precisely
   the signal that cannot distinguish the two states and is not admissible here.**
3. **Runtime-printed operator commands stop being string literals.**
   `packages/core/src/ideas.ts:1307-1308` derives its invocation from the package-name
   constant so it cannot drift again. A printed command that lies to an operator is the
   same failure one indirection further out.
4. **`deploy-concepts.yml` needs both halves.** Blocker (f) covers the `paths` trigger and
   not the `pnpm --filter concepts` argument, so the fix as written repairs the trigger
   and leaves the job broken.
5. **`AGENTS.md` is the highest-leverage entry.** It is not documentation here; it is the
   instruction every future agent reads, including the recorded
   `pnpm --silent --filter @agent-proxy/claude-server suggestions list -r 9 --json` form that exists
   *because* getting it wrong was a repeated, logged failure. Leaving it stale re-arms a
   failure the repository already paid for.
6. **The sweep is a judgement ticket, not a mechanical one.** The unscoped `--filter server` named one
   package before the rename and names one of three after fusion, so every site *acquires* a stack it never
   needed. It therefore cannot be bundled into the mechanical rename ticket.

## Consequences

- The wayfinder maps under `docs/wayfinder/` are in scope: the campaign-state decision
  makes the map a control plane, and a control plane carrying wrong invocations
  mis-steers the next agent.
- One job is **already broken and out of reach of any repo ticket**:
  `~/Library/LaunchAgents/com.llevasseur.claude-proxy.plist` runs
  `/Users/llevasseur/Documents/ghub/claude-proxy/proxy/**proxy.mjs**`, a file that does
  not exist — the repo has `proxy/proxy.ts`. Its plist is not tracked in git, so no
  ticket would have found it. It is recorded here rather than fixed, because a device
  configuration outside the repository is the human's to change.

## Provenance

Decided in this repository during `monorepo-fusion`. No prior record addresses package
names outside import specifiers.
