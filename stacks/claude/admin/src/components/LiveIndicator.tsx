import type { LiveStatus } from '../useLiveQuery';

const LABELS = { live: 'Live', connecting: 'Connecting…', offline: 'Offline' } satisfies Record<LiveStatus, string>;
const DOTS = { live: 'ok', connecting: 'warn', offline: 'bad' } satisfies Record<LiveStatus, string>;

/** Small SSE connection badge — reuses the health-badge layout. */
export function LiveIndicator({ status }: { status: LiveStatus }) {
  return (
    <div className='health' title='Live updates via server-sent events'>
      <span className={`dot ${DOTS[status]}`} />
      {LABELS[status]}
    </div>
  );
}
