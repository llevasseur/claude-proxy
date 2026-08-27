---
type: wayfinder-plan
title: "Internet Spend 06 — move the campaign's decision records into the ADR bundle"
description: The five decision-internet-spend records move from the ephemeral plans directory into docs/adrs, so they survive the campaign that made them.
tags: [wayfinder, docs, adrs]
timestamp: 2026-08-27
scope: all
campaign: internet-spend
number: "06"
---

# Internet Spend 06 — move the campaign's decision records into the ADR bundle

Branch: `task/internet-spend-06-relocate-decision-records`, cut from `wayfinder/internet-spend`.
Lane: `docs/adrs/**`, the five `docs/wayfinder/decision-internet-spend-*.md`
files, `docs/wayfinder/index.md`, `AGENTS.md`, `CHANGELOG.md`.

**Do not edit `docs/wayfinder/map-internet-spend.md`.** Another ticket's
completion is editing that file concurrently and a conflict there is avoidable.
The map's citation of these records is updated separately at campaign close.

Why this ticket exists: [ADR 0067](../adrs/0067-campaign-decisions-live-in-the-adr-bundle.md).
`docs/wayfinder/` is swept when the campaign closes, so five unratified decision
records — two of them carrying `needs-human: true` — are currently stored in the
one directory guaranteed to be deleted at the moment the code depending on them
lands.

## Criteria

1. **Move all five records** from `docs/wayfinder/` into `docs/adrs/`, numbered
   in sequence after the highest existing ADR number (0067 is taken by the
   record above, so these start at 0068). Preserve the campaign's own 001–005
   ordering when assigning numbers. The five are:
   - `decision-internet-spend-001-wire-bytes-and-per-interface-schema.md`
   - `decision-internet-spend-002-delta-gap-and-day-semantics.md`
   - `decision-internet-spend-003-period-boundaries.md`
   - `decision-internet-spend-004-agent-pattern-matching.md`
   - `decision-internet-spend-005-collector-residency.md`
2. **Bodies are preserved verbatim** — the prose, and in particular each
   record's verbatim griller question, is not rewritten, summarized, or
   re-argued. Only the frontmatter and the title heading change shape.
3. **Frontmatter converts to the ADR bundle's shape**, matching
   `docs/adrs/0065-cost-is-resolved-at-read-time.md` as the worked example:
   `type: decision` becomes `type: adr`; add `scope` (`net` for 001–005 unless a
   record clearly reaches wider, in which case `all`); add `tags`; drop the
   `label: wayfinder:decision` and `map: map-internet-spend` keys that bind them
   to a map that is about to be deleted. **Keep every `/dev` key exactly as it
   is**: `decided-by: /dev`, `ratified: false`, `wayfinder: internet-spend`,
   `grill-round: <n>`, and `needs-human: true` on 001 and 005. Losing those flags
   would erase the human's review list, which is the reason for the move.
4. **Repoint every inbound reference.** At minimum `AGENTS.md` links
   `docs/wayfinder/decision-internet-spend-005-collector-residency.md`. Search
   the repository for `decision-internet-spend` and fix every hit outside the map
   (which this ticket does not touch). `stacks/net` source comments citing a
   decision by number are in scope for the link, not for rewording.
5. **Both queries return all five afterwards**:
   `okq --bundle docs find --where ratified=false` and, for 001 and 005,
   `okq --bundle docs find --where needs-human=true`.
6. Regenerate the docs index; `pnpm check:docs` green — it asserts section
   indexes by file and that every concept outside the exempt sections carries
   `scope`, so a moved record missing `scope` fails there.
7. `my-command-tools verify` green, plus `pnpm anti:slop` run explicitly;
   `CHANGELOG.md` bullet prepended.

## Verification

Confirm `docs/wayfinder/` holds no `decision-*` file afterwards, that all five
resolve under `docs/adrs/`, and that no dead link remains — `okq --bundle docs
deadlinks` is the direct check.
