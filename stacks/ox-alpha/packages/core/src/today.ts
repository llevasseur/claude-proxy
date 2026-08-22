import { addUsdAmounts } from "./pricing.ts";
import type { CostUnavailableReason, SanitizedAuditSidecarV1, TodaySummary } from "./types.ts";

// Day-boundary and aggregation mechanics ported from codex-proxy
// `packages/core/src/today.ts`.
export const DEFAULT_REPORT_TIMEZONE = "America/New_York";

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsAt(timestamp: number, timeZone: string): DateParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
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
  return (
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
    timestamp
  );
}

function localMidnightUtc(year: number, month: number, day: number, timeZone: string): number {
  const desired = Date.UTC(year, month - 1, day);
  let candidate = desired;
  for (let attempt = 0; attempt < 4; attempt += 1)
    candidate = desired - offsetAt(candidate, timeZone);
  return candidate;
}

export function parseCalendarDate(
  calendarDate: string,
): Readonly<{ year: number; month: number; day: number }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(calendarDate))
    throw new RangeError(`invalid calendar date: ${calendarDate}`);
  const [yearText, monthText, dayText] = calendarDate.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) {
    throw new RangeError(`invalid calendar date: ${calendarDate}`);
  }
  const canonical = new Date(Date.UTC(year, month - 1, day));
  if (
    canonical.getUTCFullYear() !== year ||
    canonical.getUTCMonth() !== month - 1 ||
    canonical.getUTCDate() !== day
  ) {
    throw new RangeError(`invalid calendar date: ${calendarDate}`);
  }
  return Object.freeze({ year, month, day });
}

export function formatReportDate(timestamp: number, timeZone = DEFAULT_REPORT_TIMEZONE): string {
  const parts = partsAt(timestamp, timeZone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function getCalendarDayWindow(
  calendarDate: string,
  timeZone = DEFAULT_REPORT_TIMEZONE,
): Readonly<{ start: Date; end: Date }> {
  const { year, month, day } = parseCalendarDate(calendarDate);
  const nextCalendarDay = new Date(Date.UTC(year, month - 1, day + 1));
  return Object.freeze({
    start: new Date(localMidnightUtc(year, month, day, timeZone)),
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

export function getTodayWindow(
  now: Date,
  timeZone = DEFAULT_REPORT_TIMEZONE,
): Readonly<{ start: Date; end: Date }> {
  if (Number.isNaN(now.getTime())) throw new RangeError("now must be a valid Date");
  return getCalendarDayWindow(formatReportDate(now.getTime(), timeZone), timeZone);
}

// Per ADR 0003: one unpriced record makes the whole aggregate cost
// unavailable while token counts are still retained.
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
    ? Object.freeze({
        code: "aggregate-incomplete",
        detail: unavailable.costUnavailableReason?.code ?? "unknown cost",
      })
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
        ? Object.freeze({
            currency: "USD",
            amountUsd: addUsdAmounts(amounts),
            catalogueVersion: "aggregate",
          })
        : null,
    costUnavailableReason,
  });
}
