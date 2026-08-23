---
type: adr
title: The merged ADR record replaces both sources rather than joining them
description: Merging sixteen paired records into eight yields 38 inherited records, not 46; the originals persist as git history and provenance.
tags: [docs, process, adr, corpus]
timestamp: 2026-08-23
scope: all
decided-by: /dev
ratified: false
wayfinder: monorepo-fusion
grill-round: 3
needs-human: true
---

# The merged ADR record replaces both sources rather than joining them

## Status

Proposed by `/dev` during the `monorepo-fusion` campaign. **A human has not ratified
this decision.** Flagged because it **corrects an arithmetic error in the campaign
brief** and consequently **renumbers every new record the brief named by number**.

## Context

The brief said to merge "46 ADRs into a flat `docs/adrs/` renumbered 0001-0046", to
give the eight decisions codex and ox both hold "ONE merged record each", and never to
delete a superseded ADR. The griller showed those cannot all hold:

> "Is the merged-pair record a *replacement* for both originals (38 files, new records
> at 0039-0043, legacy-map many-to-one), or an *additional* record that supersedes two
> retained originals (54 files, new records at 0055+), and which of those two numbers
> replaces the '46 renumbered records' in DONE?"

46 is a count of ADR **files** across three repositories. It is not the count of
records the merge rule produces. The eight shared decisions are codex `0001`–`0008`
and ox `0001`–`0008`, pairwise by slug. Merging them consumes 16 source records and
emits 8, leaving claude's 17 + codex's 8 + ox's 5 = **38**.

## Decision

**Replacement. 38 inherited records, numbered 0001–0038.**

Three reasons, the first of which is that the source corpus already decided it:

1. **ox ADR 0010 settles it.** It requires each inherited decision be restated under
   new numbering with a Provenance section, and states that "codex-proxy's documents
   remain the historical record where they live." After fusion, **where they live is
   this repository's own git history** — which is why both siblings are absorbed with
   `filter-repo` and `--allow-unrelated-histories` rather than copied in. The originals
   do persist. They persist as history, in the form 0010 already blessed.
2. **Retention is the failure ox 0010 was written to prevent.** Keeping all 16
   originals plus 8 merged records states each of eight decisions three times in one
   flat corpus. 0010's stated Context is that an imported corpus "would contradict
   itself on day one."
3. **"Never delete a superseded ADR" does not apply and stays intact.** Supersession is
   a relation between a later decision and an earlier one it replaces. A merged pair is
   neither — it is one decision two repositories recorded separately, restated once
   with provenance. The rule is preserved verbatim and has no subject here. **That
   distinction is written into the docs so the next reader does not collide the two.**

**Ordering.** The merged record takes the **earlier** of the pair's two timestamps: the
decision was made then, and the second repository restated it. **Ties break on the
existing ADR number within the source repository.** This is required, not cosmetic —
claude's 17 are all July 2026, codex's 16 are *all* `2026-08-19`, and ox's 13 are *all*
`2026-08-22`, so 29 of 38 records have a tied sort key and the numbering is otherwise
not reproducible against a re-run.

**Renumbering.** The brief's new-record numbers were computed from the bad 46. Titles
are load-bearing; numbers move:

| brief | actual | title |
|---|---|---|
| 0047 | **0039** | Fuse the three proxy repos into one monorepo |
| 0048 | **0040** | Three providers and three harnesses, paired but not fused |
| 0049 | **0041** | A site-wide provider picker drives the navigation |
| 0050 | **0042** | claude-proxy's dashboard is the design baseline |
| 0051 | **0043** | Campaign state lives in the repo |

The six pre-ratified decisions take 0044–0049, and the seven decisions this `/dev` run
made take 0050–0056. **56 records total: 38 inherited, 18 new.**

## Consequences

- `legacy-map.md` is **many-to-one by design** — `codex#0005` and `ox#0005` both resolve
  to one target — and its header says so.
- ADR 0039's Supersedes field points at the **merged records** that `codex/ox#0005` and
  `#0006` became, and names the originals through the legacy map. Pointing at
  `codex#0005` directly would reference a number that no longer identifies anything.
- The done criterion "docs/adrs holds 46 renumbered records" is replaced by "38
  renumbered records plus 0039–0056".
- Because claude's block sorts first and its numbers are already dense, **all 17 claude
  records keep their existing numbers**, which is why "claude 0001 keeps 0001" appeared
  to hold.

## Provenance

Extends ox-alpha-proxy ADR 0010 (`0010-adapted-corpus-renumbering.md`) from a two-repo
case to a three-repo one. The `scope` field this campaign adds is what dissolves 0010's
stated objection: a five-rung ladder scoped to codex and a four-rung ladder scoped to
ox-alpha are two scoped decisions, not a contradiction. 0010's **rule** survives; its
**rationale** is superseded.
