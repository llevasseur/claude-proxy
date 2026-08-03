/**
 * Why `avgSystemPromptBytes` is what it is, and why it moved.
 *
 * The daily figure is an unweighted mean over every request in the day, so it
 * tracks two independent things at once: how big each kind of prompt is, and
 * how much traffic each kind got. A mean can move a long way with no prompt
 * changing size at all. Splitting requests into cohorts — one per distinct
 * system prompt — separates the two.
 */

import { reportDay } from './time.js';
import { type AuditSidecar, isAuditSidecar } from './types.js';

/** Requests in a day that shared one system prompt. */
export interface PromptCohort {
  /** Stable grouping key: the captured hash, else `legacy:<model>:<band>`. */
  key: string;
  label: string;
  /** True when the cohort is a real prompt hash rather than a size-band guess. */
  identified: boolean;
  hash: string | null;
  /** Models seen sending this prompt, most requests first. */
  models: string[];
  requests: number;
  /** Fraction of the day's requests, 0–1. */
  share: number;
  /** Exact mean, unrounded — the day's mean is the sum of the contributions. */
  meanBytes: number;
  totalBytes: number;
  /** `share × meanBytes`: this cohort's share of the day's mean. */
  contribution: number;
}

/** One day's system-prompt traffic, decomposed into cohorts. */
export interface PromptMixDay {
  date: string;
  requests: number;
  /** Rounds to the digest's `avgSystemPromptBytes`. */
  meanBytes: number;
  /** Immune to the heavy tail the mean chases — a flat median means no prompt grew. */
  medianBytes: number;
  /** Fraction of requests carrying a captured hash; the rest fell back to bands. */
  identifiedShare: number;
  /** Largest contribution first. */
  cohorts: PromptCohort[];
}

/** Coarse size bands, wide enough that a prompt drifting a few KB stays put. */
const BANDS: { max: number; label: string }[] = [
  { max: 1_000, label: '<1 KB' },
  { max: 8_000, label: '1–8 KB' },
  { max: 32_000, label: '8–32 KB' },
  { max: 128_000, label: '32–128 KB' },
  { max: Number.POSITIVE_INFINITY, label: '128 KB+' },
];

function band(bytes: number): { max: number; label: string } {
  return BANDS.find((b) => bytes < b.max) ?? BANDS[BANDS.length - 1]!;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

interface Bucket {
  key: string;
  hash: string | null;
  label: string;
  models: Map<string, number>;
  bytes: number[];
}

function bucketFor(s: AuditSidecar): { key: string; hash: string | null; label: string } {
  const hash = s.request.system?.hash ?? null;
  if (hash) return { key: hash, hash, label: `${s.model} · ${hash.slice(0, 8)}` };
  const b = band(s.request.systemBytes);
  return { key: `legacy:${s.model}:${b.label}`, hash: null, label: `${s.model} · ${b.label}` };
}

/**
 * Group one day's sidecars into cohorts. Sidecars written before the capture
 * existed have no hash, so they fall back to model plus a size band — coarser,
 * but enough to keep genuinely different prompts apart in historical data.
 *
 * Malformed entries are skipped exactly as `computeDigest` skips them, so the
 * mean here is over the same population as `avgSystemPromptBytes`.
 */
export function summarizePromptMix(sidecars: readonly unknown[], date: string): PromptMixDay {
  const buckets = new Map<string, Bucket>();
  const allBytes: number[] = [];
  let identified = 0;

  for (const s of sidecars) {
    if (!isAuditSidecar(s)) continue;
    const { key, hash, label } = bucketFor(s);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, hash, label, models: new Map(), bytes: [] };
      buckets.set(key, bucket);
    }
    bucket.models.set(s.model, (bucket.models.get(s.model) ?? 0) + 1);
    bucket.bytes.push(s.request.systemBytes);
    allBytes.push(s.request.systemBytes);
    if (hash) identified += 1;
  }

  const requests = allBytes.length;
  const totalBytes = allBytes.reduce((a, b) => a + b, 0);
  const cohorts: PromptCohort[] = [...buckets.values()]
    .map((b) => {
      const cohortTotal = b.bytes.reduce((a, n) => a + n, 0);
      const meanBytes = cohortTotal / b.bytes.length;
      const share = b.bytes.length / requests;
      return {
        key: b.key,
        label: b.label,
        identified: b.hash !== null,
        hash: b.hash,
        models: [...b.models.entries()].sort((x, y) => y[1] - x[1]).map(([m]) => m),
        requests: b.bytes.length,
        share,
        meanBytes,
        totalBytes: cohortTotal,
        contribution: share * meanBytes,
      };
    })
    .sort((a, b) => b.contribution - a.contribution);

  return {
    date,
    requests,
    meanBytes: requests > 0 ? totalBytes / requests : 0,
    medianBytes: median(allBytes),
    identifiedShare: requests > 0 ? identified / requests : 0,
    cohorts,
  };
}

