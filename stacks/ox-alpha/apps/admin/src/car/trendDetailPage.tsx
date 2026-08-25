import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { type CarFilters, fetchHistory } from '../api';
import { Breadcrumbs } from '../ui/Breadcrumbs';
import { QueryState } from '../ui/QueryState';
import { costCell, formatDay, formatTimestamp, formatTokens } from './format';
import { streamStatusText } from './stream';
import { useVersionedQuery } from './useVersionedQuery';

// Per-model/per-day trend drill-down destination (`routes/trend-detail.tsx`
// at the pinned commit): one report day's records, optionally narrowed to a
// model, reached from a trends row.

export function TrendDetailPage({ date, filters }: { readonly date?: string; readonly filters: CarFilters }) {
  const titleId = useId();
  const scopedFilters: CarFilters = { ...filters, from: date, to: date };
  const history = useQuery({
    queryKey: ['trend-detail', date ?? null, [...(filters.model ?? [])].sort()],
    queryFn: () => fetchHistory(scopedFilters, 200, 0),
    placeholderData: keepPreviousData,
    retry: false,
    refetchInterval: 10_000,
  });
  const { result, signal } = useVersionedQuery(history);
  const data = result.data;

  return (
    <section className='car-page' aria-labelledby={titleId}>
      <Breadcrumbs crumbs={[{ label: 'Trends', href: '#/trends' }, { label: date ?? 'Latest day' }]} />
      <header className='pagehead'>
        <div className='pagehead-title'>
          <h1 id={titleId}>{date ? `Trend detail · ${date}` : 'Trend detail'}</h1>
          <div className='muted'>{data ? `${data.total} requests on this day` : "One day's captured usage"}</div>
        </div>
        <output className='muted' aria-live='polite'>
          {streamStatusText(signal.stream, data !== undefined)}
        </output>
      </header>

      <QueryState
        loading={result.isPending}
        error={result.isError && data === undefined}
        empty={data !== undefined && data.records.length === 0}
        testIdPrefix='trend-detail'
        emptyText='No recorded usage falls on this day for the selected models.'
        skeleton>
        {data !== undefined && (
          <div className='card car-table-card' aria-busy={result.isFetching}>
            <table className='car-table' data-testid='trend-detail-table'>
              <thead>
                <tr>
                  <th scope='col'>Time</th>
                  <th scope='col'>Model</th>
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
                      <td>{record.model}</td>
                      <td>{formatTokens(record.usage.totalTokens)}</td>
                      <td className={cost.unavailable ? 'cost-unavailable-text' : 'car-cost'}>{cost.text}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </QueryState>
    </section>
  );
}
