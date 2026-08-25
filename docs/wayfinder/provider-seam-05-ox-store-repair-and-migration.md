# provider-seam-05 — ox: give it a forward ladder, then migrate 1→2

**Wayfinder:** `provider-seam`
**Branch:** `task/provider-seam-05-ox-store-repair-and-migration`
**Status:** active

**The two halves are strictly ordered**, which is why they are one ticket. ox has no ladder
at all today, so any version bump is an immediate hard failure.

## Criteria

### Part A — the ladder, first

1. **`stacks/ox-alpha/server/src/database.ts:105-107` has no forward ladder.** It runs
   `MIGRATION` only when `user_version === 0` and otherwise throws
   `unsupported database schema version`. Unlike codex it does **not** delete — that is a
   real difference and worth preserving: ox is data-safe today, merely un-migratable.

2. **Add a real forward-only ladder** in the shape claude's `open.ts` uses, per
   [ADR 0047](../adrs/0047-sqlite-substrate-with-forward-only-migrations.md). A version the
   ladder cannot migrate stays a **loud refusal**. Never introduce a delete-or-rebuild path
   — [ADR 0048](../adrs/0048-deletion-policy-split-by-tier.md).

### Part B — the migration, only after Part A

3. **Bump ox 1 → 2**, adding `provider`, `harness`, `model` and `adapter_version` to
   `usage_records`.

4. **Populate them at ingest, from the `sidecar_json` ox already parses.** ox must already
   parse it, since it rejects malformed sidecars into `rejected_sidecars`. `sidecar_json`
   **remains the source of truth**; the four columns are a materialised projection of it,
   written once at ingest.

5. **No read path may reconstitute `provider` or `model` by parsing the blob.** That is the
   outcome [ADR 0061](../adrs/0061-three-schemas-three-ladders-one-contract.md) requires,
   and it is what makes this materialisation legitimate rather than the read-time inference
   [ADR 0040](../adrs/0040-three-providers-and-three-harnesses.md) forbids.

6. **Do NOT touch ox's usage normalizer.** Its nested-bucket assumption is load-bearing at
   four sites, two of them arithmetic that goes negative if inverted —
   `packages/core/src/usage.ts:50`, `sidecar.ts:147`, `pricing.ts:89`, `limits.ts:42` — and
   `docs/specs/ox-alpha-bike-architecture.md:42` is the written contract behind it. See
   [ADR 0063](../adrs/0063-ox-alpha-keeps-its-nested-usage-buckets.md). An unexpected usage
   shape must keep throwing `UsageValidationError` loudly; do not make it permissive.

7. **`cost` and `pricing_source` are NOT columns** ([ADR 0065](../adrs/0065-cost-is-resolved-at-read-time.md)).

8. Tests: a fixture at version 1 migrates to 2 with every `usage_records` row and its
   `sidecar_json` byte-identical; the four columns match what the blob says; an
   un-migratable version refuses loudly; and **no path deletes or recreates the database,
   its `-wal` or its `-shm`**.

9. `my-command-tools verify` green.
