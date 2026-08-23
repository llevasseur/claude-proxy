import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { type CostUnavailableReason, fetchTrends, type PricedCost, type UsageTotals } from '../api';
import { BarChart } from '../ui/BarChart';
import { FilterBar, type FilterBarFilters } from './filterBar';
import { costCell, formatDay, formatTimestamp, formatTokens, unavailableReasonText } from './format';
import { streamStatusText } from './stream';
import { useVersionedQuery } from './useVersionedQuery';

// Trends page ported from codex-proxy
// `apps/admin/src/car/trends-page.tsx`, consuming this server's flat
// per-bucket aggregates and `total` range roll-up.

interface TrendsPageProps {
  filters: FilterBarFilters;
  onSearchChange: (filters: FilterBarFilters) => void;
}

function tokensDetail(usage: UsageTotals): string {
  return [
    `in ${formatTokens(usage.inputTokens)}`,
    `cached ${formatTokens(usage.cachedInputTokens)}`,
    `out ${formatTokens(usage.outputTokens)}`,
    `reasoning ${formatTokens(usage.reasoningOutputTokens)}`,
  ].join(' · ');
}

function CostCellView({
  value,
}: {
  readonly value: {
    readonly cost: PricedCost | null;
    readonly costUnavailableReason: CostUnavailableReason | null;
  };
}) {
  const cost = costCell(value);
  return (
    <span>
      <span
        className={cost.unavailable ? 'cost-unavailable-text' : 'car-cost'}
        title={cost.unavailable ? unavailableReasonText(value.costUnavailableReason) : undefined}>
        {cost.text}
      </span>
      {cost.unavailable && (
        <span className='car-token-detail muted'>{unavailableReasonText(value.costUnavailableReason)}</span>
      )}
    </span>
  );
}

export function TrendsPage({ filters, onSearchChange }: TrendsPageProps) {
  const titleId = useId();
  const trends = useQuery({
    queryKey: ['trends', filters.from ?? null, filters.to ?? null, [...(filters.model ?? [])].sort()],
    queryFn: () => fetchTrends(filters),
    placeholderData: keepPreviousData,
    retry: false,
    refetchInterval: 10_000,
  });
  const { result, signal } = useVersionedQuery(trends);
  const data = result.data;

  return (
    <section className='car-page' aria-labelledby={titleId}>
      <header className='pagehead'>
        <div className='pagehead-title'>
          <h1 id={titleId}>Trends</h1>
          <div className='muted'>Daily total usage{data ? ` · ${data.reportTimezone}` : ''}</div>
        </div>
        <output className='muted' aria-live='polite'>
          {streamStatusText(signal.stream, data !== undefined)}
          {data !== undefined && ` · data v${data.dataVersion}`}
        </output>
      </header>

      {result.isError && data === undefined && (
        <div className='card notice notice--error' role='alert' data-testid='trends-error'>
          The local API could not be reached. The page will retry automatically.
        </div>
      )}

      {result.isLoading && (
        <p className='card muted' aria-live='polite' data-testid='trends-loading'>
          Loading trends…
        </p>
      )}

      <FilterBar filters={filters} modelOptions={[]} onChange={(next) => onSearchChange(next)} />

      {data !== undefined && data.buckets.length === 0 ? (
        <div className='card empty car-empty' data-testid='trends-empty'>
          <strong>No matching days.</strong>
          <span>No recorded usage falls inside this range and model filter. Adjust the filters to see results.</span>
        </div>
      ) : data !== undefined ? (
        <>
          <div className='card'>
            <BarChart
              testId='trends-chart'
              data={data.buckets.map((bucket) => ({
                label: bucket.date,
                value: bucket.totalTokens,
              }))}
            />
          </div>
          <div className='card car-table-card' aria-busy={result.isFetching}>
            <table className='car-table' data-testid='trends-table'>
              <caption className='sr-only'>Daily total usage trend</caption>
              <thead>
                <tr>
                  <th scope='col'>Day</th>
                  <th scope='col'>Requests</th>
                  <th scope='col'>Total tokens</th>
                  <th scope='col'>Latest request</th>
                  <th scope='col'>Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.buckets.map((bucket) => (
                  <tr key={bucket.startInclusive}>
                    <td data-testid={`day-${bucket.date}`}>
                      {filters.model && filters.model.length > 0 ? (
                        formatDay(bucket.startInclusive, bucket.reportTimezone)
                      ) : (
                        <a
                          href={`#/trends/detail?date=${encodeURIComponent(bucket.date)}`}
                          data-testid={`day-link-${bucket.date}`}>
                          {formatDay(bucket.startInclusive, bucket.reportTimezone)}
                        </a>
                      )}
                    </td>
                    <td>{formatTokens(bucket.requestCount)}</td>
                    <td>
                      <span className='car-token-total'>{formatTokens(bucket.totalTokens)}</span>
                      <span className='car-token-detail muted'>{tokensDetail(bucket)}</span>
                    </td>
                    <td>{bucket.latestEventTimestamp ? formatTimestamp(bucket.latestEventTimestamp) : '—'}</td>
                    <td>
                      <CostCellView value={bucket} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope='row'>Range total</th>
                  <td>{formatTokens(data.total.requestCount)}</td>
                  <td>
                    <span className='car-token-total'>{formatTokens(data.total.totalTokens)}</span>
                    <span className='car-token-detail muted'>{tokensDetail(data.total)}</span>
                  </td>
                  <td>—</td>
                  <td>
                    <CostCellView value={data.total} />
                  </td>
                </tr>
              </tfoot>
            </table>
            <p className='muted car-trends-note'>
              Days with any unpriced request report their token counts with an explicit unavailable state instead of an
              amount; fully-priced days show computed amounts.
            </p>
          </div>
        </>
      ) : null}
    </section>
  );
}
