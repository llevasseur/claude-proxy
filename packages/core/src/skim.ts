import { isAuditSidecar, type AuditSidecar, type AuditSkim } from "./types.js";
import { priceFor } from "./pricing.js";

export interface SkimShape {
  cacheKey: string;
  /** Latest user-authored text from a request with this shape, when its request log is available. */
  requestText: string | null;
  /** The populating miss plus every hit. */
  requests: number;
  /** How many of those were served from cache. */
  hits: number;
  /** Sum of `savedInputTokens` across this key's hits. */
  savedInputTokens: number;
  /** Estimated USD saved at each model's input-token rate. */
  estSavedUsd: number;
}

export interface SkimDigest {
  date: string;
  /** Valid sidecars considered. */
  requestCount: number;
  /** Requests in the hit/miss denominator. */
  enabledRequests: number;
  /** Replies replayed from cache (zero upstream call). */
  hits: number;
  /** Enabled requests that still went upstream. */
  misses: number;
  /** Hits divided by enabled requests; 0 without enabled traffic. */
  hitRate: number;
  /** realInput tokens avoided across all hits. */
  savedInputTokens: number;
  /** Estimated USD saved at each model's input-token rate. */
  estSavedUsd: number;
  /** Most-repeated request shapes, ranked by request count. */
  topShapes: SkimShape[];
}

export interface ComputeSkimDigestOptions {
  /** Digest date in YYYY-MM-DD format. */
  date: string;
  /** Maximum `topShapes` entries. Defaults to 12. */
  topN?: number;
}

const NO_SKIM: AuditSkim = { enabled: false, servedFromCache: false, savedInputTokens: 0, cacheKey: null };

/** Read legacy or malformed skim blocks with safe defaults. */
function skimOf(sidecar: AuditSidecar): AuditSkim {
  const raw = (sidecar as { skim?: unknown }).skim;
  if (typeof raw !== "object" || raw === null) return NO_SKIM;
  const s = raw as Record<string, unknown>;
  return {
    enabled: s.enabled === true,
    servedFromCache: s.servedFromCache === true,
    savedInputTokens: typeof s.savedInputTokens === "number" ? s.savedInputTokens : 0,
    cacheKey: typeof s.cacheKey === "string" ? s.cacheKey : null,
  };
}

function savedUsd(tokens: number, model: string): number {
  return (tokens / 1_000_000) * priceFor(model).input;
}

/**
 * Aggregate a day's audit sidecars, skipping malformed entries and treating
 * legacy sidecars as skim-disabled traffic.
 */
export function computeSkimDigest(
  sidecars: readonly unknown[],
  opts: ComputeSkimDigestOptions,
): SkimDigest {
  const topN = opts.topN ?? 12;
  const valid: AuditSidecar[] = [];
  for (const s of sidecars) if (isAuditSidecar(s)) valid.push(s);

  let hits = 0;
  let misses = 0;
  let savedInputTokens = 0;
  let estSavedUsd = 0;
  const shapes = new Map<string, { requestText: string | null; requests: number; hits: number; savedInputTokens: number; estSavedUsd: number }>();

  for (const s of valid) {
    const skim = skimOf(s);
    if (skim.servedFromCache) {
      hits += 1;
      savedInputTokens += skim.savedInputTokens;
      estSavedUsd += savedUsd(skim.savedInputTokens, s.model);
    } else if (skim.enabled) {
      misses += 1;
    }

    if (skim.cacheKey) {
      const requestText = typeof (s as unknown as { skimRequestText?: unknown }).skimRequestText === "string"
        ? (s as unknown as { skimRequestText: string }).skimRequestText
        : null;
      const acc = shapes.get(skim.cacheKey) ?? { requestText, requests: 0, hits: 0, savedInputTokens: 0, estSavedUsd: 0 };
      if (!acc.requestText && requestText) acc.requestText = requestText;
      acc.requests += 1;
      if (skim.servedFromCache) {
        acc.hits += 1;
        acc.savedInputTokens += skim.savedInputTokens;
        acc.estSavedUsd += savedUsd(skim.savedInputTokens, s.model);
      }
      shapes.set(skim.cacheKey, acc);
    }
  }

  const enabledRequests = hits + misses;
  const topShapes: SkimShape[] = [...shapes.entries()]
    .map(([cacheKey, v]) => ({ cacheKey, ...v }))
    .sort((a, b) => b.requests - a.requests || b.hits - a.hits)
    .slice(0, topN);

  return {
    date: opts.date,
    requestCount: valid.length,
    enabledRequests,
    hits,
    misses,
    hitRate: enabledRequests > 0 ? hits / enabledRequests : 0,
    savedInputTokens,
    estSavedUsd,
    topShapes,
  };
}

function dayOf(sidecar: AuditSidecar): string {
  return sidecar.timestamp.slice(0, 10);
}

/** Build daily UTC digests, oldest first. */
export function skimDigestsByDay(sidecars: readonly unknown[], topN?: number): SkimDigest[] {
  const byDay = new Map<string, unknown[]>();
  for (const s of sidecars) {
    if (!isAuditSidecar(s)) continue;
    const day = dayOf(s);
    const bucket = byDay.get(day) ?? [];
    bucket.push(s);
    byDay.set(day, bucket);
  }
  return [...byDay.keys()]
    .sort()
    .map((day) => computeSkimDigest(byDay.get(day)!, { date: day, topN }));
}
