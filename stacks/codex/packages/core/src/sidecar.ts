import type { CostUnavailableReason, PricedCost, SanitizedAuditSidecarV1, UsageTotals } from './types.ts';

const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'recordId',
  'timestamp',
  'model',
  'endpoint',
  'responseStatus',
  'requestId',
  'usage',
  'cost',
  'costUnavailableReason',
] as const;
const USAGE_KEYS = [
  'inputTokens',
  'cachedInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
  'totalTokens',
] as const;

export const SANITIZED_AUDIT_SIDECAR_SCHEMA_VERSION = 1 as const;
export const SANITIZED_AUDIT_SIDECAR_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://codex-proxy.local/schema/sanitized-audit-sidecar-v1.json',
  title: 'codex-proxy sanitized audit sidecar v1',
  type: 'object',
  additionalProperties: false,
  required: TOP_LEVEL_KEYS,
  properties: {
    schemaVersion: { const: 1 },
    recordId: { type: 'string', minLength: 1 },
    timestamp: { type: 'string', format: 'date-time' },
    model: { type: 'string', minLength: 1 },
    endpoint: { type: 'string', pattern: '^/' },
    responseStatus: { type: 'integer', minimum: 100, maximum: 599 },
    requestId: { type: ['string', 'null'], minLength: 1 },
    usage: {
      type: 'object',
      additionalProperties: false,
      required: USAGE_KEYS,
      properties: {
        inputTokens: { type: 'integer', minimum: 0 },
        cachedInputTokens: { type: 'integer', minimum: 0 },
        outputTokens: { type: 'integer', minimum: 0 },
        reasoningOutputTokens: { type: 'integer', minimum: 0 },
        totalTokens: { type: 'integer', minimum: 0 },
      },
    },
    cost: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['currency', 'amountUsd', 'catalogueVersion'],
      properties: {
        currency: { const: 'USD' },
        amountUsd: { type: 'string', pattern: '^\\d+(?:\\.\\d{1,12})?$' },
        catalogueVersion: { type: 'string', minLength: 1 },
      },
    },
    costUnavailableReason: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'model'],
          properties: { code: { const: 'unknown-model' }, model: { type: 'string', minLength: 1 } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'model', 'category'],
          properties: {
            code: { const: 'missing-category-price' },
            model: { type: 'string', minLength: 1 },
            category: { enum: ['input', 'cachedInput', 'output', 'reasoningOutput'] },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'detail'],
          properties: { code: { const: 'aggregate-incomplete' }, detail: { type: 'string', minLength: 1 } },
        },
      ],
    },
  },
  oneOf: [
    { properties: { cost: { type: 'object' }, costUnavailableReason: { type: 'null' } } },
    { properties: { cost: { type: 'null' }, costUnavailableReason: { type: 'object' } } },
  ],
});

export class SidecarValidationError extends Error {
  override readonly name = 'SidecarValidationError';
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SidecarValidationError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !(key in value));
  if (unknown.length > 0) throw new SidecarValidationError(`${path} contains unknown field ${unknown[0]}`);
  if (missing.length > 0) throw new SidecarValidationError(`${path} is missing field ${missing[0]}`);
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new SidecarValidationError(`${path} must be a non-empty string`);
  return value;
}

function count(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SidecarValidationError(`${path} must be a non-negative safe integer`);
  }
  return value as number;
}

function parseUsage(value: unknown): UsageTotals {
  const usage = object(value, 'sidecar.usage');
  exactKeys(usage, USAGE_KEYS, 'sidecar.usage');
  const result = {
    inputTokens: count(usage.inputTokens, 'sidecar.usage.inputTokens'),
    cachedInputTokens: count(usage.cachedInputTokens, 'sidecar.usage.cachedInputTokens'),
    outputTokens: count(usage.outputTokens, 'sidecar.usage.outputTokens'),
    reasoningOutputTokens: count(usage.reasoningOutputTokens, 'sidecar.usage.reasoningOutputTokens'),
    totalTokens: count(usage.totalTokens, 'sidecar.usage.totalTokens'),
  };
  if (result.cachedInputTokens > result.inputTokens || result.reasoningOutputTokens > result.outputTokens) {
    throw new SidecarValidationError('sidecar usage detail cannot exceed its headline total');
  }
  if (result.totalTokens !== result.inputTokens + result.outputTokens) {
    throw new SidecarValidationError('sidecar totalTokens must equal inputTokens plus outputTokens');
  }
  return Object.freeze(result);
}

