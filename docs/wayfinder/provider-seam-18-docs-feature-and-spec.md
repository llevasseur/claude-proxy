# provider-seam-18 — The durable docs for the seam

**Wayfinder:** `provider-seam`
**Branch:** `task/provider-seam-18-docs-feature-and-spec`
**Status:** active

Runs after the tickets it documents. **The campaign map and the plans are scaffolding and
are deleted; this ticket writes what survives.**

## Criteria

1. **A feature doc under `docs/features/`** describing the provider seam as it actually
   shipped — the two registries, the versioned contract, per-proxy storage, read-time
   pricing, and the typed absence envelope. Write it from the merged code, not from the
   plans.

2. **A spec under `docs/specs/`** for the adapter contract itself: what a ProviderAdapter
   must implement, what a HarnessAdapter must implement, what `adapter_version` means, and
   what a new provider or harness has to supply. This is the document someone adding a
   fourth provider will read.

3. **Every document carries `scope`**, which the docs gate requires of every document with a
   `type`. Use `scope: all` where it governs the whole repository.

4. **Update the section indexes** — the gate asserts them **as files**
   ([ADR 0056](../adrs/0056-the-docs-gate-asserts-indexes-by-file.md)).

5. **Record what is deliberately absent**, because a later reader will otherwise read these
   as gaps:
   - There is **no canonical cross-provider token schema**, by
     [ADR 0064](../adrs/0064-tokens-do-not-aggregate-across-providers.md).
   - `cost` and `pricing_source` are **not columns**, by
     [ADR 0065](../adrs/0065-cost-is-resolved-at-read-time.md).
   - Ox Alpha's nested-bucket normalizer is **unchanged and its disjoint-bucket question is
     open**, by [ADR 0063](../adrs/0063-ox-alpha-keeps-its-nested-usage-buckets.md) — name
     the one artifact that would settle it, a captured ox-alpha-proxy sidecar.
   - The picker **itself** is not built here; only its data side
     ([ADR 0041](../adrs/0041-provider-picker-drives-the-navigation.md)).

6. **Name the six campaign ADRs as unratified.** All of 0060–0065 carry
   `ratified: false, needs-human: true`, and a doc that describes them as settled would
   misrepresent them. `okq --bundle docs find --where needs-human=true` lists them.

7. **Run the docs gate** (`scripts/check-docs.mjs`, wired into `check`) and leave it green.

8. `my-command-tools verify` green.
