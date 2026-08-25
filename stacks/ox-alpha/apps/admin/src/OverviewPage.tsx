import { useId } from 'react';
import { costView, overviewText } from './overview/format';
import { statusCopy } from './overview/machine';
import type { LiveOverview } from './overview/useLiveOverview';

const STATUS_CLASS: Readonly<Record<LiveOverview['status'], string>> = Object.freeze({
  bootstrapping: 'banner banner-muted',
  live: 'banner banner-live',
  reconnecting: 'banner banner-warn',
  stale: 'banner banner-warn',
  degraded: 'banner banner-warn',
  unavailable: 'banner banner-error',
});

export function OverviewPage({ live }: { readonly live: LiveOverview }) {
  const { status, health, summary } = live;
  const todayHeadingId = useId();
  const healthHeadingId = useId();
  const text = summary ? overviewText(summary) : null;
  const cost = summary ? costView(summary) : null;
  return (
    <main className='page'>
      <header className='header'>
        <h1>ox-alpha-proxy admin</h1>
        <p data-testid='connection' className={STATUS_CLASS[status]}>
          {statusCopy(status)}
        </p>
      </header>
      <section aria-labelledby={todayHeadingId} className='card'>
        <h2 id={todayHeadingId}>
          Today
          {summary ? <span className='timezone'> · {summary.reportTimezone}</span> : null}
        </h2>
        {text === null || cost === null ? (
          <p data-testid='summary-placeholder'>
            {status === 'bootstrapping' ? 'Waiting for the first snapshot…' : 'No summary received yet.'}
          </p>
        ) : (
          <>
            <dl className='metrics'>
              <div>
                <dt>Requests</dt>
                <dd data-testid='request-count'>{text.requestCount}</dd>
              </div>
              <div>
                <dt>Input tokens</dt>
                <dd data-testid='input-tokens'>{text.inputTokens}</dd>
              </div>
              <div>
                <dt>Output tokens</dt>
                <dd data-testid='output-tokens'>{text.outputTokens}</dd>
              </div>
              <div>
                <dt>Total tokens</dt>
                <dd data-testid='total-tokens'>{text.totalTokens}</dd>
              </div>
            </dl>
            <p data-testid='latest-activity'>Latest activity: {text.latestActivity}</p>
            {cost.kind === 'estimate' ? (
              <p data-testid='cost-estimate'>
                Estimated cost today: <strong>{cost.text}</strong>
              </p>
            ) : (
              <p data-testid='cost-unavailable' className='cost-unavailable'>
                Cost unavailable: {cost.detail}. Token counts above remain complete.
              </p>
            )}
          </>
        )}
      </section>
      {health ? (
        <section aria-labelledby={healthHeadingId} className='card'>
          <h2 id={healthHeadingId}>Server</h2>
          <dl className='metrics'>
            <div>
              <dt>Proxy</dt>
              <dd data-testid='proxy-status'>
                {health.proxy.status}
                {health.proxy.state ? ` (${health.proxy.state})` : ''}
              </dd>
            </div>
            <div>
              <dt>Database records</dt>
              <dd>{health.database.recordCount.toLocaleString('en-US')}</dd>
            </div>
            <div>
              <dt>Rejected sidecars</dt>
              <dd>{health.ingest.rejectedSidecars.toLocaleString('en-US')}</dd>
            </div>
            <div>
              <dt>SSE subscribers</dt>
              <dd>{health.sse.subscribers.toLocaleString('en-US')}</dd>
            </div>
          </dl>
        </section>
      ) : null}
    </main>
  );
}
