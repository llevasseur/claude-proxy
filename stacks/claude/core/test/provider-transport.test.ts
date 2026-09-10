import { describe, expect, it } from 'vitest';
import {
  API_ROUTES,
  apiRouteServedBy,
  apiRoutesFor,
  fanOutEnvelopes,
  MISDIRECTED_PROVIDER_STATUS,
  PROVIDER_IDS,
  type ProviderEnvelope,
  type ProviderId,
  parseProviderUnavailableReason,
  providerAvailable,
  providerUnavailable,
  remoteReadFailureReason,
  storeUnreadable,
} from '../src/index.js';

/**
 * The remote fan-out's rules, which are the ones ticket 08's criteria 1, 4, 5 and 7 name.
 *
 * These live here rather than beside the dashboard that uses them because the dashboard has
 * no test runner — `typecheck` is claude's admin's only gate — so the decisions worth
 * proving were put in core precisely so they could be proved.
 */

const ORIGIN = 'http://localhost:8808';

describe('every route declares whose store it reads', () => {
  it('gives every declared route a provider scope', () => {
    for (const route of API_ROUTES) {
      expect(route.provider, `${route.path} declares no provider`).toBeTruthy();
    }
  });

  it('scopes a route to a real provider or to none at all', () => {
    const allowed = new Set<string>([...PROVIDER_IDS, 'agnostic']);
    for (const route of API_ROUTES) {
      expect(allowed.has(route.provider), `${route.path} is scoped to ${route.provider}`).toBe(true);
    }
  });

  it('serves an agnostic route from every provider’s server', () => {
    const agnostic = API_ROUTES.filter((route) => route.provider === 'agnostic');
    expect(agnostic.length).toBeGreaterThan(0);
    for (const provider of PROVIDER_IDS) {
      for (const route of agnostic) {
        expect(apiRouteServedBy(route, provider)).toBe(true);
      }
    }
  });

  /**
   * Criterion 1, as a property of the manifest: a server for one provider is not entitled
   * to any other provider's route, so a request for Anthropic has no declared path that
   * reaches the OpenAI or Ox Alpha store.
   */
  it('refuses a provider-scoped route to a server serving another provider', () => {
    const anthropic = API_ROUTES.filter((route) => route.provider === 'anthropic');
    expect(anthropic.length).toBeGreaterThan(0);
    for (const route of anthropic) {
      expect(apiRouteServedBy(route, 'anthropic')).toBe(true);
      expect(apiRouteServedBy(route, 'openai')).toBe(false);
      expect(apiRouteServedBy(route, 'ox-alpha')).toBe(false);
    }
  });

  it('serves claude’s own provider plus the agnostic ledgers, and nothing else', () => {
    const served = apiRoutesFor('anthropic');
    expect(served.every((route) => route.provider === 'anthropic' || route.provider === 'agnostic')).toBe(true);
    // The agnostic routes are shared, so a sibling server serves those and no more.
    const openai = apiRoutesFor('openai');
    expect(openai.every((route) => route.provider === 'agnostic')).toBe(true);
    expect(served.length).toBeGreaterThan(openai.length);
  });
});

describe('an unreachable server and an unreadable store are different reasons', () => {
  /** Criterion 5, and the distinction ADR 0062 exists to keep. */
  it('reports no response at all as provider-unreachable', () => {
    const reason = remoteReadFailureReason('ox-alpha', ORIGIN, {
      kind: 'unreachable',
      detail: 'Failed to fetch',
    });
    expect(reason.code).toBe('provider-unreachable');
    expect(reason).toMatchObject({ provider: 'ox-alpha', origin: ORIGIN });
  });

  it('reports a server that answered but failed to read its store as store-unreadable', () => {
    const reason = remoteReadFailureReason('ox-alpha', ORIGIN, {
      kind: 'refused',
      status: 500,
      message: 'database disk image is malformed',
      reported: null,
    });
    expect(reason.code).toBe('store-unreadable');
  });

  it('never gives the two the same code for the same provider', () => {
    const unreachable = remoteReadFailureReason('openai', ORIGIN, { kind: 'unreachable', detail: 'ECONNREFUSED' });
    const unreadable = remoteReadFailureReason('openai', ORIGIN, {
      kind: 'refused',
      status: 500,
      message: 'locked',
      reported: null,
    });
    expect(unreachable.code).not.toBe(unreadable.code);
  });

  /**
   * A wrong origin is the provider not being reached, not its store misbehaving. Blaming a
   * store this dashboard never spoke to is the misattribution ADR 0062 names.
   */
  it('treats the scope gate’s 421 as unreachable rather than as a store fault', () => {
    const reason = remoteReadFailureReason('openai', ORIGIN, {
      kind: 'refused',
      status: MISDIRECTED_PROVIDER_STATUS,
      message: 'scoped to anthropic; this server serves ox-alpha',
      reported: null,
    });
    expect(reason.code).toBe('provider-unreachable');
  });

  it('prefers the reason the server typed itself over anything inferred', () => {
    const reported = storeUnreadable('openai', 'migrating', 'no such table: rate');
    const reason = remoteReadFailureReason('openai', ORIGIN, {
      kind: 'refused',
      status: 500,
      message: 'HTTP 500',
      reported,
    });
    expect(reason).toEqual(reported);
  });
});

