import { describe, expect, it } from 'vitest';
import { HARNESS_IDS, type HarnessId, PROVIDER_IDS, type ProviderId } from '../src/adapter-seam.js';
import {
  claudeCodeHarnessAdapter,
  createHarnessRegistry,
  harnessRegistry,
  stampFromHarness,
} from '../src/harness-adapter.js';
import {
  anthropicProviderAdapter,
  createProviderRegistry,
  oxAlphaProviderAdapter,
  providerRegistry,
  stampFromProvider,
} from '../src/provider-adapter.js';

describe('the two axes are indexed by their own key and no other', () => {
  it('never answers a provider lookup with a harness', () => {
    for (const harness of HARNESS_IDS) {
      const harnessAsKey: string = harness;
      // SAFETY: `ProviderId` and `HarnessId` are disjoint unions, so at compile
      // time this lookup is already impossible and the assertion is the only way
      // to attempt it at all. Attempting it is the point: the registry must
      // answer `undefined` rather than hand back an adapter from the other axis.
      expect(providerRegistry.find(harnessAsKey as ProviderId)).toBeUndefined();
    }
  });

  it('never answers a harness lookup with a provider', () => {
    for (const provider of PROVIDER_IDS) {
      const providerAsKey: string = provider;
      // SAFETY: the mirror of the case above, and disjoint for the same reason —
      // a provider id is never a key of the harness registry.
      expect(harnessRegistry.find(providerAsKey as HarnessId)).toBeUndefined();
    }
  });

  it('keeps the two id vocabularies disjoint, so no combined key exists', () => {
    const providers = new Set<string>(PROVIDER_IDS);
    for (const harness of HARNESS_IDS) {
      expect(providers.has(harness)).toBe(false);
    }
    // A `provider-harness` composite would show up as a key in one registry
    // carrying the other's name. Neither registry has one.
    for (const id of [...providerRegistry.ids(), ...harnessRegistry.ids()]) {
      expect(id).not.toContain('/');
    }
  });

  it('gives each adapter its own axis field and not the other axis field', () => {
    for (const provider of PROVIDER_IDS) {
      const adapter = providerRegistry.get(provider);
      expect(adapter.provider).toBe(provider);
      expect(adapter).not.toHaveProperty('harness');
    }
    for (const harness of HARNESS_IDS) {
      const adapter = harnessRegistry.get(harness);
      expect(adapter.harness).toBe(harness);
      expect(adapter).not.toHaveProperty('provider');
    }
  });
});

describe('registering on one axis does not touch the other', () => {
  it('leaves a fresh harness registry empty when a provider is registered', () => {
    const providers = createProviderRegistry();
    const harnesses = createHarnessRegistry();

    providers.register(anthropicProviderAdapter);
    providers.register(oxAlphaProviderAdapter);

    expect(providers.ids()).toEqual(['anthropic', 'ox-alpha']);
    expect(harnesses.ids()).toEqual([]);
  });

  it('leaves the shipped harness registry untouched by a provider registration', () => {
    const harnessesBefore = [...harnessRegistry.ids()];
    const providersBefore = [...providerRegistry.ids()];

    // Re-registering the adapter already under this key mutates the provider
    // registry without leaving residue behind for other cases.
    providerRegistry.register(anthropicProviderAdapter);

    expect([...harnessRegistry.ids()]).toEqual(harnessesBefore);
    expect([...providerRegistry.ids()]).toEqual(providersBefore);
    expect(harnessRegistry.get('claude-code')).toBe(claudeCodeHarnessAdapter);
  });
});

describe('a record stamp names both axes and stores no cost', () => {
  it('takes the harness as an argument rather than deriving it from the provider', () => {
    // A deliberately unusual pairing: if the harness were inferred from the
    // provider, this could not be expressed at all.
    const stamp = stampFromProvider(anthropicProviderAdapter, {
      harness: 'codex',
      model: 'claude-opus-4',
    });

    expect(stamp.provider).toBe('anthropic');
    expect(stamp.harness).toBe('codex');
    expect(stamp.adapterVersion).toBe(anthropicProviderAdapter.adapterVersion);
  });

  it('takes the provider as an argument rather than deriving it from the harness', () => {
    const stamp = stampFromHarness(claudeCodeHarnessAdapter, {
      provider: 'ox-alpha',
      model: 'gpt-5',
    });

    expect(stamp.harness).toBe('claude-code');
    expect(stamp.provider).toBe('ox-alpha');
    expect(stamp.adapterVersion).toBe(claudeCodeHarnessAdapter.adapterVersion);
  });

  it('carries exactly the four stored fields — no cost, no pricing source', () => {
    const stamp = stampFromProvider(oxAlphaProviderAdapter, {
      harness: 'opencode',
      model: 'gpt-5-codex',
    });

    expect(Object.keys(stamp).sort()).toEqual(['adapterVersion', 'harness', 'model', 'provider']);
    expect(stamp).not.toHaveProperty('cost');
    expect(stamp).not.toHaveProperty('pricingSource');
    expect(stamp).not.toHaveProperty('pricing_source');
  });
});
