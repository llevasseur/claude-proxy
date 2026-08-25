---
type: note
title: Legacy ADR identifier map
description: Resolves every pre-fusion ADR identifier from claude-proxy, codex-proxy, and ox-alpha-proxy to its number in this flat corpus. Many-to-one by design.
tags: [docs, adr, corpus, provenance, monorepo]
timestamp: 2026-08-23
scope: all
---

# Legacy ADR identifier map

**This map is many-to-one by design.** `codex#0005` and `ox-alpha#0005` both resolve to
**0022**, and seven other pairs resolve the same way. That is not a collision to repair —
it is the merge rule working. Eight decisions were recorded separately by codex-proxy and
ox-alpha-proxy, and each is restated here **once**, so two old identifiers legitimately
name one new record.

Read a row as "wherever you saw this identifier, read this record instead."

## A merged pair is not a supersession, and the rule against deleting a superseded ADR is untouched

This is the one thing a reader is most likely to get wrong, so it is stated outright
rather than left to inference.

**"Never delete a superseded ADR" governs *supersession*.** Supersession is a relation
between two decisions: a later one that replaces an earlier one it disagrees with. The
earlier record is kept because the disagreement is the history — you have to be able to
read what was decided first and why it stopped being true.

**A merged pair is neither of those things.** `codex#0007` and `ox-alpha#0007` are not an
earlier decision and a later one that replaced it. They are **one decision that two
repositories each wrote down**, in the same words, for the same reason. Merging them
states it once. Nothing is replaced, nothing is disagreed with, and there is no
disagreement to preserve.

**So the rule is preserved verbatim and simply has no subject here.** It was not weakened,
scoped down, or carved out for this campaign. It still binds every real supersession in
this bundle, exactly as written in
[0001 — Record architecture decisions](0001-record-architecture-decisions.md). It just
does not describe what this merge did.

**What did happen to the originals: they persist as git history.** ox-alpha-proxy's own
renumbering record required that an inherited decision be restated under new numbering
with a Provenance section, and said the source repository's documents "remain the
historical record where they live." After fusion, **where they live is this repository's
own git history** — both siblings were absorbed with their histories rather than copied
in. Every original is reachable at its original path and its original commit. That is the
form [ADR 0029](0029-adapted-corpus-renumbering.md) blessed, and it is why retaining 16
duplicate files alongside 8 merged ones would have been the failure that record was
written to prevent, not compliance with it.

## How the numbering was derived

Reproducible against a re-run, which is the point — the sort key alone is not enough,
because **29 of the 38 records are tied on it**. claude's 17 are all July–August 2026,
codex's 16 are *all* `2026-08-19`, and ox-alpha's 13 are *all* `2026-08-22`.

Records are ordered by, in strict priority:

1. **Timestamp**, ascending. A merged pair takes the **earlier** of its two timestamps —
   the decision was made then, and the second repository restated it. All eight pairs
   therefore sort at codex's `2026-08-19`.
2. **The existing ADR number within the source repository**, ascending. This is the
   required tiebreak, not a cosmetic one.
3. **Source repository**, in the order `claude-proxy`, `codex-proxy`, `ox-alpha-proxy`.
   This resolves the residual tie where two repositories hold the same number on the same
   date — `codex#0009` and `ox-alpha#0009` are both `2026-08-22` — and it is the only
   place repository order is consulted.

The consequence worth naming: **claude's block sorts first and its numbering was already
dense, so all 17 claude records keep the numbers they had.** That is a result of the rule,
not an exception carved out for them.

## Frontmatter conventions this corpus adds

- **`scope`** is one of `claude`, `codex`, `ox-alpha`, or `all`, and it is what makes a
  flat corpus honest. Without it, [0021](0021-outcome-ladder.md)'s five-rung ladder for
  codex and four-rung ladder for ox-alpha read as a contradiction; with it they are two
  scoped instantiations of one decision. A merged pair carries `all`, and its Provenance
  section names the stacks it actually governs and any per-stack variant — so the field
  stays inside its four permitted values while the record itself carries the detail.
- **`provenance`** is a list of `{repo, number, file}` entries, one per source record. It
  is a list even for a single-source record, so that the merged pairs — which have two —
  are not a different shape to query.
- **Ratification fields were never changed by this merge** ([ADR 0052](0052-inherited-ratification-flags-survive-the-merge.md)).
  Where a merged pair's two sources disagreed, the merged record takes the **union**:
  the `needs-human` flag is set if *either* source carried it. A merge can therefore add no flag it
  did not inherit, and can clear none. An absent flag stays absent rather than being
  written out as `false`.
- **The backfill reached 6 records only** — claude's `0001`–`0006`, which carried no
  ratification fields at all. claude's `0007`–`0017` keep `ratified: false` and
  their `needs-human` flag set, because blanket-ratifying the block would have silently ratified
  eleven decisions a prior run flagged for a human.

## claude-proxy — 17 records, all numbers unchanged

