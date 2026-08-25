# provider-seam-03 — claude migration 23, with a pre-migration JSONL backup

**Wayfinder:** `provider-seam`
**Branch:** `task/provider-seam-03-claude-migration-23`
**Status:** active

Depends on ticket 02. **No database is dropped by this ticket or any other in this
campaign.**

## Criteria

1. **Add migration 23** to `stacks/claude/server/src/db/open.ts`, which is at
   `SCHEMA_VERSION = 22`. It adds `provider`, `harness`, `model` and `adapter_version` to
   the record tier. It is a **numbered forward migration** per
   [ADR 0047](../adrs/0047-sqlite-substrate-with-forward-only-migrations.md), which decides
   that a `user_version` mismatch is **never** resolved by deletion.
   [ADR 0048](../adrs/0048-deletion-policy-split-by-tier.md) forbids deleting the record
   tier by any operation.

2. **`cost` and `pricing_source` are NOT columns.** Do not add them.
   [ADR 0065](../adrs/0065-cost-is-resolved-at-read-time.md) decides both are resolved at
   read time from the rate table.

3. **Backfill the four new columns for existing rows.** The live corpus is 60,834 requests
   and **3,211 rows carry `blob_evicted = 1`** — their bodies are gone, which is precisely
   why forward migration is mandatory and no rebuild path may be built. Backfill from what
   the row and its sidecar already carry; where a value genuinely cannot be determined,
   leave it explicitly unknown rather than guessing a default.

4. **Take a pre-migration JSONL backup of `request_skim` AND the `body_derived` flag**,
   before the ladder runs. This is **belt-and-braces only**: it is **never a seed**, and it
   is **never read on the happy path**. Nothing in normal operation may depend on it.

5. **`body_derived` is real** — a column on `request`, added in the `SCHEMA_V13` block of
   `open.ts`, with references in `ingest.ts`, `open.ts` and `source.ts`. It distinguishes
   "body read, derivatives stored" from "body never read", and the comment above it records
   why it is deliberately **not** `skim_text IS NOT NULL`. Do not conclude it is absent by
   grepping for a table of that name — an earlier pass did exactly that and was wrong.

6. **Reprice everything at today's rates** via the existing mechanism in
   [ADR 0038](../adrs/0038-retroactive-catalogue-pricing.md). Build no rebuild path.

7. Tests: migration 22→23 against a fixture database preserves every row and every existing
   column value; the backfill populates the four columns; a database already at 23 is a
   no-op; **no code path deletes, recreates or truncates the database file, its `-wal` or
   its `-shm`**.

8. `my-command-tools verify` green.
