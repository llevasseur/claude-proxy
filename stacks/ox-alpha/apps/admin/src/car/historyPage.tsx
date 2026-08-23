import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useId } from 'react';
import { fetchHistory, type UsageTotals } from '../api';
import { CostRateCard } from '../ui/costRateCard';
import { FilterBar, type FilterBarFilters } from './filterBar';
import { costCell, formatTimestamp, formatTokens, unavailableReasonText } from './format';
import { recordObservedModels, useObservedModels } from './observedModels';
import { streamStatusText } from './stream';
import { useVersionedQuery } from './useVersionedQuery';

// History page ported from codex-proxy
// `apps/admin/src/car/history-page.tsx`, adapted to this server's offset
// pagination contract (limit/offset/total/nextOffset instead of page
// numbering in the API).

export const HISTORY_PAGE_SIZES: readonly number[] = Object.freeze([25, 50, 100]);
export const DEFAULT_HISTORY_PAGE_SIZE = 25;

interface HistoryPageProps {
  filters: FilterBarFilters;
  page: number;
  pageSize: number;
  onSearchChange: (search: Partial<FilterBarFilters & { page?: number; pageSize?: number }>) => void;
}

function tokensDetail(usage: UsageTotals): string {
  return [
    `in ${formatTokens(usage.inputTokens)}`,
    `cached ${formatTokens(usage.cachedInputTokens)}`,
    `out ${formatTokens(usage.outputTokens)}`,
    `reasoning ${formatTokens(usage.reasoningOutputTokens)}`,
  ].join(' · ');
}

export function HistoryPage({ filters, page, pageSize, onSearchChange }: HistoryPageProps) {
  const modelOptions = useObservedModels();
  const titleId = useId();
  const offset = (page - 1) * pageSize;
  const history = useQuery({
    queryKey: [
      'history',
      filters.from ?? null,
      filters.to ?? null,
      [...(filters.model ?? [])].sort(),
      offset,
      pageSize,
    ],
    queryFn: () => fetchHistory(filters, pageSize, offset),
    placeholderData: keepPreviousData,
    retry: false,
    refetchInterval: 10_000,
  });
  const { result, signal } = useVersionedQuery(history);
  const data = result.data;

  useEffect(() => {
    if (!data) return;
    recordObservedModels(data.records.map((record) => record.model));
  }, [data]);

  const totalPages =
    data === undefined || data.limit === null ? undefined : Math.max(1, Math.ceil(data.total / data.limit));

  return (
    <section className='car-page' aria-labelledby={titleId}>
      <header className='pagehead'>
        <div className='pagehead-title'>
          <h1 id={titleId}>History</h1>
          <div className='muted'>Per-request records · newest first</div>
        </div>
        <output className='muted' aria-live='polite'>
          {streamStatusText(signal.stream, data !== undefined)}
          {data !== undefined && ` · data v${data.dataVersion} · ${formatTokens(data.total)} records`}
        </output>
      </header>

      {result.isError && data === undefined && (
        <div className='card notice notice--error' role='alert' data-testid='history-error'>
          The local API could not be reached. The page will retry automatically.
        </div>
      )}

      <FilterBar
        filters={filters}
        modelOptions={modelOptions}
        onChange={(next) => onSearchChange({ ...next, page: undefined })}
      />

      {result.isLoading && (
        <p className='card muted' aria-live='polite' data-testid='history-loading'>
          Loading history…
        </p>
      )}

      {data !== undefined && data.records.length === 0 ? (
        <div className='card empty car-empty' data-testid='history-empty'>
          <strong>No matching requests.</strong>
          <span>No recorded requests match this range and model filter. Adjust the filters to see results.</span>
        </div>
      ) : data !== undefined ? (
        <div className='card car-table-card' aria-busy={result.isFetching}>
          <table className='car-table' data-testid='history-table'>
            <caption className='sr-only'>Durable request history</caption>
            <thead>
              <tr>
                <th scope='col'>Timestamp</th>
                <th scope='col'>Model</th>
                <th scope='col'>Endpoint</th>
                <th scope='col'>Status</th>
                <th scope='col'>Total tokens</th>
                <th scope='col'>Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.records.map((record) => {
                const cost = costCell(record);
                return (
                  <tr key={record.recordId}>
                    <td>{formatTimestamp(record.timestamp)}</td>
                    <td className='car-cell-mono'>{record.model}</td>
                    <td className='car-cell-mono'>{record.endpoint}</td>
                    <td>{record.responseStatus}</td>
                    <td>
                      <span className='car-token-total'>{formatTokens(record.usage.totalTokens)}</span>
                      <span className='car-token-detail muted'>{tokensDetail(record.usage)}</span>
                    </td>
                    <td>
                      <span
                        className={cost.unavailable ? 'cost-unavailable-text' : 'car-cost'}
                        title={cost.unavailable ? unavailableReasonText(record.costUnavailableReason) : undefined}
                        data-testid={`cost-${record.recordId}`}>
                        {cost.text}
                      </span>
                      {cost.unavailable && (
                        <span className='car-token-detail muted'>
                          {unavailableReasonText(record.costUnavailableReason)}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <nav className='car-pagination' aria-label='History pages' data-testid='history-pagination'>
            <button
              type='button'
              onClick={() => onSearchChange({ page: page - 1 })}
              disabled={offset === 0 || result.isFetching}>
              Previous
            </button>
            <span className='muted'>
              Page {page}
              {totalPages !== undefined && ` of ${formatTokens(totalPages)}`}
              {data.limit !== null &&
                data.total > 0 &&
                ` · showing ${offset + 1}–${Math.min(offset + (data.limit ?? 0), data.total)} of ${formatTokens(data.total)}`}
            </span>
            <button
              type='button'
              onClick={() => onSearchChange({ page: page + 1 })}
              disabled={data.nextOffset === null || result.isFetching}>
              Next
            </button>
            <label className='car-page-size'>
              <span>Per page</span>
              <select
                value={pageSize}
                onChange={(event) => onSearchChange({ page: undefined, pageSize: Number(event.target.value) })}>
                {HISTORY_PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
          </nav>
        </div>
      ) : null}

      {data !== undefined && data.records.length > 0 ? (
        <CostRateCard
          usage={data.records.reduce<UsageTotals>(
            (total, record) => ({
              inputTokens: total.inputTokens + record.usage.inputTokens,
              cachedInputTokens: total.cachedInputTokens + record.usage.cachedInputTokens,
              outputTokens: total.outputTokens + record.usage.outputTokens,
              reasoningOutputTokens: total.reasoningOutputTokens + record.usage.reasoningOutputTokens,
              totalTokens: total.totalTokens + record.usage.totalTokens,
            }),
            {
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
              totalTokens: 0,
            },
          )}
        />
      ) : null}
    </section>
  );
}