/** Bucket sidecars by report day and summarize each, oldest first. */
export function promptMixByDay(sidecars: readonly unknown[]): PromptMixDay[] {
  const days = new Map<string, AuditSidecar[]>();
  for (const s of sidecars) {
    if (!isAuditSidecar(s)) continue;
    const day = reportDay(s.timestamp);
    if (!day) continue;
    const list = days.get(day);
    if (list) list.push(s);
    else days.set(day, [s]);
  }
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => summarizePromptMix(list, date));
}

/** A model's prompt replaced by a different one between two days. */
export interface PromptRevision {
  model: string;
  /** Hash the model sent on the prior day. */
  priorHash: string;
  /** Hash it sends now. */
  hash: string;
  priorMeanBytes: number;
  meanBytes: number;
  deltaBytes: number;
}

/** Cohorts whose primary model is `model` and which carry a real hash. */
function identifiedFor(day: PromptMixDay, model: string): PromptCohort[] {
  return day.cohorts.filter((c) => c.hash !== null && c.models[0] === model);
}

/**
 * Match a model's vanished prompts against the ones that replaced them, so a
 * hash change reads as one revision rather than an unrelated add and remove.
 * Pairing is by contribution rank within the model — the best available guess,
 * since nothing on the wire says which prompt succeeded which.
 */
export function pairPromptRevisions(prior: PromptMixDay, current: PromptMixDay): PromptRevision[] {
  const before = new Set(prior.cohorts.map((c) => c.key));
  const after = new Set(current.cohorts.map((c) => c.key));
  const models = new Set([...prior.cohorts, ...current.cohorts].flatMap((c) => (c.hash ? c.models.slice(0, 1) : [])));

  const out: PromptRevision[] = [];
  for (const model of models) {
    const gone = identifiedFor(prior, model).filter((c) => !after.has(c.key));
    const fresh = identifiedFor(current, model).filter((c) => !before.has(c.key));
    for (let i = 0; i < Math.min(gone.length, fresh.length); i += 1) {
      const was = gone[i]!;
      const now = fresh[i]!;
      out.push({
        model,
        priorHash: was.hash!,
        hash: now.hash!,
        priorMeanBytes: was.meanBytes,
        meanBytes: now.meanBytes,
        deltaBytes: now.meanBytes - was.meanBytes,
      });
    }
  }
  return out.sort((a, b) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes));
}

/** One cohort's share of a day-over-day move in the mean. */
export interface CohortMove {
  key: string;
  label: string;
  share: number;
  priorShare: number;
  meanBytes: number;
  priorMeanBytes: number;
  /** Bytes of the move from this cohort taking a different share of traffic. */
  mixBytes: number;
  /** Bytes of the move from this cohort's own prompt changing size. */
  sizeBytes: number;
  /** `mixBytes + sizeBytes`. */
  deltaBytes: number;
}

/**
 * A day-over-day change in the mean, split into the two things that cause it.
 * `mixBytes + sizeBytes === deltaBytes` exactly, so the split always accounts
 * for the whole move.
 */
export interface MixAttribution {
  date: string;
  priorDate: string;
  meanBytes: number;
  priorMeanBytes: number;
  deltaBytes: number;
  /** null when the prior day's mean was zero, which no percentage describes. */
  deltaPct: number | null;
  /** Traffic shifting between prompts of different sizes. */
  mixBytes: number;
  /** Prompts themselves getting bigger or smaller. */
  sizeBytes: number;
  /** Biggest absolute mover first. */
  movers: CohortMove[];
}

/**
 * Decompose `current.meanBytes - prior.meanBytes` per cohort as
 * `Δshare × priorMean` (mix) plus `share × Δmean` (size). A cohort present on
 * only one day is pure mix, since its own prompt did not change size.
 */
export function attributePromptMix(prior: PromptMixDay, current: PromptMixDay): MixAttribution {
  const before = new Map(prior.cohorts.map((c) => [c.key, c]));
  const after = new Map(current.cohorts.map((c) => [c.key, c]));

  const movers: CohortMove[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(key);
    const now = after.get(key);
    const priorShare = was?.share ?? 0;
    const share = now?.share ?? 0;
    // A cohort seen on one day only has no size change of its own to report.
    const priorMeanBytes = was?.meanBytes ?? now?.meanBytes ?? 0;
    const meanBytes = now?.meanBytes ?? was?.meanBytes ?? 0;

    const mixBytes = (share - priorShare) * priorMeanBytes;
    const sizeBytes = share * (meanBytes - priorMeanBytes);
    movers.push({
      key,
      label: now?.label ?? was?.label ?? key,
      share,
      priorShare,
      meanBytes,
      priorMeanBytes,
      mixBytes,
      sizeBytes,
      deltaBytes: mixBytes + sizeBytes,
    });
  }
  movers.sort((a, b) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes));

  const deltaBytes = current.meanBytes - prior.meanBytes;
  return {
    date: current.date,
    priorDate: prior.date,
    meanBytes: current.meanBytes,
    priorMeanBytes: prior.meanBytes,
    deltaBytes,
    deltaPct: prior.meanBytes > 0 ? (deltaBytes / prior.meanBytes) * 100 : null,
    mixBytes: movers.reduce((a, m) => a + m.mixBytes, 0),
    sizeBytes: movers.reduce((a, m) => a + m.sizeBytes, 0),
    movers,
  };
}
