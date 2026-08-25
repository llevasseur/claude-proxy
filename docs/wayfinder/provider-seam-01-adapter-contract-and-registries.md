# provider-seam-01 — Adapter contract and the two registries

**Wayfinder:** `provider-seam`
**Branch:** `task/provider-seam-01-adapter-contract-and-registries`
**Status:** active

This is the campaign's spine. Every other ticket codes against what this one defines, so
get the contract right before anything consumes it.

## Criteria

1. **Define a versioned `ProviderAdapter` contract and a versioned `HarnessAdapter`
   contract** in `stacks/claude/core/src/`, one file each, re-exported from `index.ts`.
   Both carry an `adapterVersion` — the value that lands in every record's
   `adapter_version` column.

2. **Two registries, registered independently.** One keyed by provider, one keyed by
   harness. This is [ADR 0040](../adrs/0040-three-providers-and-three-harnesses.md), which
   is ratified and explicit:
   - **No code may infer the harness from the provider.** Anthropic is not Claude Code.
   - **No code may infer the provider from the harness.** Codex is not OpenAI.
   - **Neither registry is indexed by the other's key**, and there is **no combined
     `provider-harness` key** that would smuggle the pairing back in as one enum value.
   - The pairing that exists today is **data, not structure** — three rows, not three code
     paths. A fourth pair must be a new row.

3. **Register the three provider adapters and the three harness adapters**: Anthropic,
   OpenAI, Ox Alpha as providers; Claude Code, Codex, opencode as harnesses. Registration
   is independent — adding one must not require touching the other registry.

4. **Each ProviderAdapter owns its own usage reconciliation rule**, and no rule leaks past
   its own provider's boundary:
   - **Anthropic** — cache-read and cache-creation are **additive**, outside `input_tokens`.
   - **OpenAI** — cached input is a **subset** of input.
   - **Ox Alpha** — detail is **nested** inside its headline category, per
     `docs/specs/ox-alpha-bike-architecture.md:42`. **Do not change ox's normalizer** — see
     [ADR 0063](../adrs/0063-ox-alpha-keeps-its-nested-usage-buckets.md). Reuse the existing
     logic in `stacks/ox-alpha/packages/core/src/usage.ts` rather than reimplementing it.

5. **No adapter method returns a canonical normalized token shape**, and none may be added.
   [ADR 0064](../adrs/0064-tokens-do-not-aggregate-across-providers.md) forbids it: ox's
   `totalTokens === inputTokens + outputTokens` assertion makes such a schema either
   untranslatable or a relaxation that is the disjoint-bucket rewrite ADR 0063 refuses.

6. **The contract does not include `cost` or `pricing_source`.** Both are resolved at read
   time from the rate table — [ADR 0065](../adrs/0065-cost-is-resolved-at-read-time.md).
   The contract carries `provider`, `harness`, `model` and `adapterVersion` only.

7. **Keep `stacks/claude/core` deterministic** — no Node modules, no environment, clock,
   filesystem, database or network reads, and no runtime dependencies. This is a standing
   repository rule.

8. Unit tests covering: each provider's reconciliation rule against a representative usage
   shape; that a provider lookup never returns a harness and vice versa; and that
   registering a provider does not mutate the harness registry.

9. `my-command-tools verify` green.
