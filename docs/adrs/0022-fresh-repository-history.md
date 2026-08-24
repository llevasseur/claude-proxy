---
type: adr
title: Start with fresh repository history
description: Begin each sibling repository at its own initial commit and inherit decisions through adapted republication, never through imported history.
tags: [repository, migration, process]
timestamp: 2026-08-19
scope: all
provenance:
  - repo: codex-proxy
    number: "0005"
    file: docs/adrs/0005-fresh-repository-history.md
  - repo: ox-alpha-proxy
    number: "0005"
    file: docs/adrs/0005-fresh-repository-history.md
decided-by: /dev
ratified: false
needs-human: true
---

# Start with fresh repository history

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

> "Should the new repository start as a fresh repository containing only Bike and its
> roadmap, or preserve the source repository's Git history and remove post-Bike code?"

Each new repository changes protocol, product staging, and privacy defaults. Rewriting
the source history would obscure which code was actually adapted, and would retain
unrelated product evolution.

## Decision

Start at one fresh initial commit on the default branch. Add only Bike, its delivery
roadmap, and the records that explain intentional adaptation from the source repository.

**Inherit decisions through adapted republication (ADR 0029), never through imported git
history or copied source files.**

## Consequences

- History describes the repository's own decisions and increments.
- Provenance lives in citation sections rather than in shared history.
- Source attribution and pinned reference commits remain in durable docs.
- Useful code and styles may be adapted deliberately without importing unrelated commits.
- Each repository speaks as itself from its first commit.

## Provenance

**One decision, recorded separately by two repositories, restated here once.** Merged
from `codex-proxy` `docs/adrs/0005-fresh-repository-history.md` (`codex#0005`) and
`ox-alpha-proxy` `docs/adrs/0005-fresh-repository-history.md` (`ox-alpha#0005`) during the
`monorepo-fusion` campaign, under ADR 0053. It carries codex's earlier `2026-08-19`
timestamp; ox-alpha-proxy restated it on `2026-08-22`, citing the codex record.

**Governs the `codex` and `ox-alpha` stacks.** Each applied the rule to its own upstream:
codex-proxy started fresh rather than inheriting claude-proxy's history, and
ox-alpha-proxy started fresh rather than inheriting codex-proxy's.

**This pair is the one the legacy map exists to disambiguate.** `codex#0005` and
`ox-alpha#0005` both resolve to this single record — the clearest case of the map being
many-to-one by design.

**There is an irony worth stating rather than hiding.** This record decided *against*
importing sibling history, and the `monorepo-fusion` campaign then absorbed both siblings
with their full histories. The two do not conflict: this decision governed how each
repository *began*, when adapted republication was the only honest way to inherit a
corpus it did not share commits with. Fusion is the later, deliberate act of joining
them, and it is what makes the originals referenced throughout this bundle reachable as
history at all.

**This record replaces both originals rather than superseding them.** Both persist in
this repository's own git history, the form ADR 0029 blessed. See
[the legacy map](legacy-map.md) for why a merge is not a supersession.
