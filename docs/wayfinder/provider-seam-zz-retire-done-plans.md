# provider-seam-zz — Retire this campaign's plans

**Wayfinder:** `provider-seam`
**Branch:** `task/provider-seam-zz-retire-done-plans`
**Status:** active

**Execute this last, after every other ticket has completed.** Running it early deletes the
plans of tickets still to come.

This ticket is the **only** thing that ever removes this campaign's plan files. Every other
plan is deliberately kept and marked done for the campaign's whole life, so skipping this
leaves the scaffolding in the repository permanently — a directory of done plans belonging
to a campaign that ended, owned by nobody.

## Criteria

1. **Delete every `docs/wayfinder/provider-seam-*.md` plan file, this one included.**

2. **Do not delete `docs/wayfinder/wayfinder-provider-seam.md`** — the map is retired by the
   close operation, not by this ticket.

3. **Do not touch any other campaign's files.** `docs/wayfinder/` also holds the
   `monorepo-fusion` campaign's map and plans, which are **deliberately still live**: that
   campaign landed incomplete with its ticket 09 `paused`, and its plans are the only
   artifact ticket 09 can be restarted from. See
   [ADR 0059](../adrs/0059-land-the-fusion-campaign-incomplete.md). Deleting them would turn
   a deliberate pause into a permanent loss. Match on the `provider-seam-` prefix
   specifically.

4. **Regenerate the docs index**, and leave the docs gate green — a deleted file still
   linked from an index is a broken link the gate will catch.

5. `my-command-tools verify` green.
