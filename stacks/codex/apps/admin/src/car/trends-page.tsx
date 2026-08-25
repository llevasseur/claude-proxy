import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { DailyTrendBucket, TrendRangeTotal } from './api.ts';
import { type CarFilters, getTrends } from './api.ts';
import { FilterBar } from './filter-bar.tsx';
import { costCell, formatDay, formatTimestamp, formatTokens, unavailableReasonText } from './format.ts';
import { useObservedModels } from './observed-models.ts';
import type { CarSearchFilters } from './search-params.ts';
import { streamStatusText } from './stream.ts';
import { useVersionedQuery } from './use-versioned-query.ts';

interface TrendsPageProps {
  filters: CarSearchFilters;
  onSearchChange: (filters: CarSearchFilters) => void;
}

function tokensDetail(bucket: DailyTrendBucket): string {
  return [
    `in ${formatTokens(bucket.inputTokens)}`,
    `cached ${formatTokens(bucket.cachedInputTokens)}`,
    `out ${formatTokens(bucket.outputTokens)}`,
    `reasoning ${formatTokens(bucket.reasoningOutputTokens)}`,
  ].join(' · ');
}

function tokensDetailTotal(total: TrendRangeTotal): string {
  return [
    `in ${formatTokens(total.inputTokens)}`,
    `cached ${formatTokens(total.cachedInputTokens)}`,
    `out ${formatTokens(total.outputTokens)}`,
    `reasoning ${formatTokens(total.reasoningOutputTokens)}`,
  ].join(' · ');
}

export function TrendsPage({ filters, onSearchChange }: TrendsPageProps) {
  const query: CarFilters = { ...filters, models: filters.model };
  const modelOptions = useObservedModels();
  const trends = useQuery({
    queryKey: ['trends', query.from ?? null, query.to ?? null, [...(query.models ?? [])].sort()],
    queryFn: () => getTrends(query),
    placeholderData: keepPreviousData,
  });
  const { result, signal } = useVersionedQuery(trends);
  const buckets = result.data?.buckets;
  const rangeTotal = result.data?.total;

  return (
    <section className='car-page' aria-labelledby='trends-title'>
      <header className='pagehead'>
        <div className='pagehead-title'>
          <h1 id='trends-title'>Trends</h1>
          <div className='muted'>
            Daily total usage{result.data?.reportTimezone ? ` · ${result.data.reportTimezone}` : ''}
          </div>
        </div>
        <div className='muted' role='status' aria-live='polite'>
          {streamStatusText(signal.stream, result.data !== undefined)}
          {result.data !== undefined && ` · data v${result.data.dataVersion}`}
        </div>
      </header>

      {result.isError && result.data === undefined && (
        <div className='card notice notice--error' role='alert'>
          The local API could not be reached. The page will retry automatically.
        </div>
      )}

      <FilterBar filters={filters} modelOptions={modelOptions} onChange={(next) => onSearchChange(next)} />

      {buckets !== undefined && buckets.length === 0 ? (
        <div className='card empty car-empty'>
          <strong>No matching days.</strong>
          <span>
            No recorded usage falls inside this range and model filter. Adjust the filters to see results — unmatched
            values stay shareable and never error.
          </span>
        </div>
      ) : (
        <>
          <div className='card car-table-card' aria-busy={result.isLoading}>
            <table className='car-table'>
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
                {(buckets ?? []).map((bucket) => {
                  const cost = costCell(bucket.cost);
                  return (
                    <tr key={bucket.startInclusive}>
                      <td>{formatDay(bucket.startInclusive, result.data?.reportTimezone)}</td>
                      <td>{formatTokens(bucket.requestCount)}</td>
                      <td>
                        <span className='car-token-total'>{formatTokens(bucket.totalTokens)}</span>
                        <span className='car-token-detail muted'>{tokensDetail(bucket)}</span>
                      </td>
                      <td>{bucket.latestEventTimestamp ? formatTimestamp(bucket.latestEventTimestamp) : '—'}</td>
                      <td>
                        <span
                          className={cost.unavailable ? 'stat-value--unavailable' : 'car-cost'}
                          title={
                            cost.unavailable && bucket.costUnavailableReason
                              ? unavailableReasonText(bucket.costUnavailableReason)
                              : undefined
                          }>
                          {cost.text}
                        </span>
                        {cost.unavailable && bucket.costUnavailableReason && (
                          <span className='car-token-detail muted'>
                            {unavailableReasonText(bucket.costUnavailableReason)}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {rangeTotal !== undefined &&
                (() => {
                  const totalCost = costCell(rangeTotal.cost);
                  return (
                    <tfoot>
                      <tr>
                        <th scope='row'>Range total</th>
                        <td>{formatTokens(rangeTotal.requestCount)}</td>
                        <td>
                          <span className='car-token-total'>{formatTokens(rangeTotal.totalTokens)}</span>
                          <span className='car-token-detail muted'>{tokensDetailTotal(rangeTotal)}</span>
                        </td>
                        <td>—</td>
                        <td>
                          <span
                            className={totalCost.unavailable ? 'stat-value--unavailable' : 'car-cost'}
                            title={
                              totalCost.unavailable && rangeTotal.costUnavailableReason
                                ? unavailableReasonText(rangeTotal.costUnavailableReason)
                                : undefined
                            }>
                            {totalCost.text}
                          </span>
                          {totalCost.unavailable && rangeTotal.costUnavailableReason && (
                            <span className='car-token-detail muted'>
                              {unavailableReasonText(rangeTotal.costUnavailableReason)}
                            </span>
                          )}
                        </td>
                      </tr>
                    </tfoot>
                  );
                })()}
            </table>
          </div>
          <p className='muted car-trends-note'>
            Days with any unpriced request report their token counts with an explicit unavailable state instead of an
            amount; fully-priced days show computed amounts.
          </p>
        </>
      )}
    </section>
  );
}
