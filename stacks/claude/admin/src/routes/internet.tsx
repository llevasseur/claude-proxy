import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute } from '@tanstack/react-router';
import { Globe } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceArea,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { QueryState } from '../components/QueryState';
import { Segmented, type SegmentedOption } from '../components/Segmented';
import { fmtAgeShort, fmtBytes, LOCAL_TZ_ABBR } from '../format';
import { isJsonNumber } from '../json';
import {
  getNetDays,
  getNetSummary,
  NET_API_BASE,
  NetApiError,
  type NetConfigInput,
  type NetDay,
  type NetGap,
  type NetPeriod,
  NetServerUnreachableError,
  type NetSummary,
  putNetConfig,
} from '../net-api';
import { rootRoute } from '../route-root';
import { useTransitionState } from '../useTransitionState';
import type { NavEntry } from './nav';

/** The windows `/api/days?window=` is asked for. Wider than the trend pages': a month is one budget period. */
const WINDOWS: readonly SegmentedOption<number>[] = [
  { value: 7, label: '7d' },
  { value: 14, label: '14d' },
  { value: 30, label: '30d' },
  { value: 90, label: '90d' },
];

/** Plot height, in px. */
const CHART_HEIGHT = 260;

/** The `<defs>` pattern the unknown bands are filled with. */
const HATCH_ID = 'net-unknown-hatch';

const MS_PER_DAY = 86_400_000;

/** The server clamps `window` here too; asking for more than a year is asking for nothing. */
const MAX_WINDOW = 366;

/**
 * Attribution is by process name over hourly samples, so it is approximate by
 * construction (decision internet-spend 004) — said on the page rather than only here.
 */
const AGENT_SHARE_CAVEAT =
  'Approximate: attributed by process name; hourly sampling does not see processes that start and finish between samples.';

const dayParts = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' });

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
 * One bar's day. `null` rather than `0` for a hole: recharts draws nothing for a null,
 * and a zero-height bar would be a claim that nothing was sent that day rather than that
 * nothing was recorded (decision internet-spend 002).
 */
interface ChartRow {
  date: string;
  download: number | null;
  upload: number | null;
  partial: boolean;
  known: boolean;
}

/** `/api/days` answers newest first; a chart reads left to right. */
function toRows(days: readonly NetDay[]): ChartRow[] {
  return [...days].reverse().map((day) => ({
    date: day.date,
    download: day.known ? day.bytesIn : null,
    upload: day.known ? day.bytesOut : null,
    partial: day.partial,
    known: day.known,
  }));
}

/** A gap/decrease/boot span, clamped to the days actually plotted. */
interface UnknownBand {
  key: string;
  x1: string;
  x2: string;
  kind: NetGap['kind'];
}

/** `YYYY-MM-DD` compares lexicographically in calendar order, which is what the clamping leans on. */
function toBands(gaps: readonly NetGap[], rows: readonly ChartRow[]): UnknownBand[] {
  const first = rows.at(0)?.date;
  const last = rows.at(-1)?.date;
  if (!first || !last) return [];
  const bands: UnknownBand[] = [];
  for (const gap of gaps) {
    const start = localDay(gap.start);
    const end = localDay(gap.end);
    if (end < first || start > last) continue;
    bands.push({
      key: `${gap.kind}-${gap.start}-${gap.end}`,
      x1: start < first ? first : start,
      x2: end > last ? last : end,
      kind: gap.kind,
    });
  }
  return bands;
}

/**
 * Wire bytes attributed to a day inside the period. `null` when the period holds no
 * known day at all — the honest answer there is "nothing recorded", and a `0` would read
 * as "nothing sent".
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
 * Wire-byte spend over the local network interfaces, from the net stack's own corpus.
 *
 * Everything here is read at request time from raw cumulative samples, so the figures
 * move when the config does. Two things it deliberately will not do: draw a bar for a day
 * it has no samples for, and count a gap's bytes against a day. Both would turn an
 * hourly sampler's sparseness into a confident zero.
 */
