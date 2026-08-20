import { addUsdAmounts } from './pricing.ts';
import type { CostUnavailableReason, SanitizedAuditSidecarV1, TodaySummary } from './types.ts';

export const DEFAULT_REPORT_TIMEZONE = 'America/New_York';

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsAt(timestamp: number, timeZone: string): DateParts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function offsetAt(timestamp: number, timeZone: string): number {
  const parts = partsAt(timestamp, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - timestamp;
}

function localMidnightUtc(year: number, month: number, day: number, timeZone: string): number {
  const desired = Date.UTC(year, month - 1, day);
  let candidate = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) candidate = desired - offsetAt(candidate, timeZone);
  return candidate;
}

export function getTodayWindow(now: Date, timeZone = DEFAULT_REPORT_TIMEZONE): Readonly<{ start: Date; end: Date }> {
  if (Number.isNaN(now.getTime())) throw new RangeError('now must be a valid Date');
  const current = partsAt(now.getTime(), timeZone);
  const nextCalendarDay = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
  return Object.freeze({
    start: new Date(localMidnightUtc(current.year, current.month, current.day, timeZone)),
    end: new Date(
      localMidnightUtc(
        nextCalendarDay.getUTCFullYear(),
        nextCalendarDay.getUTCMonth() + 1,
        nextCalendarDay.getUTCDate(),
        timeZone,
      ),
    ),
  });
}

export function aggregateToday(
  events: readonly SanitizedAuditSidecarV1[],
  now: Date,
  timeZone = DEFAULT_REPORT_TIMEZONE,
): TodaySummary {
  const { start, end } = getTodayWindow(now, timeZone);
  const today = events.filter((event) => {
    const timestamp = Date.parse(event.timestamp);
    return timestamp >= start.getTime() && timestamp < end.getTime();
  });
  const unavailable = today.find((event) => event.cost === null);
  const amounts = today.flatMap((event) => (event.cost ? [event.cost.amountUsd] : []));
  const costUnavailableReason: CostUnavailableReason | null = unavailable
    ? Object.freeze({ code: 'aggregate-incomplete', detail: unavailable.costUnavailableReason?.code ?? 'unknown cost' })
    : null;
  const latestEventTimestamp = today.reduce<string | null>(
    (latest, event) => (latest === null || event.timestamp > latest ? event.timestamp : latest),
    null,
  );
  return Object.freeze({
    reportTimezone: timeZone,
    startInclusive: start.toISOString(),
    endExclusive: end.toISOString(),
    inputTokens: today.reduce((sum, event) => sum + event.usage.inputTokens, 0),
    outputTokens: today.reduce((sum, event) => sum + event.usage.outputTokens, 0),
    totalTokens: today.reduce((sum, event) => sum + event.usage.totalTokens, 0),
    requestCount: today.length,
    latestEventTimestamp,
    cost:
      costUnavailableReason === null
        ? Object.freeze({ currency: 'USD', amountUsd: addUsdAmounts(amounts), catalogueVersion: 'aggregate' })
        : null,
    costUnavailableReason,
  });
}
