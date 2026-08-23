import type { SectionShare } from '@agent-proxy/claude-core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createRoute, Link, useParams } from '@tanstack/react-router';
import { useMemo } from 'react';
import { getPromptDetail, type PromptDayUsage, type PromptDetailResponse } from '../api';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { HeaderHint } from '../components/HeaderHint';
import { QueryState } from '../components/QueryState';
import { DAY_WINDOWS, Segmented } from '../components/Segmented';
import { type SkeletonColumn, SkeletonTableCard } from '../components/Skeleton';
import { fmtBytes, fmtInt, fmtPct } from '../format';
import { REPORT_TZ_ABBR } from '../metrics';
import { rootRoute } from '../route-root';
import { useTransitionState } from '../useTransitionState';

const SECTION_COLUMNS: readonly SkeletonColumn[] = [
  {},
  { className: 'num' },
  { className: 'num' },
  { className: 'num' },
];
const USAGE_COLUMNS: readonly SkeletonColumn[] = [
  {},
  { className: 'num' },
  { className: 'num' },
  { className: 'num' },
  { className: 'num' },
];

type SortKey = 'heading' | 'level' | 'bytes' | 'share';
type SortDir = 'asc' | 'desc';

/** Direction applied the first time a column becomes the sort key. */
const DEFAULT_DIR = { heading: 'asc', level: 'asc', bytes: 'desc', share: 'desc' } satisfies Record<SortKey, SortDir>;

/**
 * Signed comparison for a column, ascending. `share` and `bytes` order
 * identically; they are separate keys so clicking one moves the arrow off the
 * other.
 */
function compare(a: SectionShare, b: SectionShare, key: SortKey): number {
  switch (key) {
    case 'heading':
      return a.heading.localeCompare(b.heading);
    case 'level':
      return a.level - b.level;
    default:
      return a.bytes - b.bytes;
  }
}

/** One system prompt from the mix: the sections its bytes sit in, and the days it ran. */
export function PromptDetailPage() {
  const { hash } = useParams({ from: '/trends/avg-system-prompt/$hash' });
  const [days, selectDays, isSwitching] = useTransitionState(30);
  const query = useQuery({
    queryKey: ['prompt-detail', hash, days],
    queryFn: () => getPromptDetail(hash, days),
    placeholderData: keepPreviousData,
  });
  const detail = query.data;
  const busy = isSwitching || query.isFetching;

  return (
    <section>
      <Breadcrumbs>
        <Link to='/trends' className='link'>
          Trends
        </Link>
        <Link to='/trends/$metric' params={{ metric: 'avg-system-prompt' }} className='link'>
          Avg system prompt
        </Link>
        <span className='crumb-current mono'>{hash.slice(0, 8)}</span>
      </Breadcrumbs>

      <div className='pagehead'>
        <div>
          <h1 className='mono'>{detail?.label ?? hash.slice(0, 8)}</h1>
          <div className='muted'>Every section of this system prompt, largest share of it first.</div>
        </div>
        <Segmented options={DAY_WINDOWS} value={days} onSelect={selectDays} label='Window' busy={busy} />
      </div>

      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        skeleton={<PromptDetailSkeleton days={days} />}
        busy={busy}>
        {detail && (
          <div className='grid wide-two'>
            <div className='card'>
              <div className='card-head'>
                <h2>What it is made of</h2>
                <span className='muted'>click a column to sort</span>
              </div>
              <Preface detail={detail} />
              {detail.outline ? (
                <SectionTable hash={hash} sections={detail.sections} />
              ) : (
                <div className='empty'>
                  No stored outline for this prompt — it ran before the proxy started recording them, so only its size
                  is known.
                </div>
              )}
            </div>

            <div className='card'>
              <h2>What it does to the mean</h2>
              {detail.usage.length === 0 ? (
                <div className='empty'>No request in the last {days} days sent this prompt.</div>
              ) : (
                <UsageTable usage={detail.usage} />
              )}
            </div>
          </div>
        )}
      </QueryState>
    </section>
  );
}

/** The prompt's own size, stated before the table that splits it up. */
function Preface({ detail }: { detail: PromptDetailResponse }) {
  const latest = detail.usage.at(-1);
  const models = detail.models.length > 0 ? detail.models.join(', ') : 'no model in this window';
  return (
    <p className='muted mix-note'>
      <strong>{fmtBytes(detail.outline?.bytes ?? Math.round(latest?.meanBytes ?? 0))}</strong> on the wire, sent by{' '}
      {models}
      {detail.outline && (
        <>
          {' '}
          across <strong>{fmtInt(detail.outline.blocks.length)}</strong> block
          {detail.outline.blocks.length === 1 ? '' : 's'} and <strong>{fmtInt(detail.sections.length)}</strong> sections
        </>
      )}
      .
      {latest && (
        <>
          {' '}
          On {latest.date} it was <strong>{fmtPct(latest.share * 100)}</strong> of the day's requests and{' '}
          <strong>{fmtBytes(Math.round(latest.contribution))}</strong> of that day's{' '}
          {fmtBytes(Math.round(latest.dayMeanBytes))} mean.
        </>
      )}
    </p>
  );
}

