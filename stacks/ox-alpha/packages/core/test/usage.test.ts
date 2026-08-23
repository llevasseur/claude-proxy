import { describe, expect, it } from 'vitest';
import { normalizeChatCompletionsUsage, normalizeResponsesUsage } from '../src/usage.ts';

describe('normalizeResponsesUsage', () => {
  it('normalizes a full Responses usage object', () => {
    expect(
      normalizeResponsesUsage({
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        input_tokens_details: { cached_tokens: 40 },
        output_tokens_details: { reasoning_tokens: 20 },
      }),
    ).toEqual({
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 50,
      reasoningOutputTokens: 20,
      totalTokens: 150,
    });
  });

  it('defaults missing details to zero', () => {
    expect(normalizeResponsesUsage({ input_tokens: 10, output_tokens: 5, total_tokens: 15 })).toEqual({
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
      reasoningOutputTokens: 0,
      totalTokens: 15,
    });
  });

  it('rejects non-integer or negative counts', () => {
    for (const bad of [-1, 1.5, '10', null]) {
      expect(() => normalizeResponsesUsage({ input_tokens: bad, output_tokens: 1, total_tokens: 11 })).toThrow();
    }
  });

  it('rejects detail exceeding its headline category', () => {
    expect(() =>
      normalizeResponsesUsage({
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 11 },
      }),
    ).toThrow(/cached input tokens cannot exceed input tokens/);
    expect(() =>
      normalizeResponsesUsage({
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        output_tokens_details: { reasoning_tokens: 6 },
      }),
    ).toThrow(/reasoning output tokens cannot exceed output tokens/);
  });

  it('keeps a detail exactly equal to its headline valid', () => {
    expect(
      normalizeResponsesUsage({
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 10 },
        output_tokens_details: { reasoning_tokens: 5 },
      }),
    ).toMatchObject({ cachedInputTokens: 10, reasoningOutputTokens: 5 });
  });

  it('rejects totals that disagree with input plus output', () => {
    expect(() => normalizeResponsesUsage({ input_tokens: 10, output_tokens: 5, total_tokens: 16 })).toThrow(
      /total tokens/,
    );
  });

  it('returns a frozen value', () => {
    const usage = normalizeResponsesUsage({ input_tokens: 1, output_tokens: 1, total_tokens: 2 });
    expect(Object.isFrozen(usage)).toBe(true);
  });
});

describe('normalizeChatCompletionsUsage', () => {
  it('normalizes a usage block as returned by opencode zen', () => {
    expect(
      normalizeChatCompletionsUsage({
        prompt_tokens: 89,
        completion_tokens: 23,
        total_tokens: 112,
        prompt_tokens_details: { cached_tokens: 64 },
        completion_tokens_details: { reasoning_tokens: 9 },
      }),
    ).toEqual({
      inputTokens: 89,
      cachedInputTokens: 64,
      outputTokens: 23,
      reasoningOutputTokens: 9,
      totalTokens: 112,
    });
  });

  it('defaults missing details to zero', () => {
    expect(
      normalizeChatCompletionsUsage({
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      }),
    ).toEqual({
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
      reasoningOutputTokens: 0,
      totalTokens: 15,
    });
  });

  it('rejects non-integer or negative counts', () => {
    for (const bad of [-1, 1.5, '10', null]) {
      expect(() =>
        normalizeChatCompletionsUsage({
          prompt_tokens: bad,
          completion_tokens: 1,
          total_tokens: 11,
        }),
      ).toThrow();
    }
  });

  it('applies the same invariants as the Responses normalizer', () => {
    expect(() =>
      normalizeChatCompletionsUsage({
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 11 },
      }),
    ).toThrow(/cached input tokens cannot exceed input tokens/);
    expect(() =>
      normalizeChatCompletionsUsage({
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 16,
      }),
    ).toThrow(/total tokens/);
  });

  it('rejects a non-object usage value', () => {
    expect(() => normalizeChatCompletionsUsage(undefined)).toThrow(/usage must be an object/);
  });
});
