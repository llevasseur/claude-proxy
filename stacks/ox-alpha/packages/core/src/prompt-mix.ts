import type { CaptureRequestInspection, InspectionMessage, PromptAnalysis } from './inspection.ts';

// Daily prompt traffic decomposed into cohorts sharing one system prompt
// (`packages/core/src/prompt-mix.ts` at the pinned commit), adapted to
// Responses request shape: the cohort key is the captured `instructions`
// text, hashed deterministically; requests without instructions fall back to
// coarse size bands so every request still lands somewhere.

/** Stable 64-bit FNV-1a hash as 16 lowercase hex digits. Pure, deterministic. */
export function promptHash(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/** Coarse size bands for unidentified requests, wide enough that drift stays put. */
const BANDS: readonly (readonly [number, string])[] = Object.freeze([
  [1_000, '<1 KB'],
  [8_000, '1–8 KB'],
  [32_000, '8–32 KB'],
  [128_000, '32–128 KB'],
  [Number.POSITIVE_INFINITY, '128 KB+'],
]);

function band(chars: number): string {
  return BANDS.find(([max]) => chars < max)?.[1] ?? '128 KB+';
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Requests in a day that shared one system prompt (or one size band). */
export interface PromptCohort {
  /** Stable grouping key: the instructions hash, else `band:<label>`. */
  readonly key: string;
  readonly label: string;
  /** True when the cohort is a real prompt hash rather than a size-band guess. */
  readonly identified: boolean;
  readonly hash: string | null;
  /** Models seen sending this prompt, most requests first. */
  readonly models: readonly string[];
  readonly requests: number;
  /** Fraction of the day's requests, 0–1. */
  readonly share: number;
  /** Exact mean over the cohort's total prompt characters. */
  readonly meanChars: number;
  readonly totalChars: number;
  /** share × meanChars: this cohort's share of the day's mean. */
  readonly contribution: number;
}

/** One day's system-prompt traffic, decomposed into cohorts. */
export interface PromptMixDay {
  readonly date: string;
  readonly requests: number;
  /** Unweighted mean over every request; sum of the cohort contributions. */
  readonly meanChars: number;
  readonly medianChars: number;
  /** Fraction of requests carrying instructions; the rest fell back to bands. */
  readonly identifiedShare: number;
  /** Largest contribution first. */
  readonly cohorts: readonly PromptCohort[];
}

interface MixInput {
  readonly model: string | null;
  readonly instructions: string | null;
  readonly promptChars: number;
}

export function buildPromptMix(date: string, inputs: readonly MixInput[]): PromptMixDay {
  interface Bucket {
    key: string;
    label: string;
    identified: boolean;
    hash: string | null;
    models: Map<string, number>;
    requests: number;
    totalChars: number;
  }
  const buckets = new Map<string, Bucket>();
  for (const input of inputs) {
    const identified = input.instructions !== null && input.instructions.length > 0;
    const key = identified ? (promptHash(input.instructions ?? '') as string) : `band:${band(input.promptChars)}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        key,
        // Identified cohorts are labeled by key prefix only: section bodies
        // never ride the mix surface.
        label: identified ? `prompt:${key.slice(0, 12)}` : band(input.promptChars),
        identified,
        hash: identified ? key : null,
        models: new Map(),
        requests: 0,
        totalChars: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.requests += 1;
    bucket.totalChars += input.promptChars;
    if (input.model !== null) {
      bucket.models.set(input.model, (bucket.models.get(input.model) ?? 0) + 1);
    }
  }
  const requests = inputs.length;
  const totalChars = inputs.reduce((sum, input) => sum + input.promptChars, 0);
  const identifiedCount = inputs.filter((input) => input.instructions !== null && input.instructions.length > 0).length;
  const cohorts = [...buckets.values()]
    .map((bucket) => {
      const share = requests === 0 ? 0 : bucket.requests / requests;
      const meanChars = bucket.requests === 0 ? 0 : bucket.totalChars / bucket.requests;
      return Object.freeze({
        key: bucket.key,
        label: bucket.label,
        identified: bucket.identified,
        hash: bucket.hash,
        models: Object.freeze(
          [...bucket.models.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([model]) => model),
        ),
        requests: bucket.requests,
        share,
        meanChars,
        totalChars: bucket.totalChars,
        contribution: share * meanChars,
      });
    })
    .sort((a, b) => b.contribution - a.contribution || a.key.localeCompare(b.key));
  return Object.freeze({
    date,
    requests,
    meanChars: requests === 0 ? 0 : totalChars / requests,
    medianChars: median(inputs.map((input) => input.promptChars)),
    identifiedShare: requests === 0 ? 0 : identifiedCount / requests,
    cohorts: Object.freeze(cohorts),
  });
}

// --- Sections ---

/** One addressable slice of a captured prompt: its instructions or one input message. */
export interface PromptSection {
  readonly kind: 'instructions' | 'message';
  /** Zero-based input-message index; null on the instructions section. */
  readonly index: number | null;
  readonly role: string | null;
  readonly itemType: string | null;
  readonly chars: number;
}

/**
 * Section decomposition of one captured request. Char counts only — section
 * bodies never leave the capture boundary through this surface.
 */
export function promptSections(inspection: CaptureRequestInspection): readonly PromptSection[] {
  const sections: PromptSection[] = [];
  if (inspection.instructions !== null && inspection.instructions.length > 0) {
    sections.push(
      Object.freeze({
        kind: 'instructions' as const,
        index: null,
        role: null,
        itemType: null,
        chars: inspection.instructions.length,
      }),
    );
  }
  inspection.messages.forEach((message: InspectionMessage, index: number) => {
    sections.push(
      Object.freeze({
        kind: 'message' as const,
        index,
        role: message.role,
        itemType: message.itemType,
        chars: message.text.length,
      }),
    );
  });
  return Object.freeze(sections);
}

/** Convenience wrapper pairing an analysis with its section breakdown. */
export function analyzePromptSections(
  analysis: PromptAnalysis,
  inspection: CaptureRequestInspection,
): Readonly<{
  analysis: PromptAnalysis;
  instructionsHash: string | null;
  sections: readonly PromptSection[];
}> {
  return Object.freeze({
    analysis,
    instructionsHash:
      inspection.instructions !== null && inspection.instructions.length > 0
        ? promptHash(inspection.instructions)
        : null,
    sections: promptSections(inspection),
  });
}
