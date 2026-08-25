import { describe, expect, it } from 'vitest';
import { PROVIDER_IDS } from '../src/adapter-seam.js';
import {
  anthropicProviderAdapter,
  createProviderRegistry,
  openAiProviderAdapter,
  oxAlphaProviderAdapter,
  providerRegistry,
} from '../src/provider-adapter.js';

describe('each provider reconciles usage by its own rule', () => {
  it('Anthropic treats cache counters as additive, outside input', () => {
    const reconciled = anthropicProviderAdapter.reconcileUsage({
      inputTokens: 1_000,
      cacheReadTokens: 5_000,
      cacheCreationTokens: 200,
      outputTokens: 300,
    });

    expect(anthropicProviderAdapter.detailRelation).toBe('additive');
    // The two cache counters sit outside `inputTokens`, so the prompt is the sum.
    expect(reconciled.promptTokens).toBe(6_200);
    expect(reconciled.provider).toBe('anthropic');
  });

  it('OpenAI treats cached input as a subset of input', () => {
    const reconciled = openAiProviderAdapter.reconcileUsage({
      inputTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 300,
    });

    expect(openAiProviderAdapter.detailRelation).toBe('subset');
    // `inputTokens` already includes the cached part, so nothing is added...
    expect(reconciled.promptTokens).toBe(1_000);
    // ...and the uncached remainder is what is left after subtracting it.
    expect(reconciled.uncachedInputTokens).toBe(600);
  });

  it('Ox Alpha treats detail as nested inside its headline category', () => {
    const reconciled = oxAlphaProviderAdapter.reconcileUsage({
      inputTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 300,
      reasoningOutputTokens: 120,
      totalTokens: 1_300,
    });

    expect(oxAlphaProviderAdapter.detailRelation).toBe('nested');
    expect(reconciled.promptTokens).toBe(1_000);
    // The counters ox validated are carried through untouched — this package
    // consumes ox's normalizer output rather than re-deriving or re-checking it.
    expect(reconciled.totalTokens).toBe(1_300);
    expect(reconciled.reasoningOutputTokens).toBe(120);
  });

  it('gives three different answers to the same counters, which is the point', () => {
    // Same headline input and same cached/cache-read detail, read under each
    // provider's own rule. A shared rule would collapse these to one number.
    const anthropic = anthropicProviderAdapter.reconcileUsage({
      inputTokens: 1_000,
      cacheReadTokens: 400,
      cacheCreationTokens: 0,
      outputTokens: 300,
    });
    const openai = openAiProviderAdapter.reconcileUsage({
      inputTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 300,
    });

    expect(anthropic.promptTokens).toBe(1_400);
    expect(openai.promptTokens).toBe(1_000);
    expect(anthropic.promptTokens).not.toBe(openai.promptTokens);
  });
});

describe('the provider registry', () => {
  it('ships the three providers and nothing else', () => {
    expect([...providerRegistry.ids()].sort()).toEqual([...PROVIDER_IDS].sort());
  });

  it('returns the adapter registered for each provider', () => {
    expect(providerRegistry.get('anthropic')).toBe(anthropicProviderAdapter);
    expect(providerRegistry.get('openai')).toBe(openAiProviderAdapter);
    expect(providerRegistry.get('ox-alpha')).toBe(oxAlphaProviderAdapter);
  });

  it('throws rather than guessing for an unregistered provider', () => {
    const empty = createProviderRegistry();
    expect(() => empty.get('anthropic')).toThrow(/no provider adapter registered/);
    expect(empty.find('anthropic')).toBeUndefined();
  });

  it('replaces an adapter registered twice for one provider', () => {
    const registry = createProviderRegistry();
    registry.register(anthropicProviderAdapter);
    registry.register(anthropicProviderAdapter);
    expect(registry.ids()).toEqual(['anthropic']);
  });
});
