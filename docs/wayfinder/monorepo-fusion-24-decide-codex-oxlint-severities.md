# monorepo-fusion-24 — Decide, and record, whether codex is on a warn tier

**Wayfinder:** `monorepo-fusion`
**Branch:** `task/monorepo-fusion-24-decide-codex-oxlint-severities`
**Status:** active

## Why this ticket exists

**codex is on an anti-slop warn tier that no decision record covers.**
`stacks/codex/.oxlintrc.json` restates all 15 anti-slop rules at `warn` where the root sets
`error`. ADR 0051 designs a warn tier for **ox alone**, with an explicit ratchet, a named
rule list, a starting count, and an expiry at the end of campaign 3. codex has none of that
— it simply has the severities, arrived at during ticket 05 and never recorded as a choice.

The campaign has been reasoning from the opposite premise ever since. Ticket 05 reported
that codex's config "extends the root and restates its severities", which was read as
restoring root severity; ticket 21's dispatch told it outright that "codex is not under a
warn tier", and ticket 21 measured that this is false.

**A silent tier is the failure the ratchet exists to prevent.** ox's warn tier is safe
precisely because it is written down with a count and an end date. An undocumented one looks
identical to compliance and never shrinks, because nobody knows it is there to shrink.

## Criteria

1. **Measure codex at `error` first.** Point oxlint at `stacks/codex/` with the root
   severities and count the findings per rule. That number decides everything below, and
   nothing should be decided before it exists.
2. **Then take one of two paths, and record which:**
   - **If the count is small enough to clear now**, clear it and delete the `warn`
     restatements so codex sits at root severity. That is the better outcome: one fewer
     tier, and the campaign's stated position — that only ox needed staging — becomes true
     rather than assumed.
   - **If it is not**, keep the tier but make it legitimate: amend **ADR 0051** to cover
     codex explicitly, with the per-rule starting counts, the same ratchet (a rule returns
     to `error` at zero; every file a ticket touches passes at `error`), and the same expiry.
     Say plainly that this was discovered rather than designed.
3. **Re-check ticket 05's related claim.** Its report said codex's rules were at `warn`
   "where the root sets `error`" and that its config now restates them — the ambiguity
   between *restoring* root severity and *restating* a lower one is what propagated. Confirm
   what codex's config actually does now and correct the ticket 05 Completed entry if it
   reads wrong.
4. **Do not touch ox's tier.** It is designed, counted, and owned by ADR 0051 and ticket 08.

## Constraints

- Own `stacks/codex/.oxlintrc.json`, and codex source only if criterion 2 takes the
  clear-it-now path.
- **Zero behaviour change.** Lint severity is not behaviour; any source edit that changes
  what codex *does* is out of scope.

## Done when

The per-rule count at `error` is recorded, one of the two paths is taken and stated, ADR
0051 is amended if the tier survives, and `gh pr checks` is green.
