import { describe, expect, it } from 'vitest';
import { parseSanitizedAuditSidecar, SANITIZED_AUDIT_SIDECAR_SCHEMA_VERSION } from '../src/sidecar.ts';
import type { SanitizedAuditSidecarV1 } from '../src/types.ts';

const validUsage = {
  inputTokens: 100,
  cachedInputTokens: 40,
  outputTokens: 50,
  reasoningOutputTokens: 20,
  totalTokens: 150,
};
const validCost = {
  currency: 'USD' as const,
  amountUsd: '0.625000',
  catalogueVersion: '2025-08-07',
};

const valid: Record<string, unknown> = {
  schemaVersion: 1,
  recordId: 'record-1',
  timestamp: '2026-03-08T05:30:00.000Z',
  model: 'gpt-5',
  endpoint: '/v1/responses',
  responseStatus: 200,
  requestId: 'req_1',
  usage: validUsage,
  cost: validCost,
  costUnavailableReason: null,
};

describe('parseSanitizedAuditSidecar', () => {
  it('accepts a complete priced sidecar', () => {
    expect(parseSanitizedAuditSidecar(valid)).toMatchObject({
      recordId: 'record-1',
      model: 'gpt-5',
    });
  });

  it('accepts an unpriced sidecar with a typed reason', () => {
    const unpriced = {
      ...valid,
      cost: null,
      costUnavailableReason: { code: 'unknown-model', model: 'gpt-9-future' },
    };
    expect(parseSanitizedAuditSidecar(unpriced).cost).toBeNull();
  });

  it('rejects unknown top-level fields', () => {
    expect(() => parseSanitizedAuditSidecar({ ...valid, prompt: 'leak' })).toThrow(/unknown field prompt/);
  });

  it('rejects unknown nested fields in usage and cost', () => {
    expect(() =>
      parseSanitizedAuditSidecar({
        ...valid,
        usage: { ...validUsage, input_tokens_details: { cached_tokens: 40 } },
      }),
    ).toThrow(/unknown field/);
    expect(() => parseSanitizedAuditSidecar({ ...valid, cost: { ...validCost, currencyExtra: 1 } })).toThrow(
      /unknown field/,
    );
  });

  it('rejects missing required fields', () => {
    const { requestId: _omitted, ...missingRequestId } = valid;
    expect(() => parseSanitizedAuditSidecar(missingRequestId)).toThrow(/missing field/);
  });

  it('rejects unsupported schema versions', () => {
    expect(() => parseSanitizedAuditSidecar({ ...valid, schemaVersion: 2 })).toThrow(/schemaVersion is unsupported/);
    expect(SANITIZED_AUDIT_SIDECAR_SCHEMA_VERSION).toBe(1);
  });

  it('requires exactly one of cost and costUnavailableReason', () => {
    expect(() =>
      parseSanitizedAuditSidecar({
        ...valid,
        costUnavailableReason: { code: 'unknown-model', model: 'm' },
      }),
    ).toThrow(/exactly one of/);
    expect(() => parseSanitizedAuditSidecar({ ...valid, cost: null })).toThrow(/exactly one of/);
  });

  it('validates the timestamp as ISO UTC only', () => {
    expect(() => parseSanitizedAuditSidecar({ ...valid, timestamp: '2026-03-08T01:30:00-04:00' })).toThrow(/timestamp/);
    expect(() => parseSanitizedAuditSidecar({ ...valid, timestamp: 'not-a-time' })).toThrow(/timestamp/);
  });

  it('requires endpoint to be a pathname without query or body slot', () => {
    expect(() => parseSanitizedAuditSidecar({ ...valid, endpoint: 'v1/responses' })).toThrow(/endpoint/);
    expect(parseSanitizedAuditSidecar({ ...valid, endpoint: '/v1/responses?x=1' }).endpoint).toBe('/v1/responses?x=1');
  });

  it('bounds responseStatus to valid HTTP codes', () => {
    expect(() => parseSanitizedAuditSidecar({ ...valid, responseStatus: 99 })).toThrow(/responseStatus/);
    expect(() => parseSanitizedAuditSidecar({ ...valid, responseStatus: 600 })).toThrow(/responseStatus/);
  });

  it('allows requestId to be null but not empty', () => {
    expect(parseSanitizedAuditSidecar({ ...valid, requestId: null }).requestId).toBeNull();
    expect(() => parseSanitizedAuditSidecar({ ...valid, requestId: '' })).toThrow(/requestId/);
  });

  it('enforces detail-subset and total invariants on stored usage', () => {
    expect(() =>
      parseSanitizedAuditSidecar({
        ...valid,
        usage: { ...validUsage, cachedInputTokens: 101 },
      }),
    ).toThrow(/detail cannot exceed/);
    expect(() => parseSanitizedAuditSidecar({ ...valid, usage: { ...validUsage, totalTokens: 999 } })).toThrow(
      /totalTokens/,
    );
  });

  it('validates typed unavailable reasons strictly', () => {
    const badCategory = {
      ...valid,
      cost: null,
      costUnavailableReason: { code: 'missing-category-price', model: 'm', category: 'bogus' },
    };
    expect(() => parseSanitizedAuditSidecar(badCategory)).toThrow(/category is invalid/);
    const extraField = {
      ...valid,
      cost: null,
      costUnavailableReason: { code: 'aggregate-incomplete', detail: 'd', extra: 1 },
    };
    expect(() => parseSanitizedAuditSidecar(extraField)).toThrow(/unknown field/);
  });

  it('returns a frozen value matching the v1 shape', () => {
    const parsed: SanitizedAuditSidecarV1 = parseSanitizedAuditSidecar(valid);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.usage)).toBe(true);
    expect(Object.keys(parsed).sort()).toEqual([
      'cost',
      'costUnavailableReason',
      'endpoint',
      'model',
      'recordId',
      'requestId',
      'responseStatus',
      'schemaVersion',
      'timestamp',
      'usage',
    ]);
  });
});