function SectionTable({ hash, sections }: { hash: string; sections: SectionShare[] }) {
  const [sort, setSort, isSorting] = useTransitionState<{ key: SortKey; dir: SortDir }>({ key: 'share', dir: 'desc' });
  const max = Math.max(1, ...sections.map((s) => s.bytes));

  const sorted = useMemo(() => {
    // The section route addresses the server's own ranking, so each row carries
    // it — sorting this table must not move a row's link.
    const rows = sections.map((s, rank) => ({ ...s, rank }));
    rows.sort((a, b) => {
      const diff = compare(a, b, sort.key);
      return sort.dir === 'asc' ? diff : -diff;
    });
    return rows;
  }, [sections, sort]);

  const onSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: DEFAULT_DIR[key] },
    );

  return (
    <div className='table-scroll'>
      <table className={isSorting ? 'table is-stale' : 'table'} aria-busy={isSorting || undefined}>
        <thead>
          <tr>
            <SortHeader
              label='Section'
              sortKey='heading'
              sort={sort}
              onSort={onSort}
              hint="A heading in this system prompt's stored outline, indented by its depth. Click it to read that section."
            />
            <SortHeader
              label='Depth'
              sortKey='level'
              sort={sort}
              onSort={onSort}
              className='num'
              hint='The heading level — H1 to H6. Text sitting before the first heading has no level and reads as —.'
            />
            <SortHeader
              label='Size'
              sortKey='bytes'
              sort={sort}
              onSort={onSort}
              className='num'
              hint='Bytes of the section, its heading and body together.'
            />
            <SortHeader
              label='Share'
              sortKey='share'
              sort={sort}
              onSort={onSort}
              className='num'
              hint="The section's bytes as a fraction of the whole prompt. The bar is drawn against the largest section."
            />
          </tr>
        </thead>
        <tbody>
          {sorted.map((s) => (
            <tr key={s.heading}>
              <td>
                <Link
                  to='/trends/avg-system-prompt/$hash/section/$index'
                  params={{ hash, index: String(s.rank) }}
                  className='link section-heading'
                  style={{ paddingLeft: `${Math.max(0, s.level - 1) * 12}px` }}>
                  {s.heading}
                </Link>
              </td>
              <td className='num muted'>{s.level === 0 ? '—' : `H${s.level}`}</td>
              <td className='num'>{fmtBytes(s.bytes)}</td>
              <td className='num share-cell'>
                <div className='rowbar' style={{ width: `${(s.bytes / max) * 100}%` }} />
                <span>{fmtPct(s.share * 100, 1)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Every day of the window this prompt ran, newest first. */
function UsageTable({ usage }: { usage: PromptDayUsage[] }) {
  return (
    <div className='table-scroll'>
      <table className='table'>
        <thead>
          <tr>
            <th>
              Date ({REPORT_TZ_ABBR})
              <HeaderHint text={`The report day, bucketed in ${REPORT_TZ_ABBR}. Newest first.`} />
            </th>
            <th className='num'>
              Requests
              <HeaderHint text='Captured requests that carried this system prompt that day.' />
            </th>
            <th className='num'>
              Share
              <HeaderHint text="Those requests as a fraction of every request that day — how much of the day's traffic this prompt accounted for." />
            </th>
            <th className='num'>
              Size
              <HeaderHint text="This prompt's mean system-prompt bytes over that day's requests." />
            </th>
            <th className='num'>
              Of the mean
              <HeaderHint text="Share × size: the bytes this prompt contributes to the day's mean system prompt, against that whole mean." />
            </th>
          </tr>
        </thead>
        <tbody>
          {[...usage].reverse().map((u) => (
            <tr key={u.date}>
              <td>{u.date}</td>
              <td className='num'>{fmtInt(u.requests)}</td>
              <td className='num'>{fmtPct(u.share * 100)}</td>
              <td className='num'>{fmtBytes(Math.round(u.meanBytes))}</td>
              <td className='num'>
                {fmtBytes(Math.round(u.contribution))}{' '}
                <span className='muted'>of {fmtBytes(Math.round(u.dayMeanBytes))}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
  hint,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  className?: string;
  hint?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      className={['sortable', className].filter(Boolean).join(' ')}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={() => onSort(sortKey)}>
      {label}
      {active && <span className='sort-arrow'>{sort.dir === 'asc' ? '▲' : '▼'}</span>}
      {hint && <HeaderHint text={hint} />}
    </th>
  );
}

/** Mirrors the loaded two-up grid; one usage row per day of the window. */
function PromptDetailSkeleton({ days }: { days: number }) {
  return (
    <div className='grid wide-two'>
      <SkeletonTableCard title='What it is made of' columns={SECTION_COLUMNS} rows={12} />
      <SkeletonTableCard title='What it does to the mean' columns={USAGE_COLUMNS} rows={days} />
    </div>
  );
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  // Nested under the metric it drills into. The param is the prompt's content
  // hash, which is also its cohort key on that page.
  path: '/trends/avg-system-prompt/$hash',
  component: PromptDetailPage,
  staticData: { title: 'System prompt' },
});
