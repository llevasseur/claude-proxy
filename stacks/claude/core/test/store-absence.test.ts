import { describe, expect, it } from 'vitest';
import type { ProviderId } from '../src/adapter-seam.js';
import {
  aggregateFanout,
  availableData,
  degradedProviders,
  describeProviderUnavailable,
  isAvailable,
  type ProviderEnvelope,
  pickerStatusFor,
  providerAvailable,
  providerUnavailable,
  providerUnreachable,
  requiresOperatorAttention,
  storeAbsent,
  storeUnreadable,
  unavailableProviders,
} from '../src/store-absence.js';

/**
 * ADR 0060's three states, and the rule that keeps them three.
 *
 * The assertions that matter most here are the negative ones: a provider that
 * genuinely served nothing is **not** reported as absent, and an infrastructure
 * fault is **not** reported as an unreadable store. Both are collapses the
 * decision exists to prevent, and neither shows up as a type error, so a test is
 * the only thing that holds them apart.
 */

const total = (rows: readonly number[]): number => rows.reduce((sum, row) => sum + row, 0);

const anthropic: ProviderId = 'anthropic';
const openai: ProviderId = 'openai';
const ox: ProviderId = 'ox-alpha';

describe('the three states produce three distinct reasons', () => {
  it('gives a never-created store, an unreadable store and an unreachable server different codes', () => {
    const codes = [
      storeAbsent(anthropic, '/logs/claude-proxy.db').code,
      storeUnreadable(openai, 'locked', 'database is locked').code,
      providerUnreachable(ox, 'http://127.0.0.1:8808', 'ECONNREFUSED').code,
    ];
    expect(codes).toEqual(['store-absent', 'store-unreadable', 'provider-unreachable']);
    expect(new Set(codes).size).toBe(3);
  });

  it('carries the context needed to act on each one', () => {
    expect(storeAbsent(anthropic, '/logs/claude-proxy.db')).toMatchObject({
      provider: anthropic,
      path: '/logs/claude-proxy.db',
    });
    expect(storeUnreadable(openai, 'corrupt', 'file is not a database')).toMatchObject({
      fault: 'corrupt',
      detail: 'file is not a database',
    });
    expect(providerUnreachable(ox, 'http://127.0.0.1:8808', 'ECONNREFUSED')).toMatchObject({
      origin: 'http://127.0.0.1:8808',
      detail: 'ECONNREFUSED',
    });
  });

  it('treats a never-created store as a steady state and the other two as faults', () => {
    expect(requiresOperatorAttention(storeAbsent(anthropic))).toBe(false);
    expect(requiresOperatorAttention(storeUnreadable(openai, 'migrating', 'no such table: request'))).toBe(true);
    expect(requiresOperatorAttention(providerUnreachable(ox, 'http://127.0.0.1:8808', 'ECONNREFUSED'))).toBe(true);
  });
});

describe('a genuinely-zero provider is a measurement, not an absence', () => {
  it('keeps an empty result on the available branch', () => {
    const envelope = providerAvailable<readonly number[]>(anthropic, []);
    expect(isAvailable(envelope)).toBe(true);
    expect(envelope.unavailableReason).toBeNull();
    expect(envelope.data).toEqual([]);
  });

  it('does not report it as unavailable or degraded', () => {
    const envelopes = [
      providerAvailable<readonly number[]>(anthropic, []),
      providerAvailable<readonly number[]>(openai, [3]),
    ];
    expect(unavailableProviders(envelopes)).toEqual([]);
    expect(degradedProviders(envelopes)).toEqual([]);
    expect(pickerStatusFor(envelopes[0]!)).toBe('ready');
  });

  it('aggregates a fan-out of zeroes to a real zero rather than to unavailable', () => {
    const result = aggregateFanout(
      [providerAvailable<readonly number[]>(anthropic, []), providerAvailable<readonly number[]>(openai, [])],
      (rows) => total(rows.flat()),
    );
    expect(result.unavailableReason).toBeNull();
    expect(result.value).toBe(0);
  });
});

