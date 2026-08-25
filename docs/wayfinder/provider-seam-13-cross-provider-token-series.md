# provider-seam-13 — Cross-provider token series, never a summed line

**Wayfinder:** `provider-seam`
**Branch:** `task/provider-seam-13-cross-provider-token-series`
**Status:** active

Depends on ticket 08.

## Criteria

1. **Cross-provider pages never sum tokens.** This is
   [ADR 0064](../adrs/0064-tokens-do-not-aggregate-across-providers.md), and it is a
   constraint on **every** surface, not only the ones that exist today.

2. **A cross-provider token view is side-by-side series keyed by provider** — three series,
   three legends, three provider labels — and **never a single summed line**.

3. **Any "all providers" scalar is money only**, where
   [ADR 0044](../adrs/0044-every-model-gets-a-price-row.md) already governs the unit and the
   propagation rule: `null` propagates, and one unpriced record makes the aggregate
   unavailable.

4. **Within one provider, tokens sum freely**, using that provider's own reconciliation
   rule from ticket 01. No rule leaks past its own provider's boundary.

5. **Why**, so a later reader does not "fix" this: the three measurements are genuinely
   different. Anthropic's cache counters are **additive**; OpenAI's cached input is a
   **subset**; ox's detail is **nested**, with
   `stacks/ox-alpha/packages/core/src/usage.ts:50-58` enforcing
   `totalTokens === inputTokens + outputTokens` on pain of `UsageValidationError`. Summing
   them yields a plausible integer with no null and no typed reason attached — the exact
   failure [ADR 0060](../adrs/0060-a-stores-absence-is-typed.md) refuses.

6. **Build no canonical token schema and no adapter method returning one.** It would force
   ox's assertion to be either untranslatable or relaxed, and relaxing it is the
   disjoint-bucket rewrite [ADR 0063](../adrs/0063-ox-alpha-keeps-its-nested-usage-buckets.md)
   refuses.

7. **A footnote is not an acceptable alternative to this rule.** A caveat does not travel
   with a number into a screenshot or an export.

8. Tests: no API response or view model exposes a cross-provider token total; per-provider
   series each carry their provider; a money aggregate across providers still works and
   propagates `null` per 0044.

9. `my-command-tools verify` green.
