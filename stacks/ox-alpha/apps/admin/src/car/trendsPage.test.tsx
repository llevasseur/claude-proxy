// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { bucket, FakeEventSource, installTestGlobals, renderShell, stubFetch, trendsResponse } from './testSupport';

beforeEach(() => {
  FakeEventSource.instances = [];
  installTestGlobals();
});

describe('Trends route', () => {
  it('labels daily buckets in the report timezone across a DST boundary', async () => {
    // America/New_York springs forward on 2026-03-08 (23-hour day) and falls
    // back on 2026-11-01 (25-hour day). Bucket starts are UTC instants; the
    // labels must come from the report timezone, not the machine's.
    stubFetch(() =>
      trendsResponse([
        bucket('2026-03-07', '2026-03-07T05:00:00.000Z'),
        bucket('2026-03-08', '2026-03-08T05:00:00.000Z'),
        bucket('2026-03-09', '2026-03-09T04:00:00.000Z'),
        bucket('2026-11-01', '2026-11-01T04:00:00.000Z'),
      ]),
    );
    window.location.hash = '#/trends';

    renderShell();
    await waitFor(() => expect(screen.getByTestId('trends-table')).toBeTruthy());
    // 2026-03-07 is EST (UTC-5); from 03-08 02:00 local it is EDT (UTC-4),
    // so the 05:00Z starts land on Sat/Sat/Sun/Sun respectively.
    expect(screen.getByTestId('day-2026-03-07').textContent).toContain('Mar 7');
    expect(screen.getByTestId('day-2026-03-08').textContent).toContain('Mar 8');
    expect(screen.getByTestId('day-2026-03-09').textContent).toContain('Mar 9');
    expect(screen.getByTestId('day-2026-11-01').textContent).toContain('Nov 1');
    const table = screen.getByTestId('trends-table');
    expect(within(table).getByText(/Sat, Mar 7/)).toBeTruthy();
    expect(within(table).getByText(/Sun, Mar 8/)).toBeTruthy();
    expect(within(table).getByText(/Mon, Mar 9/)).toBeTruthy();
    expect(within(table).getByText(/Sun, Nov 1/)).toBeTruthy();
  });

  it('renders unpriced buckets as explicitly unavailable, never zero', async () => {
    stubFetch(() =>
      trendsResponse(
        [
          bucket('2026-03-09', '2026-03-09T04:00:00.000Z', {
            cost: null,
            costUnavailableReason: { code: 'unknown-model', model: 'gpt-x' },
          }),
        ],
        {
          total: {
            requestCount: 2,
            inputTokens: 20,
            cachedInputTokens: 0,
            outputTokens: 8,
            reasoningOutputTokens: 0,
            totalTokens: 28,
            latestEventTimestamp: null,
            cost: null,
            costUnavailableReason: {
              code: 'aggregate-incomplete',
              detail: 'unpriced requests in range',
            },
          },
        },
      ),
    );
    window.location.hash = '#/trends';

    renderShell();
    await waitFor(() => expect(screen.getByTestId('trends-table')).toBeTruthy());
    const table = screen.getByTestId('trends-table');
    const unavailable = within(table).getAllByText('unavailable');
    expect(unavailable.length).toBeGreaterThan(0);
    expect(within(table).queryByText(/^\$/)).toBeNull();
  });

  it('sends range and model filters and shows the empty state', async () => {
    const fetchMock = stubFetch(() => trendsResponse([]));
    window.location.hash = '#/trends';

    renderShell();
    await waitFor(() => expect(screen.getByTestId('trends-empty')).toBeTruthy());
    expect(urls(fetchMock).every((url) => !url.includes('model='))).toBe(true);

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-03-01' } });
    await waitFor(() => expect(window.location.hash).toBe('#/trends?from=2026-03-01'));
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-03-10' } });
    await waitFor(() => expect(window.location.hash).toBe('#/trends?from=2026-03-01&to=2026-03-10'));
    expect(urls(fetchMock).some((url) => url.includes('from=2026-03-01') && url.includes('to=2026-03-10'))).toBe(true);
  });

  it("links each day to its drill-down and renders that day's records", async () => {
    const { historyRecord, historyPageResponse } = await import('./testSupport');
    const fetchMock = stubFetch((url) => {
      if (url.includes('/api/trends')) return trendsResponse([bucket('2026-03-09', '2026-03-09T05:00:00.000Z')]);
      if (url.includes('/api/history')) return historyPageResponse([historyRecord()]);
      throw new Error(`unexpected url ${url}`);
    });
    window.location.hash = '#/trends';
    renderShell();
    await waitFor(() => expect(screen.getByTestId('trends-table')).toBeTruthy());
    expect(screen.getByTestId('trends-chart')).toBeTruthy();

    fireEvent.click(screen.getByTestId('day-link-2026-03-09'));
    await waitFor(() => expect(screen.getByTestId('trend-detail-table')).toBeTruthy());
    expect(window.location.hash).toContain('#/trends/detail?date=2026-03-09');
    expect(urls(fetchMock).some((url) => url.includes('/api/history') && url.includes('from=2026-03-09'))).toBe(true);
    expect(screen.getByTestId('trend-detail-table').querySelectorAll('tbody tr')).toHaveLength(1);
  });
});

function urls(fetchMock: ReturnType<typeof stubFetch>): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url));
}
