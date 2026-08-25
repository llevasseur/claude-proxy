import type { UsageTotals } from './types.ts';

export class UsageValidationError extends Error {
  override readonly name = 'UsageValidationError';
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UsageValidationError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function tokenCount(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new UsageValidationError(`${path} must be a non-negative safe integer`);
  }
  return value as number;
}

function optionalTokenCount(container: Record<string, unknown>, key: string, path: string): number {
  const value = container[key];
  return value === undefined ? 0 : tokenCount(value, `${path}.${key}`);
}

export function normalizeResponsesUsage(value: unknown): UsageTotals {
  const usage = record(value, 'usage');
  const inputTokens = tokenCount(usage.input_tokens, 'usage.input_tokens');
  const outputTokens = tokenCount(usage.output_tokens, 'usage.output_tokens');
  const totalTokens = tokenCount(usage.total_tokens, 'usage.total_tokens');
  const inputDetails =
    usage.input_tokens_details === undefined ? {} : record(usage.input_tokens_details, 'usage.input_tokens_details');
  const outputDetails =
    usage.output_tokens_details === undefined ? {} : record(usage.output_tokens_details, 'usage.output_tokens_details');
  const cachedInputTokens = optionalTokenCount(inputDetails, 'cached_tokens', 'usage.input_tokens_details');
  const reasoningOutputTokens = optionalTokenCount(outputDetails, 'reasoning_tokens', 'usage.output_tokens_details');

  if (cachedInputTokens > inputTokens) {
    throw new UsageValidationError('cached input tokens cannot exceed input tokens');
  }
  if (reasoningOutputTokens > outputTokens) {
    throw new UsageValidationError('reasoning output tokens cannot exceed output tokens');
  }
  if (totalTokens !== inputTokens + outputTokens) {
    throw new UsageValidationError('total tokens must equal input tokens plus output tokens');
  }

  return Object.freeze({ inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens });
}
