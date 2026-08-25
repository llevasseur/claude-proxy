import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { HistoryRecord } from './api.ts';
import { getHistory, HISTORY_PAGE_SIZES, type HistoryQuery } from './api.ts';
import { FilterBar, type FilterBarFilters } from './filter-bar.tsx';
import { costCell, formatTimestamp, formatTokens, unavailableReasonText } from './format.ts';
import { recordObservedModels, useObservedModels } from './observed-models.ts';
import type { CarSearchFilters, HistorySearch } from './search-params.ts';
import { streamStatusText } from './stream.ts';
import { useVersionedQuery } from './use-versioned-query.ts';

interface HistoryPageProps {
  filters: CarSearchFilters;
  page: number;
  pageSize: number;
  onSearchChange: (search: HistorySearch) => void;
}

function tokensDetail(record: HistoryRecord): string {
  return [
    `in ${formatTokens(record.inputTokens)}`,
    `cached ${formatTokens(record.cachedInputTokens)}`,
    `out ${formatTokens(record.outputTokens)}`,
    `reasoning ${formatTokens(record.reasoningOutputTokens)}`,
  ].join(' · ');
}

export function HistoryPage({ filters, page, pageSize, onSearchChange }: HistoryPageProps) {
  const query: HistoryQuery = {
    ...filters,
    models: filters.model,
    page,
    pageSize,
  };
  const modelOptions = useObservedModels();
  const history = useQuery({
    queryKey: [
      'history',
      query.from ?? null,
      query.to ?? null,
      [...(query.models ?? [])].sort(),
      query.page,
      query.pageSize,
    ],
    queryFn: () => getHistory(query),
    placeholderData: keepPreviousData,
  });
  const { result, signal } = useVersionedQuery(history);
  const records = result.data?.records;

  useEffect(() => {
    if (!result.data) return;
    recordObservedModels(result.data.records.map((record) => record.model));
  }, [result.data]);

  const totalRecords = result.data?.total;
  const totalPages = totalRecords === undefined ? undefined : Math.max(1, Math.ceil(totalRecords / pageSize));
  const offset = (page - 1) * pageSize;

  const changePage = (next: number) => onSearchChange({ page: next });

  const applyFilters = (next: FilterBarFilters) => {
    onSearchChange({ ...next, page: undefined });
  };

  return (
    <section className='car-page' aria-labelledby='history-title'>
      <header className='pagehead'>
        <div className='pagehead-title'>
          <h1 id='history-title'>History</h1>
          <div className='muted'>Per-request records · newest first</div>
        </div>
        <div className='muted' role='status' aria-live='polite'>
          {streamStatusText(signal.stream, result.data !== undefined)}
          {result.data !== undefined && ` · data v${result.data.dataVersion}`}
          {totalRecords !== undefined && ` · ${formatTokens(totalRecords)} records`}
        </div>
      </header>

      {result.isError && result.data === undefined && (
        <div className='card notice notice--error' role='alert'>
          The local API could not be reached. The page will retry automatically.
        </div>
      )}

      <FilterBar filters={filters} modelOptions={modelOptions} onChange={applyFilters} />

      {records !== undefined && records.length === 0 ? (
        <div className='card empty car-empty'>
          <strong>No matching requests.</strong>
          <span>
            No recorded requests match this range and model filter. Adjust the filters to see results — unmatched values
            stay shareable and never error.
          </span>
        </div>
      ) : (
        <div className='card car-table-card' aria-busy={result.isLoading}>
          <table className='car-table'>
            <caption className='sr-only'>Durable request history</caption>
            <thead>
              <tr>
                <th scope='col'>Timestamp</th>
                <th scope='col'>Model</th>
                <th scope='col'>Endpoint</th>
                <th scope='col'>Status</th>
                <th scope='col'>Tokens</th>
                <th scope='col'>Cost</th>
              </tr>
            </thead>
            <tbody>
              {(records ?? []).map((record) => {
                const cost = costCell(record.cost);
                return (
                  <tr key={record.recordId}>
                    <td>{formatTimestamp(record.timestamp)}</td>
                    <td className='car-cell-mono'>{record.model}</td>
                    <td className='car-cell-mono'>{record.endpoint}</td>
                    <td>
                      <span
                        className={`badge ${record.responseStatus >= 200 && record.responseStatus < 400 ? 'status-done' : 'sev-warn'}`}>
                        {record.responseStatus}
                      </span>
                    </td>
                    <td>
                      <span className='car-token-total'>{formatTokens(record.totalTokens)}</span>
                      <span className='car-token-detail muted'>{tokensDetail(record)}</span>
                    </td>
                    <td>
                      <span
                        className={cost.unavailable ? 'stat-value--unavailable' : 'car-cost'}
                        title={
                          cost.unavailable && record.costUnavailableReason
                            ? unavailableReasonText(record.costUnavailableReason)
                            : undefined
                        }>
                        {cost.text}
                      </span>
                      {cost.unavailable && record.costUnavailableReason && (
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

          <nav className='car-pagination' aria-label='History pages'>
            <button type='button' onClick={() => changePage(page - 1)} disabled={page <= 1 || result.isFetching}>
              Previous
            </button>
            <span className='muted'>
              Page {page}
              {totalPages !== undefined && ` of ${formatTokens(totalPages)}`}
              {totalRecords !== undefined &&
                totalRecords > 0 &&
                ` · showing ${offset + 1}–${Math.min(offset + pageSize, totalRecords)} of ${formatTokens(totalRecords)}`}
            </span>
            <button
              type='button'
              onClick={() => changePage(page + 1)}
              disabled={(totalPages !== undefined && page >= totalPages) || result.isFetching}>
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
      )}
    </section>
  );
}
