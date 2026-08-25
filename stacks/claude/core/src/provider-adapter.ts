/**
 * The versioned `ProviderAdapter` contract and the provider registry.
 *
 * A provider owns the **wire contract and the pricing axis**. It does not own
 * session shape or transcript format — those are the harness's, in
 * `harness-adapter.ts`, which this file does not import and which does not
 * import this one.
 *
 * ## What a provider adapter owns, and what it must not
 *
 * Each adapter owns **its own usage reconciliation rule**, and no rule leaks
 * past its own provider's boundary. The three rules genuinely differ, and the
 * difference is recorded rather than suspected:
 *
 * | Provider | Detail vs headline | Consequence |
 * |---|---|---|
 * | Anthropic | **additive** | cache-read and cache-creation sit *outside* `input_tokens` |
 * | OpenAI | **subset** | cached input is *inside* input |
 * | Ox Alpha | **nested** | detail is inside its headline category |
 *
 * **No adapter returns a canonical normalized token shape, and none may be
 * added** — `docs/adrs/0064-tokens-do-not-aggregate-across-providers.md`. The
 * three reconciled types below share no base type and no union, and each carries
 * a literal `provider` discriminant, so a value of one is not structurally
 * assignable to another. That is deliberate: it makes "sum the three" a type
 * error rather than a convention someone has to remember.
 *
 * ## Where raw-wire normalization lives
 *
 * `reconcileUsage` takes **counters that have already been parsed and validated**
 * by whatever read the wire, not raw wire JSON. For Ox Alpha that parser is
 * `stacks/ox-alpha/packages/core/src/usage.ts`, which
 * `docs/adrs/0063-ox-alpha-keeps-its-nested-usage-buckets.md` requires be left
 * unchanged — including its loud `UsageValidationError`. This package therefore
 * neither imports it nor reimplements it: it consumes its output and applies the
 * one relation the adapter is responsible for. Re-asserting ox's invariants here
 * would duplicate the very code that ADR pins.
 *
 * That split is also what keeps this package deterministic and browser-safe.
 * `stacks/claude/core/src` is bundled into the browser by the admin app, so it
 * reads no clock, no filesystem, no environment and no network, imports no Node
 * builtins, and takes no runtime dependency — including on a sibling stack.
 */

import type { HarnessId, ProviderId, RecordStamp } from './adapter-seam.js';

/**
 * How a provider's *detail* counters relate to its *headline* counters. This is
 * the whole of what differs between the three, declared as data so the three
 * answers can be read side by side instead of inferred from three code paths.
 */
export type UsageDetailRelation = 'additive' | 'subset' | 'nested';

/**
 * The versioned provider contract.
 *
 * `adapterVersion` is the value that lands in a record's `adapter_version`
 * column. It versions *this adapter*, not the provider and not the schema —
 * each of the three ladders in
 * `docs/adrs/0061-three-schemas-three-ladders-one-contract.md` moves on its own.
 */
export interface ProviderAdapter<TCounters, TReconciled> {
  readonly provider: ProviderId;
  readonly adapterVersion: number;
  /** The rule this adapter owns, stated as data. */
  readonly detailRelation: UsageDetailRelation;
  /**
   * Apply this provider's reconciliation rule to counters already parsed from
   * its wire format. Returns *this provider's* shape — never a shared one.
   */
  reconcileUsage(counters: TCounters): TReconciled;
}

/**
 * A provider adapter with its counter shapes erased, which is what the registry
 * stores.
 *
 * `never` in the parameter position is what makes this safe rather than lax:
 * every concrete adapter is assignable to it, but `reconcileUsage` cannot be
 * *called* through it, so a caller that wants to reconcile must first narrow to
 * the concrete adapter it means. Erasure buys heterogeneous storage without
 * buying a way to feed one provider's counters to another's rule.
 */
export type AnyProviderAdapter = ProviderAdapter<never, unknown>;

// ---------------------------------------------------------------------------
// Anthropic — cache counters are ADDITIVE, outside `input_tokens`.
// ---------------------------------------------------------------------------

export interface AnthropicUsageCounters {
  /** Non-cached input tokens, billed at the input rate. */
  readonly inputTokens: number;
  /** Tokens read from the prompt cache. Sits *outside* `inputTokens`. */
  readonly cacheReadTokens: number;
  /** Tokens written to the prompt cache. Also *outside* `inputTokens`. */
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
}

export interface AnthropicReconciledUsage extends AnthropicUsageCounters {
  readonly provider: 'anthropic';
  /**
   * `inputTokens + cacheReadTokens + cacheCreationTokens` — the true prompt size
   * sent to the model. The addition is only correct **because** the two cache
   * counters are additive for this provider; the same expression is wrong for
   * the other two.
   */
  readonly promptTokens: number;
}

// ---------------------------------------------------------------------------
// OpenAI — cached input is a SUBSET of input.
// ---------------------------------------------------------------------------

export interface OpenAiUsageCounters {
  /** Total input tokens. Already *includes* `cachedInputTokens`. */
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
}

export interface OpenAiReconciledUsage extends OpenAiUsageCounters {
  readonly provider: 'openai';
  /** `inputTokens - cachedInputTokens` — the part that was not a cache hit. */
  readonly uncachedInputTokens: number;
  /**
   * Equal to `inputTokens`. Adding the cached count would double-count it,
   * which is precisely the mistake the Anthropic rule makes correct.
   */
  readonly promptTokens: number;
}

