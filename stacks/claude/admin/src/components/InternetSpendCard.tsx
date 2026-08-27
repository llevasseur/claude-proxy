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

/** The fallback window, in days: what the Overview shows when no budget is configured. */
const FALLBACK_WINDOW = 14;

/** `/api/days` clamps `window` here too; asking for more than a year is asking for nothing. */
const MAX_WINDOW = 366;

const MS_PER_DAY = 86_400_000;

/** Past this share of the limit the budget is spent, not merely close. */
const EXHAUSTED_SHARE = 0.995;

/**
 * `GET /api/config`.
 *
 * `../net-api` owns the net-server client and already covers `/api/summary`,
 * `/api/days` and the *write* half of `/api/config`, but it exports no reader for
 * this route. It is declared here rather than added there because that module
 * belongs to the `/internet` page's ticket; everything else this card needs —
 * the base URL, the error classes, the response types — is imported from it rather
 * than restated.
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
  return (await response.json()) as NetConfig;
}

const dayParts = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' });

/*
 * The three helpers below are deliberately duplicated from `routes/internet.tsx`
 * rather than shared: that file is another ticket's, and a shared home for them
 * would have to be `net-api.ts`, which is the same ticket's. They are small,
 * pure, and each carries the reasoning it encodes.
 */

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
 * Wire bytes attributed to a day inside the period.
 *
 * `/api/summary.totals` is corpus-wide and answers a different question, so the
 * period's figure is summed from the day buckets instead. `null` when the period
 * holds no known day at all — the honest answer there is "nothing recorded", where
 * a `0` would read as "nothing sent".
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
 * How much of the period has elapsed, as a fraction. The period is inclusive at both
 * ends and its days are the unit, so a period's first day is already partly spent.
 */
function periodElapsed(period: NetPeriod, today: string): number {
  const span = daySpanInclusive(period.start, period.end);
  const gone = daySpanInclusive(period.start, today < period.start ? period.start : today);
  return Math.min(1, Math.max(0, gone / span));
}

/**
 * The tone classes here mean *pace*, not fill — `.usage-meter.tone-*` is shared with
 * the allowance gauges above, where a nearly-full bar late in a window is fine and a
 * modest one early on is not. A budget period has that same shape, so the read is
 * spend measured against how much of the period has gone.
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
 * Config-driven: a limit *and* a reset day together make the period a budget cycle
 * worth metering, and this renders that meter. With either unset there is no budget
 * to be near, so it falls back to showing that the machine is using the internet at
 * all — daily totals over the last fortnight.
 *
 * Every net-server read is confined to this component. It is a different server on a
 * different port from the one the rest of the Overview reads, and it is frequently
 * not running at all, so none of its query state is allowed to reach the page: on any
 * failure this returns a single note and the meters above are untouched.
 */
export function InternetSpendCard() {
  // `/api/config` is the cheap route — three settings, no corpus scan — so which of
  // the two renderings applies is settled without waiting on `/api/summary`, which
  // recomputes the whole spend model at read time.
  const config = useQuery({ queryKey: ['net', 'config'], queryFn: getNetConfig, retry: false });
  const budgeted = config.data !== undefined && config.data.limitBytes !== null && config.data.resetDay !== null;

  // Only the budgeted branch needs the summary, and only for the period bounds: the
  // reset day the period is derived from lives on the server's clock, not this one.
  const summary = useQuery({
    queryKey: ['net', 'summary'],
    queryFn: getNetSummary,
    enabled: budgeted,
    retry: false,
  });

  const period = summary.data?.period ?? null;
  // The period is asked for by its own span rather than sliced out of the fallback's
  // fortnight: a reset day far enough behind puts the period's start outside 14 days,
  // and the headline must not quietly shrink to the window that happens to be fetched.
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
  // Nothing yet, or nothing worth a box: the card appears when its data lands rather
  // than reserving a slot the Overview would otherwise jump around.
  if (!config.data || !days.data) return null;

  if (budgeted && period && config.data.limitBytes !== null) {
    return <BudgetMeter limitBytes={config.data.limitBytes} period={period} days={days.data.days} />;
  }
  return <FallbackChart days={days.data.days} />;
}

/**
 * The one line a failed net-server read is allowed to put on this page, in the same
 * shape the usage meters use for their own degraded state.
 *
 * Unreachable is named specifically because it means something different from an
 * error: the collector is a timer inside that process (ADR 0072), so a server that is
 * down is not withholding figures — there are none for that interval.
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
 * Bytes spent this period against the configured limit, with the period it is a total
 * of named. The bar is decorative and the figures beside it carry the reading, which
 * is how the allowance gauges above handle the same thing.
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
 * No budget set, so there is no meter to draw — but the corpus still has something to
 * say, and a fortnight of daily totals says it without inventing a ceiling to measure
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
