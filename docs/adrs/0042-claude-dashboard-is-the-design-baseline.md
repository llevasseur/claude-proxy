---
type: adr
title: claude-proxy's dashboard is the design baseline, and UI design is delegated to a Fable subagent
description: The fused dashboard adopts claude-proxy's design system wholesale, and visual design decisions are made by a Fable subagent rather than inline.
tags: [monorepo, dashboard, design, process, campaign]
timestamp: 2026-08-23
scope: all
provenance:
  - campaign: monorepo-fusion
    decided: before the campaign began, by the repository owner
    recorded-by: monorepo-fusion ticket 13
decided-by: user
ratified: true
wayfinder: monorepo-fusion
needs-human: false
---

# claude-proxy's dashboard is the design baseline, and UI design is delegated to a Fable subagent

## Status

Accepted. Decided by the repository owner before the `monorepo-fusion` campaign began.

## Context

Three dashboards arrive in one repository. They were built at different times against
different conventions: three sets of tokens, three component vocabularies, three ideas of
what a table row looks like. Merging them by averaging produces a fourth style that is
nobody's and that every existing page has to be rewritten into.

claude-proxy's dashboard is the most developed of the three. It carries a real token
system — the space, type and radius scales in `apps/admin/src/styles/tokens.css`, enforced
by the `no-bare-size` GritQL rule — a route registry, and the largest set of pages built
against them.

## Decision

**claude-proxy's dashboard is the design baseline.** Its tokens, its component vocabulary,
its route registry shape, and its layout conventions are the repository's, and the absorbed
dashboards are brought to them rather than blended with them. Where a codex or ox page has
a visual convention of its own, the baseline wins and the page is restyled.

**Visual design decisions are delegated to a Fable subagent rather than made inline.** A
UI change that is a design question — what a new page looks like, how a component should
read, which token a novel element wants — is handed to a subagent running the Fable model,
with the baseline as its brief. It is not decided in passing by whichever agent happened to
be implementing the surrounding feature.

The reason is what the failure looks like: design decided inline is design decided by
whoever was closest to it, one page at a time, and it produces a dashboard that is locally
reasonable everywhere and incoherent overall. Delegating puts the decision in one place
with one brief.

## Consequences

- Absorbed dashboard pages are restyled onto the baseline's tokens as they are migrated.
  This is visual change, and it is the one category of change the campaign's rejection rule
  permits, because the rule governs **runtime behaviour** rather than appearance.
- A size that no scale step fits gets a **named** token beside `--space-page`, rather than
  a bare px or a suppression — the existing rule, restated because the influx of absorbed
  CSS is exactly when it gets bypassed.
- The Fable delegation is a process commitment with a cost: a design question becomes a
  subagent dispatch rather than an edit, which is slower per change and is meant to be.
- Nothing here delegates *product* decisions. What a page shows and which data it reads
  stay with the implementing run; only how it looks is delegated.

## Provenance

Decided by the repository owner before the `monorepo-fusion` campaign started, and
recorded here by that campaign's ticket 13.