// ---------------------------------------------------------------------------
// Ox Alpha — detail is NESTED inside its headline category.
// ---------------------------------------------------------------------------

/**
 * Ox Alpha's normalized counters, as produced by
 * `stacks/ox-alpha/packages/core/src/usage.ts`.
 *
 * This is a structural declaration of that function's *output*, so this package
 * can name what it consumes without depending on ox's package. It is not a
 * second copy of the normalizer: the parsing, the five validations and the
 * `UsageValidationError` all stay in ox, unchanged, per ADR 0063.
 */
export interface OxAlphaUsageCounters {
  readonly inputTokens: number;
  /** Nested inside `inputTokens`. */
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  /** Nested inside `outputTokens`. */
  readonly reasoningOutputTokens: number;
  /** ox enforces `totalTokens === inputTokens + outputTokens` at its boundary. */
  readonly totalTokens: number;
}

export interface OxAlphaReconciledUsage extends OxAlphaUsageCounters {
  readonly provider: 'ox-alpha';
  /**
   * Equal to `inputTokens`. Detail is nested, so the headline already accounts
   * for it and nothing is added.
   */
  readonly promptTokens: number;
}

export const anthropicProviderAdapter: ProviderAdapter<AnthropicUsageCounters, AnthropicReconciledUsage> =
  Object.freeze({
    provider: 'anthropic',
    adapterVersion: 1,
    detailRelation: 'additive',
    reconcileUsage(counters: AnthropicUsageCounters): AnthropicReconciledUsage {
      return Object.freeze({
        provider: 'anthropic',
        inputTokens: counters.inputTokens,
        cacheReadTokens: counters.cacheReadTokens,
        cacheCreationTokens: counters.cacheCreationTokens,
        outputTokens: counters.outputTokens,
        promptTokens: counters.inputTokens + counters.cacheReadTokens + counters.cacheCreationTokens,
      });
    },
  });

export const openAiProviderAdapter: ProviderAdapter<OpenAiUsageCounters, OpenAiReconciledUsage> = Object.freeze({
  provider: 'openai',
  adapterVersion: 1,
  detailRelation: 'subset',
  reconcileUsage(counters: OpenAiUsageCounters): OpenAiReconciledUsage {
    return Object.freeze({
      provider: 'openai',
      inputTokens: counters.inputTokens,
      cachedInputTokens: counters.cachedInputTokens,
      uncachedInputTokens: counters.inputTokens - counters.cachedInputTokens,
      outputTokens: counters.outputTokens,
      promptTokens: counters.inputTokens,
    });
  },
});

export const oxAlphaProviderAdapter: ProviderAdapter<OxAlphaUsageCounters, OxAlphaReconciledUsage> = Object.freeze({
  provider: 'ox-alpha',
  adapterVersion: 1,
  detailRelation: 'nested',
  reconcileUsage(counters: OxAlphaUsageCounters): OxAlphaReconciledUsage {
    return Object.freeze({
      provider: 'ox-alpha',
      inputTokens: counters.inputTokens,
      cachedInputTokens: counters.cachedInputTokens,
      outputTokens: counters.outputTokens,
      reasoningOutputTokens: counters.reasoningOutputTokens,
      totalTokens: counters.totalTokens,
      promptTokens: counters.inputTokens,
    });
  },
});

/**
 * A registry keyed by provider, and by nothing else. It is not indexed by
 * harness, holds no combined key, and has no sibling-aware method.
 */
export interface ProviderRegistry {
  /** Replaces any adapter already registered for the same provider. */
  register(adapter: AnyProviderAdapter): void;
  /** Throws when the provider has no adapter. */
  get(provider: ProviderId): AnyProviderAdapter;
  find(provider: ProviderId): AnyProviderAdapter | undefined;
  /** Providers with an adapter, in registration order. */
  ids(): readonly ProviderId[];
}

export function createProviderRegistry(): ProviderRegistry {
  const adapters = new Map<ProviderId, AnyProviderAdapter>();
  return {
    register(adapter: AnyProviderAdapter): void {
      adapters.set(adapter.provider, adapter);
    },
    get(provider: ProviderId): AnyProviderAdapter {
      const adapter = adapters.get(provider);
      if (adapter === undefined) {
        throw new Error(`no provider adapter registered for '${provider}'`);
      }
      return adapter;
    },
    find(provider: ProviderId): AnyProviderAdapter | undefined {
      return adapters.get(provider);
    },
    ids(): readonly ProviderId[] {
      return [...adapters.keys()];
    },
  };
}

/**
 * The three provider adapters this repository ships, registered independently of
 * the harness registry. Adding a fourth provider is one more `register` call
 * here and no change at all in `harness-adapter.ts`.
 */
export const providerRegistry: ProviderRegistry = createProviderRegistry();
providerRegistry.register(anthropicProviderAdapter);
providerRegistry.register(openAiProviderAdapter);
providerRegistry.register(oxAlphaProviderAdapter);

/**
 * Stamp a record this provider adapter produced.
 *
 * `harness` is a **required argument**, never read off the adapter, because the
 * adapter does not know it and must not guess: that is ADR 0040 made executable
 * rather than advisory. A caller that cannot say which harness produced the
 * record does not have a stampable record.
 */
export function stampFromProvider(
  adapter: AnyProviderAdapter,
  context: { readonly harness: HarnessId; readonly model: string },
): RecordStamp {
  return Object.freeze({
    provider: adapter.provider,
    harness: context.harness,
    model: context.model,
    adapterVersion: adapter.adapterVersion,
  });
}