export function InternetPage() {
  const [windowDays, selectWindow, isSwitching] = useTransitionState(30);

  const summary = useQuery({ queryKey: ['net', 'summary'], queryFn: getNetSummary, retry: false });
  const chart = useQuery({
    queryKey: ['net', 'days', windowDays],
    queryFn: () => getNetDays(windowDays),
    retry: false,
  });

  const period = summary.data?.period ?? null;
  // The period is its own fetch rather than a slice of the chart's: a 7-day window does
  // not reach the start of the month, and the headline must not shrink with the picker.
  const periodWindow = period ? Math.min(MAX_WINDOW, daySpanInclusive(period.start, localDay(Date.now()))) : 1;
  const periodQuery = useQuery({
    queryKey: ['net', 'days', periodWindow],
    queryFn: () => getNetDays(periodWindow),
    enabled: period !== null,
    retry: false,
  });

  const unreachable = [summary.error, chart.error, periodQuery.error].find(
    (error) => error instanceof NetServerUnreachableError,
  );

  return (
    <section>
      <div className='pagehead'>
        <div className='pagehead-title'>
          <h1>Internet</h1>
          <div className='muted'>
            Wire bytes in and out of this machine, sampled hourly by net-server and bucketed into local days. Days it
            holds no samples for are left blank rather than drawn as zero.
          </div>
        </div>
        {!unreachable && (
          <Segmented
            options={WINDOWS}
            value={windowDays}
            onSelect={selectWindow}
            label='Day window'
            busy={isSwitching || chart.isFetching}
          />
        )}
      </div>

      {unreachable ? (
        <Unreachable />
      ) : (
        <>
          <Headline summary={summary.data ?? null} days={periodQuery.data?.days ?? null} />
          <CollectorStatus summary={summary.data ?? null} />

          <div className='card'>
            <div className='card-head'>
              <h2>Wire bytes by day</h2>
              <span className='range'>
                last {windowDays} days ({LOCAL_TZ_ABBR})
              </span>
            </div>
            <QueryState isLoading={chart.isLoading} error={chart.error} busy={isSwitching || chart.isFetching}>
              <DayChart data={chart.data?.days ?? []} gaps={chart.data?.gaps ?? []} />
            </QueryState>
          </div>

          <AgentShare summary={summary.data ?? null} isLoading={summary.isLoading} error={summary.error} />
          <BudgetEditor summary={summary.data ?? null} />
        </>
      )}
    </section>
  );
}

/**
 * net-server is where the collector lives (decision internet-spend 005), so it not
 * answering means no data exists for this interval — not that the figures are zero.
 */
function Unreachable() {
  return (
    <div className='card'>
      <p className='error state'>net-server unreachable at {NET_API_BASE}</p>
      <p className='muted'>
        Nothing on this page can be read while it is down, and nothing here is a zero — the collector is a timer inside
        that process, so no samples are being taken either. Start it with{' '}
        <code>pnpm --filter @agent-proxy/net-server start</code>, or point the dashboard elsewhere with{' '}
        <code>VITE_NET_SERVER_URL</code>.
      </p>
    </div>
  );
}

/**
 * The period's total, and the period it is a total of. A configured limit and reset day
 * make the period a budget cycle; an unset reset day means the calendar month, which is
 * what month-to-date is (decision internet-spend 003).
 */
function Headline({ summary, days }: { summary: NetSummary | null; days: readonly NetDay[] | null }) {
  if (!summary) return <div className='card muted state'>Loading…</div>;
  const period = summary.period;
  if (!period) {
    return (
      <div className='card'>
        <div className='stat-label'>This period</div>
        <div className='stat-value'>—</div>
        <div className='muted'>No samples recorded yet, so there is no period to total.</div>
      </div>
    );
  }

  const budgeted = summary.config.limitBytes !== null && summary.config.resetDay !== null;
  const total = days ? periodTotal(days, period) : null;
  const share = budgeted && total !== null && summary.config.limitBytes ? total / summary.config.limitBytes : null;

  return (
    <div className='card'>
      <div className='stat-label'>{budgeted ? 'This budget period' : 'Month to date'}</div>
      <div className='stat-value'>{total === null ? '—' : fmtBytes(total)}</div>
      <div className='stat-foot'>
        <span className='muted'>
          {period.start} → {period.end} ({LOCAL_TZ_ABBR})
        </span>
        {share !== null && (
          <span className='muted'>
            {(share * 100).toFixed(0)}% of {fmtBytes(summary.config.limitBytes ?? 0)}
          </span>
        )}
      </div>
      <div className='muted'>
        {total === null
          ? 'No day in this period has attributed samples yet.'
          : 'Summed over the days in the period that have samples.'}
        {summary.unattributedBytes > 0 &&
          ` A further ${fmtBytes(summary.unattributedBytes)} was measured inside gaps and belongs to no day.`}
      </div>
    </div>
  );
}

