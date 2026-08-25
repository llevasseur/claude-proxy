---
type: adr
title: Inherited ratification flags survive the merge unchanged
description: A needs-human flag records that a human still owes a call; merging three corpora may not clear one.
tags: [docs, process, adr, governance]
timestamp: 2026-08-23
scope: all
decided-by: /dev
ratified: false
wayfinder: monorepo-fusion
grill-round: 3
needs-human: true
---

# Inherited ratification flags survive the merge unchanged

## Status

Proposed by `/dev` during the `monorepo-fusion` campaign. **A human has not ratified
this decision.** It is flagged because it **overrides an explicit instruction in the
campaign brief**, and because what it protects is the record of decisions a human was
asked to make and has not yet made.

## Context

The brief instructed: "Adopt codex/ox's ratification fields repo-wide; backfill
claude's 17 as `ratified: true`." It also asserted as a done criterion that the
campaign "carries no needs-human records, because all eight decisions above are
ratified."

Both statements collide with what the three corpora actually hold. Measured:

| repo | `needs-human: true` | `ratified: false` |
|---|---|---|
| claude-proxy | 11 (ADRs 0007–0017) | 11 |
| codex-proxy | 13 | 15 |
| ox-alpha-proxy | 7 | 13 |
| **total** | **31** | **39** |

Backfilling claude's 17 as ratified would silently ratify **eleven decisions a prior
`/dev` run explicitly flagged for a human**, through a bookkeeping instruction. That is
precisely the failure `/dev` exists to prevent, arriving through `/dev`'s own
housekeeping. And importing 46 records brings 20 more inherited flags from codex and
ox, which the done criterion as worded reads as a failure.

## Decision

**Inherited flags survive verbatim. No `needs-human` or `ratified` value is changed by
this campaign on any record it did not write.**

- Clearing a flag would destroy the record that a human still owes that call.
- Ratifying one would re-decide a decision this campaign explicitly places out of
  scope.
- **The backfill applies only to claude's 6 records that are not flagged.** The other
  11 keep both `ratified: false` and `needs-human: true`.

**The done criterion is restated so a correct run can satisfy it:**

> This campaign **creates** no `needs-human` records. Every inherited flag keeps its value,
> and a non-zero count from `rg -l 'needs-human:\s*true' docs/adrs/` is the **expected result
> of a correct run**, not a failure.

**The count is 33, not the 31 this record first stated.** That figure was written before the
corpus merge and counted the three source repositories' files: 11 claude + 13 codex + 7 ox.
Ticket 12 then merged 16 paired records into 8, and this campaign wrote records of its own —
so the number after the merge is **29 inherited + 4 from this campaign = 33**, measured on the
base. **Do not quote a fixed number here.** A campaign that merges records changes the count
by construction, and an ADR asserting a specific figure invites a later reader to "fix" the
corpus until it matches. The invariant is that no flag is cleared, not that a total holds.

An unqualified criterion that a correct execution fails is worse than no criterion,
because the next agent to check it will try to "fix" it by clearing flags — which is
the exact damage this record exists to prevent.

## Consequences

- The merged corpus carries 31 unratified decisions on day one. That is an honest
  report of the three repositories' actual governance state, not debt this campaign
  introduced.
- `okq --bundle docs find --where needs-human=true` remains the working query for what
  a human owes. Verified against okq 0.5.0: it matches arbitrary frontmatter keys, and
  an unset key returns no matches rather than erroring, as ADR 0003 established.
- Ratifying any of the 31 is a separate, deliberate act by a human, not a side effect
  of a merge.

## Provenance

Decided in this repository during `monorepo-fusion`, overriding the brief's backfill
instruction. Related: the merged-corpus numbering decision recorded alongside it.
