# monorepo-fusion-15 — Re-record the route time and size budget

**Wayfinder:** `monorepo-fusion`
**Branch:** `task/monorepo-fusion-15-re-record-route-budget`
**Status:** active

## Why this ticket exists

Ticket 01 found `pnpm verify` **already red on the untouched base**:
`server/test/route-budget-gate.test.ts` fails on `/api/commands` at a **433ms median
against a 390ms allowance**. Ticket 01 added only documentation, and the same test fails
identically on the base without it.

This is not one ticket's problem. **Every other ticket in this campaign has "`pnpm
verify` is green" in its done-condition**, so an unfixed pre-existing failure is
inherited by all of them, and the campaign's own DONE criterion — "`pnpm verify`
passes" — could never be satisfied. A gate that is red for reasons no ticket caused also
trains every later runner to read red as normal, which is how a real regression gets
waved through.

## Criteria

1. **Confirm it is genuinely pre-existing, not campaign-caused.** Check out the campaign
   base's merge-base with `main` and run the gate there. If it passes at that commit, do
   **not** re-record — find what changed instead, because then it *is* a regression and
   re-recording would bury it.
2. **Re-record the budget from real served traffic**, the way the existing recording
   path already does. Do not hand-edit the allowance to sit just above the observed
   median: the budget is a measurement, and widening it by hand to make a gate pass is
   the failure the gate exists to catch.
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