/** How much corpus there is, so a thin chart reads as thin sampling rather than as a quiet week. */
function CollectorStatus({ summary }: { summary: NetSummary | null }) {
  if (!summary) return null;
  const last = summary.lastSampleAt;
  const first = summary.coverage.firstSampleAt;
  return (
    <p className='muted state'>
      {last === null
        ? 'Collector has recorded no samples yet.'
        : `Last sample ${fmtAgeShort(new Date(last).toISOString())} ago`}
      {first !== null && ` · first sample ${localDay(first)} · ${summary.coverage.sampleCount} samples on record`}
    </p>
  );
}

/**
 * Upload and download stacked per day, with the spans the corpus cannot account for drawn
 * as hatched bands behind the bars rather than left to look like quiet days.
 */
function DayChart({ data, gaps }: { data: readonly NetDay[]; gaps: readonly NetGap[] }) {
  const rows = toRows(data);
  const bands = toBands(gaps, rows);
  const partials = rows.filter((row) => row.partial);
  const anyKnown = rows.some((row) => row.known);

  if (!anyKnown) {
    return (
      <div className='empty'>
        No day in this window has attributed samples. The collector runs only while net-server does, so an unattended
        machine records nothing.
      </div>
    );
  }

  return (
    <>
      <div style={{ height: CHART_HEIGHT }}>
        <ResponsiveContainer width='100%' height='100%'>
          {/* Off for the same reason the line chart turns it off: recharts otherwise
              marks the plot surface `tabIndex=0`. */}
          <BarChart accessibilityLayer={false} data={rows} margin={{ top: 6, right: 12, bottom: 2, left: 2 }}>
            <defs>
              <pattern id={HATCH_ID} width={6} height={6} patternTransform='rotate(45)' patternUnits='userSpaceOnUse'>
                <line x1='0' y='0' x2='0' y2='6' stroke='var(--muted)' strokeWidth={1.5} opacity={0.35} />
              </pattern>
            </defs>
            <CartesianGrid strokeDasharray='3 3' stroke='var(--border)' />
            <XAxis
              dataKey='date'
              tick={{ fontSize: 11, fill: 'var(--muted)' }}
              axisLine={false}
              tickLine={false}
              interval='preserveStartEnd'
              minTickGap={24}
              tickFormatter={(value: string) => value.slice(5)}
            />
            <YAxis
              width='auto'
              tick={{ fontSize: 11, fill: 'var(--muted)' }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(value) => (isJsonNumber(value) ? fmtBytes(value) : String(value))}
            />
            {/* Behind the bars: a band says the interval is unaccounted for, and a bar
                drawn over it is the part of that day that was measured. */}
            {bands.map((band) => (
              <ReferenceArea
                key={band.key}
                x1={band.x1}
                x2={band.x2}
                fill={`url(#${HATCH_ID})`}
                fillOpacity={1}
                stroke='none'
                ifOverflow='extendDomain'
              />
            ))}
            <Tooltip cursor={{ fill: 'var(--hover-veil)' }} content={<DayTooltip rows={rows} />} />
            <Bar dataKey='download' stackId='wire' name='Download' fill='var(--signal)' isAnimationActive={false} />
            <Bar dataKey='upload' stackId='wire' name='Upload' fill='var(--amber)' isAnimationActive={false} />
            {/* A day the bands only clip: the bar is real but incomplete, and the marker
                is what says so at a glance. */}
            {partials.map((row) => (
              <ReferenceDot
                key={`partial-${row.date}`}
                x={row.date}
                y={0}
                r={3}
                fill='var(--coral)'
                stroke='none'
                ifOverflow='extendDomain'
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ChartLegend partials={partials.length} bands={bands.length} />
    </>
  );
}

/** What the four marks on the plot mean — two series, one band, one marker. */
function ChartLegend({ partials, bands }: { partials: number; bands: number }) {
  return (
    <div
      className='muted'
      style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-7)', marginTop: 'var(--space-5)' }}>
      <span>
        <Swatch background='var(--signal)' /> Download
      </span>
      <span>
        <Swatch background='var(--amber)' /> Upload
      </span>
      <span>
        <Swatch background='repeating-linear-gradient(45deg, var(--muted) 0 1px, transparent 1px 4px)' /> Unknown span
        {bands > 0 ? ` (${bands})` : ''}
      </span>
      <span>
        <Swatch background='var(--coral)' /> Partial day{partials > 0 ? ` (${partials})` : ''}
      </span>
    </div>
  );
}

function Swatch({ background }: { background: string }) {
  return (
    <span
      aria-hidden='true'
      style={{
        display: 'inline-block',
        width: 'var(--space-6)',
        height: 'var(--space-6)',
        background,
        borderRadius: 'var(--radius-1)',
        verticalAlign: 'middle',
        marginRight: 'var(--space-3)',
      }}
    />
  );
}

interface TooltipEntry {
  dataKey?: string | number;
  value?: number;
}

/** Card-style tooltip matching the line chart's, plus what the day's own flags say. */
function DayTooltip({
  rows,
  active,
  label,
  payload,
}: {
  rows: readonly ChartRow[];
  active?: boolean;
  label?: string | number;
  payload?: TooltipEntry[];
}) {
  if (!active || !payload?.length) return null;
  const date = label == null ? '' : String(label);
  const row = rows.find((candidate) => candidate.date === date);
  const valueFor = (key: string): number | null => payload.find((entry) => entry.dataKey === key)?.value ?? null;
  const download = valueFor('download');
  const upload = valueFor('upload');

  return (
    <div className='charttip'>
      <div className='charttip-lead'>
        <div className='charttip-label'>{date}</div>
        {download !== null && (
          <div className='charttip-row'>
            <span className='charttip-dot' style={{ background: 'var(--signal)' }} />
            <span className='charttip-name'>Download</span>
            <span className='charttip-value'>{fmtBytes(download)}</span>
          </div>
        )}
        {upload !== null && (
          <div className='charttip-row'>
            <span className='charttip-dot' style={{ background: 'var(--amber)' }} />
            <span className='charttip-name'>Upload</span>
            <span className='charttip-value'>{fmtBytes(upload)}</span>
          </div>
        )}
        {download !== null && upload !== null && (
          <div className='charttip-row'>
            <span className='charttip-name'>Total</span>
            <span className='charttip-value'>{fmtBytes(download + upload)}</span>
          </div>
        )}
      </div>
      {row?.partial && <div className='charttip-hint'>Clipped by an unknown span — this day is incomplete.</div>}
      {row && !row.known && <div className='charttip-hint'>No samples attributed to this day.</div>}
    </div>
  );
}

/**
 * Which processes the measured bytes are attributed to. Empty is an ordinary answer, not
 * a failure: on macOS builds whose `nettop` emits no joinable process-and-interface row,
 * every interface-bearing series is stored under a synthetic identity and matches no agent
 * pattern, so the share is empty while the totals above are still exact.
 */
function AgentShare({ summary, isLoading, error }: { summary: NetSummary | null; isLoading: boolean; error: unknown }) {
  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Agent share</h2>
        <span className='range'>approximate</span>
      </div>
      <p className='muted'>{AGENT_SHARE_CAVEAT}</p>
      <QueryState isLoading={isLoading} error={error}>
        {!summary || summary.agentShare.length === 0 ? (
          <div className='empty'>
            No process-attributed bytes on record. The totals above are unaffected — attribution needs a sample row
            naming both a process and an interface, which this machine's <code>nettop</code> may never emit.
          </div>
        ) : (
          <div className='table-scroll'>
            <table className='table'>
              <thead>
                <tr>
                  <th>Process</th>
                  <th className='num'>Wire bytes</th>
                  <th className='num'>Share of attributed</th>
                </tr>
              </thead>
              <tbody>
                {summary.agentShare.map((entry) => (
                  <tr key={entry.name}>
                    <td>{entry.name}</td>
                    <td className='num'>{fmtBytes(entry.bytes)}</td>
                    <td className='num'>
                      {summary.attributedBytes > 0
                        ? `${((entry.bytes / summary.attributedBytes) * 100).toFixed(1)}%`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryState>
    </div>
  );
}

/** Blank clears the setting; anything else must parse as the integer the server will accept. */
function parseSetting(raw: string): { ok: true; value: number | null } | { ok: false } {
  const text = raw.trim();
  if (!text) return { ok: true, value: null };
  const value = Number(text);
  if (!Number.isSafeInteger(value)) return { ok: false };
  return { ok: true, value };
}

/**
 * The budget, edited in place. No optimism: a save refetches, so what the page shows is
 * always what the server stored — including a rejection, where it stored nothing.
 */
function BudgetEditor({ summary }: { summary: NetSummary | null }) {
  const queryClient = useQueryClient();
  // Held only while the reader is typing; cleared on a save so the fields re-derive from
  // the refetched config rather than from what was typed at it.
  const [draft, setDraft] = useState<{ limit: string; reset: string } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (input: NetConfigInput) => putNetConfig(input),
    onSuccess: () => {
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: ['net'] });
    },
  });

  if (!summary) return null;
  const config = summary.config;
  const limitField = draft?.limit ?? (config.limitBytes === null ? '' : String(config.limitBytes));
  const resetField = draft?.reset ?? (config.resetDay === null ? '' : String(config.resetDay));
  const edit = (next: Partial<{ limit: string; reset: string }>) =>
    setDraft({ limit: limitField, reset: resetField, ...next });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const limit = parseSetting(limitField);
    const reset = parseSetting(resetField);
    if (!limit.ok) return setLocalError('Limit must be a whole number of bytes, or blank to unset it.');
    if (!reset.ok) return setLocalError('Reset day must be a whole number, or blank to unset it.');
    setLocalError(null);
    save.mutate({ limitBytes: limit.value, resetDay: reset.value });
  };

  const serverError =
    save.error instanceof NetApiError
      ? save.error.message
      : save.error instanceof Error
        ? save.error.message
        : save.error
          ? String(save.error)
          : null;

  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Budget</h2>
        <span className='range'>{config.limitBytes === null || config.resetDay === null ? 'unset' : 'configured'}</span>
      </div>
      <p className='muted'>
        A limit and a reset day together make the headline a budget period. With either unset the headline is the
        calendar month to date.
      </p>
      <form onSubmit={submit} style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-7)', alignItems: 'end' }}>
        <label style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <span className='muted'>Limit (bytes)</span>
          <input
            type='text'
            inputMode='numeric'
            value={limitField}
            placeholder='unset'
            onChange={(event) => edit({ limit: event.target.value })}
          />
        </label>
        <label style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <span className='muted'>Reset day (1–31)</span>
          <input
            type='text'
            inputMode='numeric'
            value={resetField}
            placeholder='unset'
            onChange={(event) => edit({ reset: event.target.value })}
          />
        </label>
        <button type='submit' className='btn-primary' disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        {draft && (
          <button
            type='button'
            className='btn-quiet'
            onClick={() => {
              setDraft(null);
              setLocalError(null);
            }}>
            Discard
          </button>
        )}
      </form>
      {/* The server validates every field before it writes any of them, so a rejection
          means nothing was stored — worth saying beside the fields rather than as a toast. */}
      {(localError ?? serverError) && <p className='error state'>{localError ?? serverError}</p>}
    </div>
  );
}

/**
 * Wire-byte spend for this machine, over the net stack's own corpus. Its own server and
 * its own port — `VITE_NET_SERVER_URL`, defaulting to `http://localhost:8531`.
 */
export const route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/internet',
  component: InternetPage,
  staticData: { title: 'Internet' },
});

export const nav = {
  section: 'Device',
  to: '/internet',
  label: 'Internet',
  hint: 'wire bytes',
  exact: true,
  icon: Globe,
} as const satisfies NavEntry;
