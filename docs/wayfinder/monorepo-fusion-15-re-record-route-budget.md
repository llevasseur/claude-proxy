# monorepo-fusion-15 — Re-record the route time and size budget

**Wayfinder:** `monorepo-fusion`
**Branch:** `task/monorepo-fusion-15-re-record-route-budget`
**Status:** active

## Why this ticket exists

Ticket 01 found `pnpm verify` **red on the untouched base**:
`server/test/route-budget-gate.test.ts` failed on `/api/commands` at a **433ms median
against a 390ms allowance**, reproducing on the base without ticket 01's changes.

**Ticket 03 then measured the same gate as passing.** At `12ee731`, before any edit, all
six gates were green and the `/api/commands` failure did not reproduce. So the failure is
**intermittent and data-dependent**, not a stable stale budget: the gate reads recorded
observations out of the symlinked shared `logs/` store, whose contents change between
runs.

**That changes what this ticket is for.** A budget that fails on one run and passes on the
next is not fixed by re-recording it — re-recording makes the next run pass and tells you
nothing about the run after that. The defect is that the gate's verdict depends on data
outside the commit, which makes it unable to distinguish a real regression from a busy
machine. Read criterion 1 as the ticket's actual first question rather than a formality.

This is not one ticket's problem. **Every other ticket in this campaign has "`pnpm
verify` is green" in its done-condition**, so an unfixed pre-existing failure is
inherited by all of them, and the campaign's own DONE criterion — "`pnpm verify`
passes" — could never be satisfied. A gate that is red for reasons no ticket caused also
trains every later runner to read red as normal, which is how a real regression gets
waved through.

## Criteria

1. **Establish whether the gate is flaky or the budget is stale, and do not skip to
   re-recording.** Run it repeatedly on an unmodified base — ten runs, not one — and
   record how many fail and at what medians. Two prior runs disagree (ticket 01 red at
   433ms, ticket 03 green), so a single run answers nothing.
   - **If it fails intermittently**, the fix is to make the verdict independent of the
     shared store — pin the observation set the gate reads, or seed it from a fixture —
     **not** to widen the allowance. A gate whose result depends on data outside the
     commit cannot tell a regression from a busy machine, and widening it just moves the
     coin-flip.
   - **If it fails consistently**, re-record per criterion 2.
   - **If it passes consistently across all ten**, close this ticket as not needed and say
     so. That is a legitimate outcome, and manufacturing a change to justify the ticket
     is worse than closing it.
2. **If and only if re-recording is warranted, re-record from real served traffic**, the
   way the existing recording path already does. Do not hand-edit the allowance to sit
   just above the observed median: the budget is a measurement, and widening it by hand
   to make a gate pass is the failure the gate exists to catch.
3. **Carry unexercised routes unchanged.** The recorder already does this; confirm the
   diff touches only the routes that were actually observed.
4. **Report the before and after numbers per changed route** in the PR body, so a
   reviewer can see which allowances moved and by how much. A budget re-record with no
   numbers in it is indistinguishable from a gate being switched off.

## Ordering

**Run this after ticket 09 (`migrate-corpora`), not before.** The gate reads recorded
observations out of the shared `logs/` store, and ticket 09 physically moves that store
to `stacks/<name>/logs/`. Re-recording first would measure against a corpus that is about
to move, and the numbers would have to be taken again.

## Constraints

- This ticket edits `server/` and owns that lane while it runs.
- **Zero behaviour change** still holds: re-recording a measurement is not a behaviour
  change, but altering what a route *does* to make it faster is out of scope for this
  campaign and belongs to a later one.

## Done when

`pnpm verify` is green on the campaign base, the re-recorded budget is committed, and the
PR body carries the before/after allowance for every route whose number moved.
