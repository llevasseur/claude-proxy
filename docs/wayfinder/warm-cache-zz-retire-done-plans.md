# warm-cache-zz — Retire the campaign's plans

**Wayfinder:** `warm-cache`
**Branch:** `task/warm-cache-zz-retire-done-plans`
**Status:** active

The campaign's final ticket. **Execute it only when no other task is active** — running it
early deletes the plans of tickets still to come.

Nothing else in this repository removes these files. Skip this ticket and the campaign's
scaffolding stays permanently: a directory of done plans belonging to a campaign that
ended, owned by nobody.

## Criteria

1. **Delete every `docs/wayfinder/warm-cache-*.md` plan file, this one included.** That is
   tickets 01, 02, 03, 04, and `zz`.

2. **Leave `docs/wayfinder/wayfinder-warm-cache.md` alone.** The map is retired by the
   close operation, not by this ticket.

3. **Leave every other campaign's plans alone.** `docs/wayfinder/` also holds
   `monorepo-fusion-*`, `provider-seam-*`, `map-*`, `research-*`, and `decision-*` files
   belonging to other campaigns. Match on the `warm-cache-` prefix exactly.

4. **Do not touch `docs/adrs/`.** The seven ADRs this campaign wrote are the durable
   record and outlive it. Same for `docs/features/keep-a-chat-warm.md`.

5. **Regenerate the docs index** — `okq --bundle docs index` — so
   `docs/wayfinder/index.md` no longer lists the deleted plans.

6. **Confirm the gate passes.** `node scripts/check-docs.mjs` fails on a link to a missing
   file, so check that nothing outside this campaign linked to a deleted plan. The map
   links them, and the map is still present at this point — update the map's active-tasks
   table links if the gate objects, rather than deleting the map early.

## Done when

No `docs/wayfinder/warm-cache-*.md` plan remains, the map is still there, and
`my-command-tools verify` passes.
