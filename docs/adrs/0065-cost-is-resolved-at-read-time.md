---
type: adr
title: Cost and pricing_source are resolved at read time, never stored
description: A value that is a function of a mutable rate table is never frozen onto a record; provider, harness, model and adapter_version are stored because they are facts about what produced the record.
tags: [pricing, storage, providers, aggregates]
timestamp: 2026-08-25
scope: all
decided-by: /dev
ratified: false
wayfinder: provider-seam
grill-round: 5
needs-human: true
---

# Cost and `pricing_source` are resolved at read time, never stored

## Status

Proposed by `/dev` during the `provider-seam` campaign. **A human has not ratified this
decision.** Flagged because it narrows an invariant the campaign brief stated flatly, and
because it settles a tension **inside** a ratified record rather than merely applying one.

## Context

The campaign brief listed `pricing_source` alongside `provider`, `harness`, `model` and
`adapter_version` as "columns on every record, never derived context", and paired that with
"reprice at today's rates via [ADR 0038](0038-retroactive-catalogue-pricing.md); no rebuild
path."

The griller showed those cannot both hold:

> "`pricing_source` is not a fact about the request; it is a fact about *which row of a
> mutable table priced it*, and 0044 makes that table editable at any moment. The moment an
> operator uses the CRUD page to replace a fallback with a published rate for a model, every
> one of the affected rows among your 60,834 is repriced by 0044 — but its stored
> `pricing_source` column still reads `fallback:<proxy>`, and 0044:66 depends on that stamp
> being right. You now have a share-of-fallback figure that is confidently wrong, with no
> null and no typed reason."

Verified at source:

- `0044:60-61` — "**No effective dating.** One current rate per model prices every row in
  the corpus, and **editing a rate reprices the corpus.** There is no `valid_from`, no rate
  history."
- `0044:71-72` — "Every priced record **carries** `pricing_source`, so the dashboard can
  show what share of a total rests on fallback rates rather than published ones."
- `0038:39` reprices by way of "ADR 0028" — and
  `docs/adrs/0028-rebuild-view-on-schema-mismatch.md` carries
  `superseded-by: "0047"` in its own frontmatter. **The mechanism 0038 names is gone.**

## Decision

**`cost` and `pricing_source` are not stored. They are resolved at read time from the price
table on every query.** The brief's "columns on every record" is **withdrawn for those two
fields** and holds for the other four.

### The tension is inside 0044, and only this reading resolves it

0044 line 71 does not merely say a record carries the stamp — it says **why**: "so the
dashboard can show what share of a total rests on fallback rates." That purpose is served
**only** if the stamp is resolved at the same moment as the cost it describes.

A frozen stamp does not slightly degrade line 71's purpose. It **defeats** it, and defeats
it silently, producing exactly the confidently-wrong share-of-fallback figure above. So a
stored `pricing_source` is not a permitted reading of 0044 that happens to conflict with
line 60 — it is a reading that breaks the very clause it comes from.

Read this way the record is consistent end to end: cost is a **function of the rate table**,
not a property of the request, and line 71's "carries" is satisfied by the record **as
served** — the resolved API record carries its stamp — rather than by a column frozen at
ingest.

### The dividing line

| Field | Stored? | Because |
|---|---|---|
| `provider` | **yes** | a fact about what produced the record, fixed when it was produced |
| `harness` | **yes** | same, and [ADR 0040](0040-three-providers-and-three-harnesses.md) forbids re-deriving either from the other |
| `model` | **yes** | same |
| `adapter_version` | **yes** | same — which adapter produced this record |
| `cost` | **no** | a function of a table an operator may edit at any moment |
| `pricing_source` | **no** | same, and freezing it defeats the purpose 0044 gives it |

**Freezing a function of mutable state is a cache**, and 0044 supplies no invalidation rule
because 0044 does not intend such a cache to exist.

### What this repairs

**0038's promise is restored on better grounds than 0038 had.** `0038:39` promised
repricing "without data migration" by leaning on a rebuild that no longer exists. Here the
promise holds because **there is nothing derived to migrate**. The dependency on the
superseded 0028 is removed rather than patched.

**A deleted price row needs no special handling.** The model resolves to the unknown state
0044 and [ADR 0020](0020-unavailable-incomplete-cost.md) already define — cost `null`, typed
reason — on the next read.

## Consequences

- **Every cost-bearing query joins the price table.** The join is keyed on `model` against a
  **small dimension table**, which is what keeps it cheap. 0044 makes that table "a row for
  every model the corpus contains", so it grows as providers ship models — the join stays
  cheap because of its shape, **not** because the live corpus happens to hold six distinct
  models today. Do not read that six as the warrant.
- **Editing a rate has no write amplification.** No backfill, no bulk update, no partial
  state — which is what makes 0044's CRUD page an ordinary correction rather than a
  migration.
- **A record's cost is not reproducible from the record alone.** Reproducing a past number
  needs the rate table as it stood, which 0044 explicitly does not keep. That is 0044's
  decision ("no rate history"), inherited here rather than introduced.
- **If the join ever does become a cost, the remedy is a materialised view with explicit
  invalidation on rate edit** — a later decision with a real trigger, not something to
  pre-build.

## Alternatives considered

**Rate edit as an explicit bulk write** rewriting `cost` and `pricing_source` across every
affected row. Rejected. It makes 0044's CRUD page a migration over tens of thousands of
rows with a failure mode 0044 never contemplates: a half-completed reprice leaves the
corpus internally inconsistent with no version to detect it by. 0044 describes editing a
rate as an operator "correcting a typo", not as an operation that can fail partway.

**`pricing_source` as a foreign key to the price row.** Closer, and it does follow the table
without a rewrite — but it fails when the operator deletes that row. The honest answer there
is not a dangling key but the unknown state already defined, which option (a) reaches with
no special case at all.

**Store the cost and accept staleness.** Rejected outright: it is the status quo the
griller's question describes, and it produces a wrong number with no null and no typed
reason — the failure shape this campaign refuses in ADR 0060 and ADR 0064.