describe('parsing a reason off the wire', () => {
  it('accepts the three single-provider reasons', () => {
    expect(
      parseProviderUnavailableReason({ code: 'store-absent', provider: 'openai', path: '/tmp/x.db' }),
    ).toMatchObject({ code: 'store-absent', provider: 'openai' });
    expect(
      parseProviderUnavailableReason({ code: 'store-unreadable', provider: 'openai', fault: 'locked', detail: 'busy' }),
    ).toMatchObject({ code: 'store-unreadable', fault: 'locked' });
    expect(
      parseProviderUnavailableReason({ code: 'provider-unreachable', provider: 'openai', origin: ORIGIN, detail: 'x' }),
    ).toMatchObject({ code: 'provider-unreachable' });
  });

  it('rejects an aggregate’s reason, which no single provider may claim', () => {
    expect(
      parseProviderUnavailableReason({ code: 'fanout-incomplete', providers: ['openai'], detail: 'x' }),
    ).toBeNull();
  });

  it('rejects an unknown code, an unknown provider, and a non-object', () => {
    expect(parseProviderUnavailableReason({ code: 'something-else', provider: 'openai' })).toBeNull();
    expect(parseProviderUnavailableReason({ code: 'store-absent', provider: 'gemini' })).toBeNull();
    expect(parseProviderUnavailableReason(null)).toBeNull();
    expect(parseProviderUnavailableReason('store-absent')).toBeNull();
  });

  it('falls back to an unknown fault rather than trusting one it does not recognise', () => {
    const reason = parseProviderUnavailableReason({
      code: 'store-unreadable',
      provider: 'openai',
      fault: 'on-fire',
      detail: 'x',
    });
    expect(reason).toMatchObject({ code: 'store-unreadable', fault: 'unknown' });
  });
});

describe('a fan-out keeps every provider’s answer', () => {
  /** Criterion 7: one origin down still returns the other two, plus a typed reason. */
  it('returns the other two providers’ data when one origin is down', async () => {
    const read = async (provider: ProviderId): Promise<ProviderEnvelope<string>> =>
      provider === 'ox-alpha'
        ? providerUnavailable(
            provider,
            remoteReadFailureReason(provider, ORIGIN, { kind: 'unreachable', detail: 'ECONNREFUSED' }),
          )
        : providerAvailable(provider, `${provider}-data`);

    const envelopes = await fanOutEnvelopes(PROVIDER_IDS, read);

    expect(envelopes).toHaveLength(3);
    expect(envelopes.filter((envelope) => envelope.data !== null)).toHaveLength(2);
    const down = envelopes.find((envelope) => envelope.provider === 'ox-alpha');
    expect(down?.data).toBeNull();
    expect(down?.unavailableReason?.code).toBe('provider-unreachable');
    // The two that answered are untouched by the one that did not.
    expect(envelopes.find((envelope) => envelope.provider === 'anthropic')?.data).toBe('anthropic-data');
    expect(envelopes.find((envelope) => envelope.provider === 'openai')?.data).toBe('openai-data');
  });

  it('answers in the order the providers were given', async () => {
    const order: readonly ProviderId[] = ['ox-alpha', 'anthropic', 'openai'];
    const envelopes = await fanOutEnvelopes(order, async (provider) => providerAvailable(provider, provider));
    expect(envelopes.map((envelope) => envelope.provider)).toEqual([...order]);
  });

  /**
   * The guarantee `Promise.all` alone would not give: a rejecting read must not discard the
   * settled answers beside it.
   */
  it('contains a read that rejects instead of losing the whole fan-out', async () => {
    const envelopes = await fanOutEnvelopes(PROVIDER_IDS, async (provider) => {
      if (provider === 'openai') throw new Error('unexpected');
      return providerAvailable(provider, provider);
    });

    expect(envelopes).toHaveLength(3);
    const thrown = envelopes.find((envelope) => envelope.provider === 'openai');
    expect(thrown?.data).toBeNull();
    expect(thrown?.unavailableReason?.code).toBe('store-unreadable');
    expect(envelopes.filter((envelope) => envelope.data !== null)).toHaveLength(2);
  });

  it('reports a genuine zero as data rather than as an absence', async () => {
    const envelopes = await fanOutEnvelopes(PROVIDER_IDS, async (provider) => providerAvailable(provider, []));
    expect(envelopes.every((envelope) => envelope.unavailableReason === null)).toBe(true);
    expect(envelopes.every((envelope) => Array.isArray(envelope.data))).toBe(true);
  });
});
