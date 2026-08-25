# provider-seam-06 — The rate table, and cost resolved at read time

**Wayfinder:** `provider-seam`
**Branch:** `task/provider-seam-06-pricing-table-and-read-time-cost`
**Status:** active

Depends on ticket 03. This is the data side only — the CRUD page is ticket 14.

## Criteria

1. **A rate table with input, output, cache-read and cache-write rates per model.** Mostly
   already decided by [ADR 0044](../adrs/0044-every-model-gets-a-price-row.md) — **cite it,
   do not re-decide it**: a row for every model the corpus contains, **no effective
   dating**, no `valid_from`, no rate history.

2. **`cost` and `pricing_source` are resolved at read time from this table, and stored
   nowhere.** This is [ADR 0065](../adrs/0065-cost-is-resolved-at-read-time.md), and it is
   what makes 0044's "editing a rate reprices the corpus" true rather than aspirational. A
   stored stamp would go stale the moment an operator edits a rate, producing a
   confidently-wrong share-of-fallback figure — which defeats the exact purpose 0044 line
   71 gives the stamp.

3. **A declared fallback row per proxy**, stamped `pricing_source: fallback:<proxy>`. This
   is a **normal state**, not an error.

4. **An `unknown` state with cost `null`, never `0`**, carrying a **typed reason** —
   [ADR 0020](../adrs/0020-unavailable-incomplete-cost.md). Never substitute zero, and never
   label a partial estimate as a total.

5. **No write amplification on a rate edit.** No backfill, no bulk update, no partial state.
   Editing a rate is an ordinary correction, not a migration.

6. **The join is keyed on `model` against a small dimension table.** That is what keeps it
   cheap. The live corpus holding 6 distinct models today is **not** the warrant — 0044
   makes the table grow with every model any provider ships. Do not write a comment or a
   test that treats six as a design property.

7. **Reprice via [ADR 0038](../adrs/0038-retroactive-catalogue-pricing.md).** Note 0038's
   own mechanism referenced ADR 0028, which is superseded by 0047 — under read-time
   resolution the promise holds because **there is nothing derived to migrate**.

8. Tests: editing a rate changes historical totals with no write to any record; a model with
   no rate row resolves to unknown with a typed reason and `null` cost; a fallback row
   resolves with the `fallback:<proxy>` stamp; deleting a rate row makes affected records
   resolve unknown on the next read rather than dangling.

9. `my-command-tools verify` green.