| Legacy | Resolves to |
|---|---|
| `claude#0001` | [0001](0001-record-architecture-decisions.md) |
| `claude#0002` | [0002](0002-monorepo-with-pnpm-tanstack-and-node.md) |
| `claude#0003` | [0003](0003-allow-narrowly-scoped-writes-in-the-local-server.md) |
| `claude#0004` | [0004](0004-adopt-sqlite-as-the-query-substrate.md) |
| `claude#0005` | [0005](0005-host-the-concept-store.md) |
| `claude#0006` | [0006](0006-host-the-ideas-ledger.md) |
| `claude#0007` | [0007](0007-preserve-concurrent-note-edits.md) |
| `claude#0008` | [0008](0008-archive-notes-instead-of-deleting.md) |
| `claude#0009` | [0009](0009-autosave-notes-without-losing-drafts.md) |
| `claude#0010` | [0010](0010-use-markdown-for-note-content.md) |
| `claude#0011` | [0011](0011-search-notes-in-the-first-release.md) |
| `claude#0012` | [0012](0012-keep-operator-credentials-out-of-the-browser.md) |
| `claude#0013` | [0013](0013-preserve-note-selection-during-live-updates.md) |
| `claude#0014` | [0014](0014-paginate-note-lists-with-stable-cursors.md) |
| `claude#0015` | [0015](0015-order-notes-strictly-by-recent-edit.md) |
| `claude#0016` | [0016](0016-return-note-excerpts-from-discovery-operations.md) |
| `claude#0017` | [0017](0017-allow-blank-note-titles.md) |

## codex-proxy — 16 records

`0001`–`0008` are the merged half of a pair; each shares its target with the
ox-alpha-proxy row of the same number.

| Legacy | Resolves to | |
|---|---|---|
| `codex#0001` | [0018](0018-use-responses-contract.md) | merged with `ox-alpha#0001` |
| `codex#0002` | [0019](0019-sanitized-audit-sidecars.md) | merged with `ox-alpha#0002` |
| `codex#0003` | [0020](0020-unavailable-incomplete-cost.md) | merged with `ox-alpha#0003` |
| `codex#0004` | [0021](0021-outcome-ladder.md) | merged with `ox-alpha#0004` |
| `codex#0005` | [0022](0022-fresh-repository-history.md) | merged with `ox-alpha#0005` |
| `codex#0006` | [0023](0023-private-github-publication.md) | merged with `ox-alpha#0006` |
| `codex#0007` | [0024](0024-transparent-http-surface.md) | merged with `ox-alpha#0007` |
| `codex#0008` | [0025](0025-pin-plane-parity.md) | merged with `ox-alpha#0008` |
| `codex#0009` | [0026](0026-daily-trend-granularity.md) | |
| `codex#0010` | [0028](0028-rebuild-view-on-schema-mismatch.md) | |
| `codex#0011` | [0030](0030-calendar-date-range-api.md) | |
| `codex#0012` | [0032](0032-sse-data-version-signal.md) | |
| `codex#0013` | [0034](0034-car-dashboard-routes.md) | |
| `codex#0014` | [0036](0036-model-filter-semantics.md) | |
| `codex#0015` | [0037](0037-history-record-listing.md) | |
| `codex#0016` | [0038](0038-retroactive-catalogue-pricing.md) | |

## ox-alpha-proxy — 13 records

| Legacy | Resolves to | |
|---|---|---|
| `ox-alpha#0001` | [0018](0018-use-responses-contract.md) | merged with `codex#0001` |
| `ox-alpha#0002` | [0019](0019-sanitized-audit-sidecars.md) | merged with `codex#0002` |
| `ox-alpha#0003` | [0020](0020-unavailable-incomplete-cost.md) | merged with `codex#0003` |
| `ox-alpha#0004` | [0021](0021-outcome-ladder.md) | merged with `codex#0004` |
| `ox-alpha#0005` | [0022](0022-fresh-repository-history.md) | merged with `codex#0005` |
| `ox-alpha#0006` | [0023](0023-private-github-publication.md) | merged with `codex#0006` |
| `ox-alpha#0007` | [0024](0024-transparent-http-surface.md) | merged with `codex#0007` |
| `ox-alpha#0008` | [0025](0025-pin-plane-parity.md) | merged with `codex#0008` |
| `ox-alpha#0009` | [0027](0027-one-campaign-review-granularity.md) | |
| `ox-alpha#0010` | [0029](0029-adapted-corpus-renumbering.md) | the renumbering rule this merge follows |
| `ox-alpha#0011` | [0031](0031-automated-boundary-evidence.md) | |
| `ox-alpha#0012` | [0033](0033-meter-chat-completions-usage.md) | |
| `ox-alpha#0013` | [0035](0035-fable-standin-rates-for-ox-alpha.md) | |

## The arithmetic

46 counts ADR **files** across the three repositories — 17 + 16 + 13. It was never the
count of records the merge rule produces. The eight shared decisions consume 16 source
records and emit 8:

| | |
|---|---|
| claude-proxy, all kept | 17 |
| codex/ox-alpha shared decisions, merged 16 → 8 | 8 |
| codex-proxy only | 8 |
| ox-alpha-proxy only | 5 |
| **inherited records in this corpus** | **38** |

Numbered `0001`–`0038`. The campaign's own records, written during `monorepo-fusion`,
sit above them and are cited by number from the campaign map and from each other, so they
were not renumbered or folded into this merge.
