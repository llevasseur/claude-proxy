import { isAuditSidecar, type AuditSidecar, type AuditSkim } from "./types.js";
import { priceFor } from "./pricing.js";

/** One repeated request shape, identified by its byte-exact cache key. */
export interface SkimShape {
  cacheKey: string;
  /** Total requests seen for this key (the populating miss plus every hit). */
  requests: number;
  /** How many of those were served from cache. */
  hits: number;
  /** Sum of `savedInputTokens` across this key's hits. */
  savedInputTokens: number;
  /** Estimated USD saved by this key's hits (input-token rate, per model). */
  estSavedUsd: number;
}

export interface SkimDigest {
  date: string;
  /** Valid sidecars considered (malformed ones are skipped). */
  requestCount: number;
  /** Requests where the skim was enabled — the hit/miss denominator. */
  enabledRequests: number;
  /** Replies replayed from cache (zero upstream call). */
  hits: number;
  /** Enabled requests that still went upstream. */
  misses: number;
  /** hits / (hits + misses); 0 when the skim saw no enabled traffic. */
  hitRate: number;
  /** realInput tokens avoided across all hits. */
  savedInputTokens: number;
  /** Estimated USD saved, pricing each hit's saved input tokens at its model's input rate. */
  estSavedUsd: number;
  /** Most-repeated request shapes, ranked by request count. */
  topShapes: SkimShape[];
}

export interface ComputeSkimDigestOptions {
  /** Label for the digest (e.g. "2026-07-15"). */
  date: string;
  /** How many shapes to include in `topShapes`. Default 12. */
  topN?: number;
}

const NO_SKIM: AuditSkim = { enabled: false, servedFromCache: false, savedInputTokens: 0, cacheKey: null };

/** Defensively read a sidecar's skim block; tolerate old sidecars and bad fields. */
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

/** USD value of `tokens` priced at `model`'s input rate ($/MTok). */
function savedUsd(tokens: number, model: string): number {
  return (tokens / 1_000_000) * priceFor(model).input;
}

/**
 * Aggregate a day's audit sidecars into a `SkimDigest`. Pure: no I/O, no clock.
 * Malformed entries are skipped; sidecars without a `skim` block count as
 * skim-disabled traffic (neither hit nor miss).
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
  const shapes = new Map<string, { requests: number; hits: number; savedInputTokens: number; estSavedUsd: number }>();

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
      const acc = shapes.get(skim.cacheKey) ?? { requests: 0, hits: 0, savedInputTokens: 0, estSavedUsd: 0 };
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

/** The ISO timestamp's calendar day in UTC, `YYYY-MM-DD`. */
function dayOf(sidecar: AuditSidecar): string {
  return sidecar.timestamp.slice(0, 10);
}

/**
 * Split sidecars into one `SkimDigest` per calendar day (UTC), oldest→newest.
 * Handy for the hit-rate-over-time and cumulative-savings views.
 */
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