function parseCost(value: unknown): PricedCost | null {
  if (value === null) return null;
  const cost = object(value, 'sidecar.cost');
  exactKeys(cost, ['currency', 'amountUsd', 'catalogueVersion'], 'sidecar.cost');
  if (cost.currency !== 'USD') throw new SidecarValidationError('sidecar.cost.currency must be USD');
  const amountUsd = string(cost.amountUsd, 'sidecar.cost.amountUsd');
  if (!/^\d+(?:\.\d{1,12})?$/.test(amountUsd)) throw new SidecarValidationError('sidecar.cost.amountUsd is invalid');
  return Object.freeze({
    currency: 'USD',
    amountUsd,
    catalogueVersion: string(cost.catalogueVersion, 'sidecar.cost.catalogueVersion'),
  });
}

function parseReason(value: unknown): CostUnavailableReason | null {
  if (value === null) return null;
  const reason = object(value, 'sidecar.costUnavailableReason');
  if (reason.code === 'unknown-model') {
    exactKeys(reason, ['code', 'model'], 'sidecar.costUnavailableReason');
    return Object.freeze({ code: 'unknown-model', model: string(reason.model, 'sidecar.costUnavailableReason.model') });
  }
  if (reason.code === 'missing-category-price') {
    exactKeys(reason, ['code', 'model', 'category'], 'sidecar.costUnavailableReason');
    if (!['input', 'cachedInput', 'output', 'reasoningOutput'].includes(String(reason.category))) {
      throw new SidecarValidationError('sidecar.costUnavailableReason.category is invalid');
    }
    return Object.freeze({
      code: 'missing-category-price',
      model: string(reason.model, 'sidecar.costUnavailableReason.model'),
      category: reason.category as 'input' | 'cachedInput' | 'output' | 'reasoningOutput',
    });
  }
  if (reason.code === 'aggregate-incomplete') {
    exactKeys(reason, ['code', 'detail'], 'sidecar.costUnavailableReason');
    return Object.freeze({
      code: 'aggregate-incomplete',
      detail: string(reason.detail, 'sidecar.costUnavailableReason.detail'),
    });
  }
  throw new SidecarValidationError('sidecar.costUnavailableReason.code is invalid');
}

export function parseSanitizedAuditSidecar(value: unknown): SanitizedAuditSidecarV1 {
  const sidecar = object(value, 'sidecar');
  exactKeys(sidecar, TOP_LEVEL_KEYS, 'sidecar');
  if (sidecar.schemaVersion !== SANITIZED_AUDIT_SIDECAR_SCHEMA_VERSION) {
    throw new SidecarValidationError('sidecar.schemaVersion is unsupported');
  }
  const timestamp = string(sidecar.timestamp, 'sidecar.timestamp');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    throw new SidecarValidationError('sidecar.timestamp must be an ISO UTC timestamp');
  }
  const endpoint = string(sidecar.endpoint, 'sidecar.endpoint');
  if (!endpoint.startsWith('/')) throw new SidecarValidationError('sidecar.endpoint must start with /');
  const responseStatus = count(sidecar.responseStatus, 'sidecar.responseStatus');
  if (responseStatus < 100 || responseStatus > 599)
    throw new SidecarValidationError('sidecar.responseStatus is invalid');
  const requestId = sidecar.requestId === null ? null : string(sidecar.requestId, 'sidecar.requestId');
  const cost = parseCost(sidecar.cost);
  const costUnavailableReason = parseReason(sidecar.costUnavailableReason);
  if ((cost === null) === (costUnavailableReason === null)) {
    throw new SidecarValidationError('sidecar must contain exactly one of cost or costUnavailableReason');
  }
  return Object.freeze({
    schemaVersion: 1,
    recordId: string(sidecar.recordId, 'sidecar.recordId'),
    timestamp,
    model: string(sidecar.model, 'sidecar.model'),
    endpoint,
    responseStatus,
    requestId,
    usage: parseUsage(sidecar.usage),
    cost,
    costUnavailableReason,
  });
}