describe('one unavailable provider does not take down the others', () => {
  const envelopes: readonly ProviderEnvelope<readonly number[]>[] = [
    providerAvailable<readonly number[]>(anthropic, [1, 2]),
    providerUnavailable<readonly number[]>(openai, storeUnreadable(openai, 'locked', 'database is locked')),
    providerAvailable<readonly number[]>(ox, [4]),
  ];

  it('keeps the data of the two providers that answered intact', () => {
    expect(availableData(envelopes)).toEqual([[1, 2], [4]]);
    expect(unavailableProviders(envelopes)).toEqual([openai]);
  });

  it('never returns a bare gap — the third contributes a reason', () => {
    const missing = envelopes.find((envelope) => !isAvailable(envelope));
    expect(missing?.data).toBeNull();
    expect(missing?.unavailableReason?.code).toBe('store-unreadable');
  });
});

describe('an aggregate over a partial fan-out propagates', () => {
  it('reports unavailability rather than totalling the providers that answered', () => {
    const result = aggregateFanout(
      [
        providerAvailable<readonly number[]>(anthropic, [1, 2]),
        providerUnavailable<readonly number[]>(openai, storeUnreadable(openai, 'locked', 'database is locked')),
        providerAvailable<readonly number[]>(ox, [4]),
      ],
      (rows) => total(rows.flat()),
    );
    expect(result.value).toBeNull();
    expect(result.unavailableReason).toMatchObject({ code: 'fanout-incomplete', providers: [openai] });
  });

  it('names every provider that did not report', () => {
    const result = aggregateFanout(
      [
        providerUnavailable<readonly number[]>(anthropic, storeAbsent(anthropic, '/logs/claude-proxy.db')),
        providerAvailable<readonly number[]>(openai, [1]),
        providerUnavailable<readonly number[]>(ox, providerUnreachable(ox, 'http://127.0.0.1:8808', 'ECONNREFUSED')),
      ],
      (rows) => total(rows.flat()),
    );
    expect(result.unavailableReason).toMatchObject({ providers: [anthropic, ox] });
    expect(result.unavailableReason?.code === 'fanout-incomplete' && result.unavailableReason.detail).toBe(
      'anthropic:store-absent, ox-alpha:provider-unreachable',
    );
  });

  it('combines when every provider answered', () => {
    const result = aggregateFanout(
      [providerAvailable<readonly number[]>(anthropic, [1, 2]), providerAvailable<readonly number[]>(openai, [4])],
      (rows) => total(rows.flat()),
    );
    expect(result).toEqual({ value: 7, unavailableReason: null });
  });
});

describe('the picker reads the same envelope', () => {
  it('separates a provider that has never run from one that is broken', () => {
    const envelopes = [
      providerAvailable<readonly number[]>(anthropic, [1]),
      providerUnavailable<readonly number[]>(openai, storeAbsent(openai, '/logs/codex.db')),
      providerUnavailable<readonly number[]>(ox, providerUnreachable(ox, 'http://127.0.0.1:8808', 'ECONNREFUSED')),
    ];
    expect(envelopes.map((envelope) => pickerStatusFor(envelope))).toEqual(['ready', 'absent', 'degraded']);
    expect(degradedProviders(envelopes)).toEqual([ox]);
  });
});

describe('describeProviderUnavailable', () => {
  it('says which fault it is, per reason', () => {
    expect(describeProviderUnavailable(storeAbsent(anthropic))).toContain('has no store yet');
    expect(describeProviderUnavailable(storeUnreadable(openai, 'corrupt', 'file is not a database'))).toContain(
      'unreadable (corrupt)',
    );
    expect(describeProviderUnavailable(providerUnreachable(ox, 'http://127.0.0.1:8808', 'ECONNREFUSED'))).toContain(
      'http://127.0.0.1:8808',
    );
  });
});
