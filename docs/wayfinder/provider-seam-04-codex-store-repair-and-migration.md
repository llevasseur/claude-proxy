# provider-seam-04 — codex: remove the delete-on-mismatch, then migrate 3→4

**Wayfinder:** `provider-seam`
**Branch:** `task/provider-seam-04-codex-store-repair-and-migration`
**Status:** active

**The two halves of this ticket are strictly ordered, and that is why they are one ticket
rather than two.** Reversed, this destroys codex's corpus.

## Criteria

### Part A — the repair, first

1. **Remove the delete-on-mismatch branch at `stacks/codex/server/src/database.ts:140-143`.**
   Today, on any `user_version` mismatch, it closes the handle and `rmSync`s the database
   plus its `-wal` and `-shm` files with `{ force: true }`, then re-execs `MIGRATION`.
   **Bumping codex's version with that code shipping destroys the corpus on first open.**

2. It is a live violation of two ratified records, so this is a **repair, not a new
   decision** — cite them rather than writing an ADR:
   [ADR 0047](../adrs/0047-sqlite-substrate-with-forward-only-migrations.md) (a
   `user_version` mismatch is never resolved by deletion) and
   [ADR 0048](../adrs/0048-deletion-policy-split-by-tier.md) (the record tier is never
   deleted by any operation). The behaviour it implements came from
   [ADR 0028](../adrs/0028-rebuild-view-on-schema-mismatch.md), which carries
   `superseded-by: "0047"`.

3. Replace it with a **forward-only ladder** matching the shape claude's `open.ts` already
   uses. A version it cannot migrate is a **loud refusal**, never a deletion.

### Part B — the migration, only after Part A

4. **Bump codex 3 → 4**, adding `provider`, `harness`, `model` and `adapter_version` to its
   record tier. Codex's store is **not** converged onto claude's schema — three stores keep
   three schemas and three independent ladders, per
   [ADR 0061](../adrs/0061-three-schemas-three-ladders-one-contract.md). The ladder
   *mechanism* is shared; the schema is not.

5. **Populate the four columns at ingest**, not at read time. Materialising a value parsed
   from the payload at ingest is what claude already does with `skim_text`/`body_derived`;
   it is not the read-time inference ADR 0040 forbids.

6. **`cost` and `pricing_source` are NOT columns** ([ADR 0065](../adrs/0065-cost-is-resolved-at-read-time.md)).

7. Tests: a fixture database at version 3 migrates to 4 with **every row preserved**; a
   version the ladder cannot handle refuses loudly; and an explicit regression test that
   **no code path calls `rmSync`, unlinks, or recreates the database file, its `-wal` or its
   `-shm`**. That test is the guard against this defect returning.

8. `my-command-tools verify` green.
