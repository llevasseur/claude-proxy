// Search-param validation ported from codex-proxy
// `apps/admin/src/car/search-params.ts`; unmatched values stay shareable and
// never error.

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

function calendarDate(value: unknown): string | undefined {
  return typeof value === 'string' && CALENDAR_DATE.test(value) ? value : undefined;
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return undefined;
}

function selectedModels(value: URLSearchParams): string[] | undefined {
  const cleaned = value.getAll('model').filter((entry) => entry.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

export interface CarSearchFilters {
  readonly from?: string;
  readonly to?: string;
  readonly model?: readonly string[];
}

export interface HistorySearch extends CarSearchFilters {
  readonly page?: number;
  readonly pageSize?: number;
}

export function validateCarSearch(search: URLSearchParams): CarSearchFilters {
  return {
    from: calendarDate(search.get('from')),
    to: calendarDate(search.get('to')),
    model: selectedModels(search),
  };
}

export function validateHistorySearch(search: URLSearchParams): HistorySearch {
  return {
    ...validateCarSearch(search),
    page: positiveInt(search.get('page')),
    pageSize: positiveInt(search.get('pageSize')),
  };
}

// Repeated params survive the round trip; empty selection means all models.
export function stringifySearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const entry of value) params.append(key, String(entry));
    } else {
      params.set(key, String(value));
    }
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}
