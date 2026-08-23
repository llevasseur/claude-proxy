import type { UsageTotals } from "./types.ts";

// Normalizer mechanics ported from codex-proxy `packages/core/src/usage.ts`.
export class UsageValidationError extends Error {
  override readonly name = "UsageValidationError";
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
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

// The two wire contracts spell the same five counts differently, so the field
// names are all that differs — the invariants below hold for both.
interface TokenFieldNames {
  readonly input: string;
  readonly output: string;
  readonly inputDetails: string;
  readonly outputDetails: string;
}

function normalizeUsage(value: unknown, fields: TokenFieldNames): UsageTotals {
  const usage = record(value, "usage");
  const inputTokens = tokenCount(usage[fields.input], `usage.${fields.input}`);
  const outputTokens = tokenCount(usage[fields.output], `usage.${fields.output}`);
  const totalTokens = tokenCount(usage.total_tokens, "usage.total_tokens");
  const inputDetails =
    usage[fields.inputDetails] === undefined
      ? {}
      : record(usage[fields.inputDetails], `usage.${fields.inputDetails}`);
  const outputDetails =
    usage[fields.outputDetails] === undefined
      ? {}
      : record(usage[fields.outputDetails], `usage.${fields.outputDetails}`);
  const cachedInputTokens = optionalTokenCount(
    inputDetails,
    "cached_tokens",
    `usage.${fields.inputDetails}`,
  );
  const reasoningOutputTokens = optionalTokenCount(
    outputDetails,
    "reasoning_tokens",
    `usage.${fields.outputDetails}`,
  );

  if (cachedInputTokens > inputTokens) {
    throw new UsageValidationError("cached input tokens cannot exceed input tokens");
  }
  if (reasoningOutputTokens > outputTokens) {
    throw new UsageValidationError("reasoning output tokens cannot exceed output tokens");
  }
  if (totalTokens !== inputTokens + outputTokens) {
    throw new UsageValidationError("total tokens must equal input tokens plus output tokens");
  }

  return Object.freeze({
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  });
}

export function normalizeResponsesUsage(value: unknown): UsageTotals {
  return normalizeUsage(value, {
    input: "input_tokens",
    output: "output_tokens",
    inputDetails: "input_tokens_details",
    outputDetails: "output_tokens_details",
  });
}

// OpenAI-compatible chat/completions usage (ADR 0012). Same five counts under
// the older prompt/completion names.
export function normalizeChatCompletionsUsage(value: unknown): UsageTotals {
  return normalizeUsage(value, {
    input: "prompt_tokens",
    output: "completion_tokens",
    inputDetails: "prompt_tokens_details",
    outputDetails: "completion_tokens_details",
  });
}
