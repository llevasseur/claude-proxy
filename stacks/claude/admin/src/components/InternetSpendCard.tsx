import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { fmtBytes, LOCAL_TZ_ABBR } from '../format';
import {
  getNetDays,
  getNetSummary,
  NET_API_BASE,
  type NetConfig,
  type NetDay,
  type NetPeriod,
  NetServerUnreachableError,
} from '../net-api';
import { InternetDaysChart } from './InternetDaysChart';

/** Fallback window, in days, when no budget is configured. */
const FALLBACK_WINDOW = 14;

/** `/api/days` clamps `window` here too. */
const MAX_WINDOW = 366;

const MS_PER_DAY = 86_400_000;

/** Past this share of the limit the budget reads as spent, not merely close. */
const EXHAUSTED_SHARE = 0.995;

/**
 * `GET /api/config`. Declared here because `../net-api` covers every other net-server
 * route but exports no reader for this one.
 */
async function getNetConfig(): Promise<NetConfig> {
  let response: Response;
  try {
    response = await fetch(`${NET_API_BASE}/api/config`);
  } catch {
    // `fetch` rejects only on a transport failure; every HTTP status resolves.
    throw new NetServerUnreachableError(NET_API_BASE);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  // SAFETY: a 2xx from net-server, whose `readNetConfig` always returns `NetConfig`'s
  // three fields. Every field is read through a `null` check below, so a stale server
  // shape narrows to "unset" rather than to a wrong number.
  return (await response.json()) as NetConfig;
}

const dayParts = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' });

/* The three helpers below are duplicated from `routes/internet.tsx`; both that file
 * and the only shared home for them, `net-api.ts`, belong to another ticket. */

/** A UTC epoch as the viewer's local calendar day, `YYYY-MM-DD` — the form `/api/days` keys on. */
function localDay(epochMs: number): string {
  const parts = dayParts.formatToParts(new Date(epochMs));
  const read = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${read('year')}-${read('month')}-${read('day')}`;
}

/** How many calendar days `from` through `to` spans, both ends counted. */
function daySpanInclusive(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 1;
  return Math.max(1, Math.round((end - start) / MS_PER_DAY) + 1);
}

/**
 * Wire bytes attributed to the days inside the period, summed from the day buckets
 * rather than read from the corpus-wide `/api/summary.totals`. `null` when the period
 * holds no known day — "nothing recorded", where `0` would read as "nothing sent".
 */
function periodTotal(days: readonly NetDay[], period: NetPeriod): number | null {
  let total = 0;
  let known = false;
  for (const day of days) {
    if (day.date < period.start || day.date > period.end || !day.known) continue;
    known = true;
    total += day.bytesIn + day.bytesOut;
  }
  return known ? total : null;
}

/**
 * How much of the period has elapsed, as a fraction. Inclusive at both ends with days
 * as the unit, so the first day counts as spent.
 */
function periodElapsed(period: NetPeriod, today: string): number {
  const span = daySpanInclusive(period.start, period.end);
  const gone = daySpanInclusive(period.start, today < period.start ? period.start : today);
  return Math.min(1, Math.max(0, gone / span));
}

/**
 * Tone means *pace*, not fill: `.usage-meter.tone-*` is shared with the allowance
 * gauges above, so spend is read against how much of the period has gone.
 */
function budgetTone(share: number, elapsed: number): 'good' | 'signal' | 'warn' | 'bad' {
  if (share >= EXHAUSTED_SHARE) return 'bad';
  const projected = elapsed > 0 ? share / elapsed : share;
  if (projected > 1) return 'warn';
  if (projected > 0.8) return 'signal';
  return 'good';
}

const TONE_LABEL = {
  good: 'Within budget',
  signal: 'Near pace',
  warn: 'Over pace',
  bad: 'Budget spent',
} satisfies Record<ReturnType<typeof budgetTone>, string>;

/**
 * Internet wire-byte spend, on the Overview.
 *
 * A limit *and* a reset day together draw the budget meter; with either unset it falls
 * back to daily totals over the last fortnight.
 *
 * Every net-server read is confined to this component — that server is frequently not
 * running, so on any failure this renders a single note and the meters above are
 * untouched.
 */
export function InternetSpendCard() {
  // The cheap route — three settings, no corpus scan — so the branch is settled without
  // waiting on `/api/summary`, which recomputes the spend model at read time.
  const config = useQuery({ queryKey: ['net', 'config'], queryFn: getNetConfig, retry: false });
  const budgeted = config.data !== undefined && config.data.limitBytes !== null && config.data.resetDay !== null;

  // Only the budgeted branch needs the summary, and only for the period bounds, which
  // are derived on the server's clock rather than this one.
  const summary = useQuery({
    queryKey: ['net', 'summary'],
    queryFn: getNetSummary,
    enabled: budgeted,
    retry: false,
  });

  const period = summary.data?.period ?? null;
  // Sized to the period rather than sliced out of the fallback fortnight: a reset day
  // far enough behind puts the period's start outside 14 days.
  const dayWindow =
    budgeted && period ? Math.min(MAX_WINDOW, daySpanInclusive(period.start, localDay(Date.now()))) : FALLBACK_WINDOW;
  const days = useQuery({
    // Shares the `/internet` page's cache: same key, same fetch, same window.
    queryKey: ['net', 'days', dayWindow],
    queryFn: () => getNetDays(dayWindow),
    enabled: config.isSuccess && (!budgeted || period !== null),
    retry: false,
  });

  const error = config.error ?? summary.error ?? days.error;
  if (error) return <SectionNote error={error} />;
  // No slot is reserved while loading; the card appears when its data lands.
  if (!config.data || !days.data) return null;

  if (budgeted && period && config.data.limitBytes !== null) {
    return <BudgetMeter limitBytes={config.data.limitBytes} period={period} days={days.data.days} />;
  }
  return <FallbackChart days={days.data.days} />;
}

/**
 * The one line a failed net-server read may put on this page, in the shape the usage
 * meters use for their own degraded state. Unreachable is named specifically: the
 * collector is a timer inside that process (ADR 0072), so a server that is down has no
 * figures for the interval rather than withholding them.
 */
function SectionNote({ error }: { error: unknown }) {
  if (error instanceof NetServerUnreachableError) {
    return <div className='card usage-note'>net-server unreachable at {NET_API_BASE} — internet spend not shown.</div>;
  }
  return (
    <div className='card usage-note'>
      Internet spend unavailable: {error instanceof Error ? error.message : String(error)}
    </div>
  );
}

/**
 * Bytes spent this period against the configured limit, with the period named. The bar
 * is decorative; the figures beside it carry the reading.
 */
function BudgetMeter({ limitBytes, period, days }: { limitBytes: number; period: NetPeriod; days: readonly NetDay[] }) {
  const total = periodTotal(days, period);
  const share = total === null ? null : total / limitBytes;
  const elapsed = periodElapsed(period, localDay(Date.now()));
  const tone = share === null ? 'good' : budgetTone(share, elapsed);
  const fill = share === null ? 0 : Math.min(100, Math.max(0, share * 100));

  return (
    <div className={`card usage-meter tone-${tone}`}>
      {/* The spend so far, riding the card's top edge. */}
      <div className='usage-bar' aria-hidden>
        <div className='usage-bar-fill' style={{ width: `${fill}%` }} />
      </div>
      <div className='usage-meter-head'>
        <span className='stat-label'>Internet budget</span>
        {share !== null && <span className={`usage-chip ${tone}`}>{TONE_LABEL[tone]}</span>}
      </div>

      <div className='stat-value'>{total === null ? '—' : fmtBytes(total)}</div>
      <div className='stat-foot'>
        <span className='muted'>
          {period.start} → {period.end} ({LOCAL_TZ_ABBR})
        </span>
        {share !== null && (
          <span className='muted'>
            {(share * 100).toFixed(0)}% of {fmtBytes(limitBytes)}
          </span>
        )}
      </div>

      <div className='usage-meter-foot'>
        <span className='muted'>
          {total === null
            ? 'No day in this period has attributed samples yet.'
            : 'Summed over the days in the period that have samples.'}
        </span>
        <Link to='/internet' className='link'>
          detail →
        </Link>
      </div>
    </div>
  );
}

/**
 * No budget set: a fortnight of daily totals, without inventing a ceiling to measure
 * against.
 */
function FallbackChart({ days }: { days: readonly NetDay[] }) {
  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Internet</h2>
        <Link to='/internet' className='link'>
          detail →
        </Link>
      </div>
      <p className='muted'>
        Wire bytes per day over the last {FALLBACK_WINDOW} days ({LOCAL_TZ_ABBR}). Set a limit and a reset day on{' '}
        <Link to='/internet' className='link'>
          Internet
        </Link>{' '}
        to meter a budget here instead.
      </p>
      <InternetDaysChart days={days} />
    </div>
  );
}
