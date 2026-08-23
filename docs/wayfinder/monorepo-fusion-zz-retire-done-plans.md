# monorepo-fusion-zz — Retire the campaign's done plans

**Wayfinder:** `monorepo-fusion`
**Branch:** `task/monorepo-fusion-zz-retire-done-plans`
**Status:** active

## Goal

Delete every plan file this campaign created, including this one, and regenerate the
docs index.

**This ticket is critical work, not closing bookkeeping.** Every other plan is
deliberately kept and marked done for the campaign's whole life, so a task can always be
restarted from what was asked. This ticket is the **only** thing that ever removes any
of them. Skipped, the campaign's scaffolding stays in the repository permanently — a
directory of done plans belonging to a campaign that ended, owned by nobody, that every
later reader has to work out is dead.

`docs/wayfinder/` already carries exactly that residue from two earlier campaigns
(`map-proxy-skim.md`, `map-sqlite-substrate.md`, and `tickets/`), which is the live
demonstration of what skipping this ticket costs.

## Criteria

1. **Delete every `docs/wayfinder/monorepo-fusion-*.md` plan file**, this one included.
2. **Leave `docs/wayfinder/wayfinder-monorepo-fusion.md` alone.** The map is retired by
   the campaign's close operation, not by this ticket.
3. **Leave the earlier campaigns' residue alone.** `map-proxy-skim.md`,
   `map-sqlite-substrate.md`, `research-002-*`, `decision-004-*` and `tickets/` belong to
   campaigns that are not this one. Cleaning them up is somebody's job but not this
   ticket's, and deleting another campaign's records as a side effect is the same error
   this ticket exists to prevent.
4. **Regenerate the docs index** and confirm `okq --bundle docs validate` is conformant
   with the plans gone.

## Execution order

Execute this **last**, after every other ticket in the campaign has completed. Running it
early deletes the plans of tasks still to come. The campaign's close operation expects it
to have run and will not sweep the plans by hand.

## Done when

No `monorepo-fusion-*.md` plan file remains, the map is untouched, the earlier campaigns'
files are untouched, the docs index is regenerated, and `pnpm verify` is green.
