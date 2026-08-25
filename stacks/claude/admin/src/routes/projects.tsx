import { useQuery } from '@tanstack/react-query';
import { createRoute, Link, useNavigate } from '@tanstack/react-router';
import { FolderGit2 } from 'lucide-react';
import { useMemo } from 'react';
import type { ProjectSummary } from '../api';
import { getProjects } from '../api';
import { QueryState } from '../components/QueryState';
import { Skeleton, type SkeletonColumn, SkeletonTable } from '../components/Skeleton';
import { fmtInt } from '../format';
import { rootRoute } from '../route-root';
import { useTransitionState } from '../useTransitionState';
import type { NavEntry } from './nav';

/** Project name, its memory count, then the share bar. */
const PROJECT_COLUMNS: readonly SkeletonColumn[] = [{ cell: '62%' }, { className: 'num' }, { className: 'bar-col' }];

export function ProjectsPage() {
  const query = useQuery({ queryKey: ['projects'], queryFn: getProjects });
  const projects = query.data?.projects;

  return (
    <section>
      <div className='pagehead'>
        <h1>Projects</h1>
        <span className='muted'>Claude Code projects with saved memories</span>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<ProjectsSkeleton />}>
        {!projects || projects.length === 0 ? (
          <div className='card empty'>No projects with memories found.</div>
        ) : (
          <>
            <div className='muted' style={{ marginBottom: '0.75rem', wordBreak: 'break-all' }}>
              {query.data?.meta.projectsDir}
            </div>
            <ProjectsTable projects={projects} />
          </>
        )}
      </QueryState>
    </section>
  );
}

/** The projects directory line, then the table. */
function ProjectsSkeleton() {
  return (
    <>
      <div className='muted' style={{ marginBottom: '0.75rem' }} aria-hidden>
        <Skeleton w='26rem' />
      </div>
      <div className='card'>
        <div className='card-head'>
          <Skeleton w='22%' h='0.95em' />
          <Skeleton w='30%' />
        </div>
        <SkeletonTable columns={PROJECT_COLUMNS} rows={9} />
      </div>
    </>
  );
}

type SortKey = 'name' | 'memoryCount';
type SortDir = 'asc' | 'desc';

/** Direction applied the first time a column becomes the sort key. */
const DEFAULT_DIR = {
  name: 'asc',
  memoryCount: 'desc',
} satisfies Record<SortKey, SortDir>;

/** Signed comparison for a column, ascending. */
function compare(a: ProjectSummary, b: ProjectSummary, key: SortKey): number {
  switch (key) {
    case 'name':
      return a.name.localeCompare(b.name);
    default:
      return a.memoryCount - b.memoryCount;
  }
}

function ProjectsTable({ projects }: { projects: ProjectSummary[] }) {
  const navigate = useNavigate();
  const max = Math.max(1, ...projects.map((p) => p.memoryCount));
  const [sort, setSort, isSorting] = useTransitionState<{ key: SortKey; dir: SortDir }>({
    key: 'memoryCount',
    dir: 'desc',
  });

  const sorted = useMemo(() => {
    const rows = [...projects];
    rows.sort((a, b) => {
      const diff = compare(a, b, sort.key);
      return sort.dir === 'asc' ? diff : -diff;
    });
    return rows;
  }, [projects, sort]);

  const onSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: DEFAULT_DIR[key] },
    );

  return (
    <div className='card'>
      <div className='card-head'>
        <h2>
          {projects.length} project{projects.length === 1 ? '' : 's'}
        </h2>
        <span className='muted'>click a column to sort · click a row for its memories</span>
      </div>
      <div className='table-scroll'>
        <table className={isSorting ? 'table is-stale' : 'table'} aria-busy={isSorting || undefined}>
          <thead>
            <tr>
              <SortHeader label='Project' sortKey='name' sort={sort} onSort={onSort} />
              <SortHeader label='Memories' sortKey='memoryCount' sort={sort} onSort={onSort} className='num' />
              <th className='bar-col'>&nbsp;</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => (
              <tr
                key={p.name}
                className='clickable'
                onClick={() => navigate({ to: '/projects/$project', params: { project: p.name } })}>
                <td>
                  <Link
                    to='/projects/$project'
                    params={{ project: p.name }}
                    className='link mono-break'
                    onClick={(e) => e.stopPropagation()}>
                    {p.name}
                  </Link>
                </td>
                <td className='num'>{fmtInt(p.memoryCount)}</td>
                <td className='bar-col'>
                  <div className='rowbar' style={{ width: `${(p.memoryCount / max) * 100}%` }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      className={['sortable', className].filter(Boolean).join(' ')}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={() => onSort(sortKey)}>
      {label}
      {active && <span className='sort-arrow'>{sort.dir === 'asc' ? '▲' : '▼'}</span>}
    </th>
  );
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects',
  component: ProjectsPage,
  staticData: { title: 'Projects' },
});

export const nav = {
  section: 'Sessions',
  to: '/projects',
  label: 'Projects',
  hint: 'memory',
  exact: false,
  icon: FolderGit2,
} as const satisfies NavEntry;
