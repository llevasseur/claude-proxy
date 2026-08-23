import { addUsdAmounts } from './pricing.ts';
import {
  DEFAULT_REPORT_TIMEZONE,
  formatReportDate,
  getCalendarDayWindow,
  getTodayWindow,
  parseCalendarDate,
} from './today.ts';
import type { CostUnavailableReason, PricedCost, SanitizedAuditSidecarV1, UsageTotals } from './types.ts';

export interface ResolvedCalendarRange {
  readonly reportTimezone: string;
  readonly startInclusive: Date | null;
  readonly endExclusive: Date;
}

export interface UsageSummary {
  readonly requestCount: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
  readonly latestEventTimestamp: string | null;
  readonly cost: PricedCost | null;
  readonly costUnavailableReason: CostUnavailableReason | null;
}

export interface DailyUsageBucket extends UsageSummary {
  readonly reportTimezone: string;
  readonly date: string;
  readonly startInclusive: string;
  readonly endExclusive: string;
}

export type ModelFilterPredicate = (model: string) => boolean;

interface SummableUsage {
  readonly requestCount: number;
  readonly usage: UsageTotals;
  readonly timestamp: string | null;
  readonly cost: PricedCost | null;
  readonly costUnavailableReason: CostUnavailableReason | null;
}

function summarize(items: readonly SummableUsage[]): UsageSummary {
  let requestCount = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let reasoningOutputTokens = 0;
  let totalTokens = 0;
  let latestEventTimestamp: string | null = null;
  const amounts: string[] = [];
  let costUnavailableReason: CostUnavailableReason | null = null;
  for (const item of items) {
    requestCount += item.requestCount;
    inputTokens += item.usage.inputTokens;
    cachedInputTokens += item.usage.cachedInputTokens;
    outputTokens += item.usage.outputTokens;
    reasoningOutputTokens += item.usage.reasoningOutputTokens;
    totalTokens += item.usage.totalTokens;
    if (item.timestamp !== null && (latestEventTimestamp === null || item.timestamp > latestEventTimestamp)) {
      latestEventTimestamp = item.timestamp;
    }
    if (item.cost === null) {
      if (costUnavailableReason === null) {
        costUnavailableReason = Object.freeze({
          code: 'aggregate-incomplete',
          detail: item.costUnavailableReason?.code ?? 'unknown cost',
        });
      }
    } else {
      amounts.push(item.cost.amountUsd);
    }
  }
  return Object.freeze({
    requestCount,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    latestEventTimestamp,
    cost:
      costUnavailableReason === null
        ? Object.freeze({ currency: 'USD', amountUsd: addUsdAmounts(amounts), catalogueVersion: 'aggregate' })
        : null,
    costUnavailableReason,
  });
}

export function resolveCalendarRange(
  from: string | null,
  to: string | null,
  now: Date,
  timeZone = DEFAULT_REPORT_TIMEZONE,
): ResolvedCalendarRange {
  if (Number.isNaN(now.getTime())) throw new RangeError('now must be a valid Date');
  if (to !== null) parseCalendarDate(to);
  const endExclusive = to === null ? getTodayWindow(now, timeZone).end : getCalendarDayWindow(to, timeZone).end;
  const startInclusive = from === null ? null : getCalendarDayWindow(from, timeZone).start;
  if (startInclusive !== null && startInclusive.getTime() >= endExclusive.getTime()) {
    throw new RangeError('calendar range start must precede its end');
  }
  return Object.freeze({ reportTimezone: timeZone, startInclusive, endExclusive });
}

export function aggregateDailyBuckets(
  events: readonly SanitizedAuditSidecarV1[],
  from: string | null,
  to: string | null,
  now: Date,
  timeZone = DEFAULT_REPORT_TIMEZONE,
): readonly DailyUsageBucket[] {
  const range = resolveCalendarRange(from, to, now, timeZone);
  const endMs = range.endExclusive.getTime();
  const startMs = range.startInclusive?.getTime() ?? null;
  const included = events.filter((event) => {
    const timestamp = Date.parse(event.timestamp);
    if (Number.isNaN(timestamp)) throw new RangeError(`sidecar timestamp is not a valid instant: ${event.timestamp}`);
    if (timestamp >= endMs) return false;
    return startMs === null || timestamp >= startMs;
  });
  const grouped = new Map<string, SanitizedAuditSidecarV1[]>();
  for (const event of included) {
    const date = formatReportDate(Date.parse(event.timestamp), timeZone);
    const bucket = grouped.get(date);
    if (bucket) bucket.push(event);
    else grouped.set(date, [event]);
  }
  if (included.length === 0 && startMs === null) return [];
  let firstDate =
    startMs === null
      ? [...grouped.keys()].reduce((earliest, date) => (date < earliest ? date : earliest))
      : formatReportDate(startMs, timeZone);
  const lastDate = formatReportDate(endMs - 1, timeZone);
  const buckets: DailyUsageBucket[] = [];
  while (firstDate <= lastDate) {
    const window = getCalendarDayWindow(firstDate, timeZone);
    buckets.push(
      Object.freeze({
        reportTimezone: timeZone,
        date: firstDate,
        startInclusive: window.start.toISOString(),
        endExclusive: window.end.toISOString(),
        ...summarize(
          (grouped.get(firstDate) ?? []).map((event) => ({
            requestCount: 1,
            usage: event.usage,
            timestamp: event.timestamp,
            cost: event.cost,
            costUnavailableReason: event.costUnavailableReason,
          })),
        ),
      }),
    );
    firstDate = nextCalendarDate(firstDate);
  }
  return Object.freeze(buckets);
}

export function aggregateRangeFromBuckets(buckets: readonly DailyUsageBucket[]): UsageSummary {
  return summarize(
    buckets.map((bucket) => ({
      requestCount: bucket.requestCount,
      usage: {
        inputTokens: bucket.inputTokens,
        cachedInputTokens: bucket.cachedInputTokens,
        outputTokens: bucket.outputTokens,
        reasoningOutputTokens: bucket.reasoningOutputTokens,
        totalTokens: bucket.totalTokens,
      },
      timestamp: bucket.latestEventTimestamp,
      cost: bucket.cost,
      costUnavailableReason: bucket.costUnavailableReason,
    })),
  );
}

export function modelFilter(models: readonly string[]): ModelFilterPredicate {
  const selected = new Set(models);
  if (selected.size === 0) return () => true;
  return (model) => selected.has(model);
}

export function selectByModels<T extends { readonly model: string }>(
  records: readonly T[],
  models: readonly string[],
): readonly T[] {
  const matches = modelFilter(models);
  return records.filter((record) => matches(record.model));
}

function nextCalendarDate(date: string): string {
  const { year, month, day } = parseCalendarDate(date);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return `${String(next.getUTCFullYear()).padStart(4, '0')}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(
    next.getUTCDate(),
  ).padStart(2, '0')}`;
}
