const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

function calendarDate(value: unknown): string | undefined {
  return typeof value === 'string' && CALENDAR_DATE.test(value) ? value : undefined;
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return undefined;
}

function selectedModels(value: unknown): string[] | undefined {
  const candidates = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const cleaned = candidates.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

export interface CarSearchFilters {
  from?: string;
  to?: string;
  model?: string[];
}

export interface HistorySearch extends CarSearchFilters {
  page?: number;
  pageSize?: number;
}

export function validateCarSearch(search: Record<string, unknown>): CarSearchFilters {
  return {
    from: calendarDate(search.from),
    to: calendarDate(search.to),
    model: selectedModels(search.model),
  };
}

export function validateHistorySearch(search: Record<string, unknown>): HistorySearch {
  return {
    ...validateCarSearch(search),
    page: positiveInt(search.page),
    pageSize: positiveInt(search.pageSize),
  };
}
